import { ethers } from 'ethers';
import type { Pool, PoolClient } from 'pg';
import { pool } from '../db';
import { logger } from '../lib';

// V2 ABI: BrainKeyVaultV2 carries per-brain access, not user-level authorization.
//   - hasAccess(brainId, subscriber)  — the per-brain gate enforced at routes/v2.ts
//   - brainOwner(brainId)              — used to assert seller identity when needed
// User-level "is the user reachable on-chain?" reduces to "is the vault deployed?"
// (eth_getCode), since V2 has no global authorization flag — the SDK permit signature
// is itself the user's intent, and per-brain access is checked separately.
const VAULT_ABI = [
  'function brainOwner(uint256 brainId) view returns (address)',
  'function hasAccess(uint256 brainId, address subscriber) view returns (bool)',
];
let _contract: ethers.Contract | null = null;

function getVault() {
  if (!_contract) {
    const rpc = process.env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
    const provider = new ethers.JsonRpcProvider(rpc);
    _contract = new ethers.Contract(process.env.BRAIN_KEY_VAULT_ADDRESS!, VAULT_ABI, provider);
  }
  return _contract;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type PermitReason =
  | 'cache_hit'
  | 'onchain_authorized'
  | 'never_authorized'
  | 'permit_revoked'
  | 'cache_expired'
  | 'config_unavailable'
  | 'rpc_error';

export type VerifyReason =
  | 'parse_failed'
  | 'issuer_mismatch'
  | 'recipient_mismatch'
  | 'contract_mismatch'
  | 'expired'
  | 'sdk_unavailable'
  | 'scope_mismatch';

export type ImportRejectReason = VerifyReason | 'onchain_unauthorized' | 'config_unavailable';

export interface PermitStatus { authorized: boolean; reason: PermitReason }

/** PRD-18 — onboard permits encode a single-use id inside `name` as
 *  `openx-onboard:<jti>`. `verifyPermit()` parses it (best-effort; null when
 *  absent) so middleware/services can enforce scope without a second decode. */
export const ONBOARD_SCOPE_PREFIX = 'openx-onboard:';

export interface VerifiedPermit {
  issuer: string;
  recipient: string;
  contract: string;
  expiration: number;
  /** Raw `name` field from the permit blob (null when the SDK omits it). */
  name: string | null;
  /** Parsed jti when `name` starts with `openx-onboard:`; null otherwise. */
  jti: string | null;
}

export type VerifyResult =
  | { valid: true; permit: VerifiedPermit }
  | { valid: false; reason: VerifyReason };

// ─── Verify permit blob (pure validation, no DB) ────────────────────────────
//
// `expectedIssuer` is OPTIONAL (PRD-18). When passed, the call enforces an
// issuer match (legacy callers — `/permit/import` — still bind issuer to the
// authenticated user). When omitted, the permit's own `issuer` is taken as
// authoritative — used by the auth middleware where the permit IS the proof
// of identity (no out-of-band wallet header).

export async function verifyPermit(
  serialized: string,
  expectedIssuer?: string,
): Promise<VerifyResult> {
  const platform = process.env.PLATFORM_WALLET?.toLowerCase();
  const contract = process.env.BRAIN_KEY_VAULT_ADDRESS?.toLowerCase();
  if (!platform || !contract) return { valid: false, reason: 'sdk_unavailable' };

  try {
    const { getCofheClient } = await import('./client');
    const cofhe = await getCofheClient();
    const permit = await cofhe.permits.importShared(serialized);

    const issuer = (permit.issuer ?? permit.owner ?? '').toLowerCase();
    const recipient = (permit.recipient ?? permit.allowed ?? platform).toLowerCase();
    const permitContract = (permit.contract ?? permit.contractAddress ?? '').toLowerCase();
    const expiration: number = permit.expiration ?? permit.exp ?? Infinity;
    const name: string | null = typeof permit.name === 'string' ? permit.name : null;
    const jti =
      name && name.startsWith(ONBOARD_SCOPE_PREFIX)
        ? name.slice(ONBOARD_SCOPE_PREFIX.length) || null
        : null;

    if (expectedIssuer && issuer !== expectedIssuer.toLowerCase()) {
      return { valid: false, reason: 'issuer_mismatch' };
    }
    if (!issuer) return { valid: false, reason: 'issuer_mismatch' };
    // PRD-18 §B fix — onboard permits use the BrainKeyVault contract address
    // as the recipient (the seller and platform may share the same wallet
    // during dev testing; CoFHE rejects createSharing when issuer===recipient,
    // so we route onboard permits through the contract address instead).
    // Legacy full-scope permits still bind to PLATFORM_WALLET.
    const expectedRecipient = jti ? contract : platform;
    if (recipient !== expectedRecipient) return { valid: false, reason: 'recipient_mismatch' };
    if (permitContract && permitContract !== contract) return { valid: false, reason: 'contract_mismatch' };
    if (expiration !== Infinity && expiration < Date.now() / 1000) return { valid: false, reason: 'expired' };

    return {
      valid: true,
      permit: { issuer, recipient, contract: permitContract || contract, expiration, name, jti },
    };
  } catch {
    return { valid: false, reason: 'parse_failed' };
  }
}

// ─── On-chain confirmation ──────────────────────────────────────────────────
// V2 has no user-level authorization flag. The on-chain truth lives in
// hasAccess(brainId, subscriber) and is enforced per-route (see isBrainGranted
// + routes/v2.ts). At user-level, all we can verify cheaply is that the vault
// contract is actually deployed at the configured address (proves RPC + addr
// are sane). The SDK permit blob (verified upstream) carries the user's intent.
const _vaultDeployedCache = new Map<string, { deployed: boolean; ts: number }>();

export async function confirmOnChain(userAddress: string): Promise<{ authorized: boolean; error?: string }> {
  const platform = process.env.PLATFORM_WALLET;
  const vaultAddr = process.env.BRAIN_KEY_VAULT_ADDRESS;
  if (!platform || !vaultAddr) return { authorized: false, error: 'config_missing' };

  const cacheKey = vaultAddr.toLowerCase();
  const cached = _vaultDeployedCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60 * 60_000) {
    return cached.deployed ? { authorized: true } : { authorized: false, error: 'rpc_unavailable' };
  }

  try {
    const rpc = process.env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
    const provider = new ethers.JsonRpcProvider(rpc);
    const code = await provider.getCode(vaultAddr);
    const deployed = code !== '0x' && code.length > 2;
    _vaultDeployedCache.set(cacheKey, { deployed, ts: Date.now() });
    logger.info({ user: userAddress, deployed }, 'onchain:vaultReachable');
    return deployed ? { authorized: true } : { authorized: false, error: 'rpc_unavailable' };
  } catch (e: any) {
    logger.warn({ user: userAddress, err: e.message }, 'onchain:vaultReachable:rpc_error');
    return { authorized: false, error: 'rpc_unavailable' };
  }
}

// ─── Per-brain grant check ──────────────────────────────────────────────────

const _brainGrantCache = new Map<string, { authorized: boolean; ts: number }>();

export async function isBrainGranted(brainId: number | string): Promise<boolean> {
  const platform = process.env.PLATFORM_WALLET;
  if (!platform || !process.env.BRAIN_KEY_VAULT_ADDRESS) return false;
  const key = `${brainId}:${platform}`;
  const cached = _brainGrantCache.get(key);
  if (cached && Date.now() - cached.ts < 5 * 60_000) return cached.authorized;
  try {
    const granted: boolean = await getVault().hasAccess(BigInt(brainId), ethers.getAddress(platform));
    _brainGrantCache.set(key, { authorized: granted, ts: Date.now() });
    return granted;
  } catch {
    return cached?.authorized ?? false;
  }
}

// ─── Strict import (SDK-verified + on-chain confirmed) ──────────────────────

export async function importPermit(
  userAddress: string,
  serialized: string,
): Promise<{ ok: true; expiresAt: string } | { ok: false; reason: ImportRejectReason }> {
  const verify = await verifyPermit(serialized, userAddress);
  if (verify.valid === false) return { ok: false, reason: verify.reason };

  const onchain = await confirmOnChain(userAddress);
  if (!onchain.authorized) return { ok: false, reason: onchain.error === 'config_missing' ? 'config_unavailable' : 'onchain_unauthorized' };

  const addr = userAddress.toLowerCase();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString(); // 1h flat TTL
  await pool.query(
    `INSERT INTO permits (user_address, serialized_permit, recipient, expires_at, permit_kind)
     VALUES ($1, $2, $3, $4, 'sdk')
     ON CONFLICT (user_address) DO UPDATE SET serialized_permit = $2, recipient = $3, expires_at = $4, permit_kind = 'sdk', created_at = NOW()`,
    [addr, serialized.slice(0, 200), verify.permit.recipient, expiresAt],
  );
  logger.info({ user: addr }, 'permit:imported:sdk');
  return { ok: true, expiresAt };
}

// ─── Revoke ─────────────────────────────────────────────────────────────────

export async function revokePermit(userAddress: string): Promise<void> {
  await pool.query(`DELETE FROM permits WHERE user_address = $1`, [userAddress.toLowerCase()]);
}

// ─── Cache-based check (perf only — security enforced at insert) ────────────

export async function hasPermit(
  userAddress: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<PermitStatus> {
  const addr = userAddress.toLowerCase();

  if (!opts.forceRefresh) {
    const { rows } = await pool.query(
      `SELECT 1 FROM permits WHERE user_address = $1 AND created_at > NOW() - INTERVAL '1 hour' LIMIT 1`,
      [addr],
    );
    if (rows.length > 0) return { authorized: true, reason: 'cache_hit' };
  }

  const onchain = await confirmOnChain(userAddress);
  if (onchain.error === 'config_missing') return { authorized: false, reason: 'config_unavailable' };
  if (onchain.error) return { authorized: false, reason: 'rpc_error' };

  if (onchain.authorized) {
    await pool.query(
      `INSERT INTO permits (user_address, serialized_permit, permit_kind)
       VALUES ($1, 'on-chain-refresh', 'sdk')
       ON CONFLICT (user_address) DO UPDATE SET created_at = NOW()`,
      [addr],
    );
    return { authorized: true, reason: 'onchain_authorized' };
  }

  // On-chain says no — if we had a stale cache row, delete it.
  await pool.query(`DELETE FROM permits WHERE user_address = $1`, [addr]);
  return { authorized: false, reason: opts.forceRefresh ? 'permit_revoked' : 'never_authorized' };
}

// ─── Single-use onboard permit consumption (PRD-18) ─────────────────────────
//
// Atomic INSERT into `onboard_permits_spent` (migration 025). Accepts a Pool
// OR a PoolClient so the call lives inside an existing transaction (the
// seller publish path) — single-use enforcement is at the DB layer, not in
// middleware, which removes any race window between the verify and the
// publish INSERTs.
//
//   - Returns { ok: true }  when the row was inserted (first use).
//   - Returns { ok: false } when the jti is already spent (replay).
//
// Caller maps `ok:false` to HTTP 409.

export async function consumeOnboardJti(
  client: Pool | PoolClient,
  jti: string,
  walletAddress: string,
  expiresAtSec: number,
): Promise<{ ok: boolean }> {
  if (!jti) return { ok: false };
  const r = await client.query(
    `INSERT INTO onboard_permits_spent (jti, wallet_address, expires_at)
     VALUES ($1, $2, to_timestamp($3))
     ON CONFLICT (jti) DO NOTHING
     RETURNING jti`,
    [jti, walletAddress.toLowerCase(), expiresAtSec],
  );
  return { ok: (r.rowCount ?? 0) === 1 };
}
