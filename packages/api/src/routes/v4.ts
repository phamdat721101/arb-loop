/**
 * /v4 — Private-payment HTTP surface (T5/PRD-B).
 *
 * One route file, six endpoints:
 *   /v4/billing/balance/:user      — encrypted balance handle + free-preview state
 *   /v4/billing/top-up-info        — calldata-ready contract metadata
 *   /v4/billing/top-up             — build silent-sign calldata for Privy
 *   /v4/settlement/:id             — single-settlement handles (encrypted)
 *   /v4/settlement/user/:address   — settlement-id list for a user
 *   /v4/admin/stats                — 14 KPI metrics (filled by T7)
 *
 * Auth: parent `/v4` mount uses the same wallet auth as /v2 + /v3.
 * Mounted only when FEATURE_FHE_PAY=true; flag-off → 404 (byte-identical v3 behavior).
 *
 * SOLID:
 *   - SRP: this file owns the /v4 surface; nothing else.
 *   - DIP: contract addresses are read from env; ABIs from @fhe-ai-context/shared.
 *   - I3: no copy-paste — re-uses paidCallLedger, observability, auth from siblings.
 */

import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import * as ledger from '../services/paidCallLedger';
import { logger } from '../lib';
import { refreshKpiGauges } from '../lib/observability';
import { pool } from '../db';
import { relayerStats } from '../services/chainOpsQueue';
import type { AuthRequest } from '../middleware/auth';

// Local ABI fragments — inlined to avoid a workspace cross-package dep just for
// three function fragments. Source of truth: packages/shared/src/contracts.ts.
const AgentBillingABI = [
  'function topUp(address agent, bytes inAmount) external',
  'function chargeFee(address user, bytes inFee) external returns (bool)',
  'function getBalanceHandle(address user, address agent) view returns (bytes32)',
] as const;
const SettlementLedgerABI = [
  'function recordSettlement(address payer, address payee, bytes inAmount, bytes inReasonHash) external returns (bytes32)',
  'function getSettlementHandles(bytes32 id) view returns (tuple(bytes32 amount, bytes32 reasonHash, address payer, address payee, uint256 timestamp))',
  'function getUserSettlementCount(address user) view returns (uint256)',
  'function getUserSettlementId(address user, uint256 index) view returns (bytes32)',
] as const;

const v4 = Router();

// ── Lazy provider singleton (one per process) ──────────────────────────────
let _provider: ethers.JsonRpcProvider | null = null;
function getProvider(): ethers.JsonRpcProvider {
  if (_provider) return _provider;
  const rpc = process.env.ARBITRUM_SEPOLIA_RPC ?? 'https://sepolia-rollup.arbitrum.io/rpc';
  _provider = new ethers.JsonRpcProvider(rpc);
  return _provider;
}

// ── Boot-time env validation (fail fast) ───────────────────────────────────
function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`/v4 requires ${name}; set it in .env after running deploy:fhe-pay`);
  return v;
}

// Validated lazily (per-handler) so tests don't need real addresses.
function billingContract() {
  return new ethers.Contract(envOrThrow('AGENT_BILLING_ADDRESS'), AgentBillingABI, getProvider());
}
function ledgerContract() {
  return new ethers.Contract(envOrThrow('SETTLEMENT_LEDGER_ADDRESS'), SettlementLedgerABI, getProvider());
}

// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /v4/billing/balance/:user
 * Returns encrypted balance handle + freemium state per (user × agent).
 * Frontend's useEncryptedBalance hook decrypts client-side via permit.
 */
v4.get('/billing/balance/:user', async (req: AuthRequest, res: Response) => {
  const user = req.params.user.toLowerCase();
  if (!ethers.isAddress(user)) return res.status(400).json({ error: 'invalid address' });

  // Optional ?agent=<address> — when provided, returns the per-(user,agent) handle.
  const agentAddr = (req.query.agent as string | undefined)?.toLowerCase();
  let balanceHandle = ethers.ZeroHash;
  if (agentAddr && ethers.isAddress(agentAddr)) {
    try {
      balanceHandle = await billingContract().getBalanceHandle(user, agentAddr);
    } catch (e) {
      logger.warn({ err: (e as Error).message, user, agentAddr }, 'v4:balance:rpc_error');
    }
  }

  // Freemium state — ?brain_id=<uuid> required for accurate count.
  // For the buyer's own agents view, the frontend asks per-brain.
  const brainId = req.query.brain_id as string | undefined;
  const freeCallsRemaining: Record<string, number> = {};
  if (brainId) {
    freeCallsRemaining[brainId] = await ledger.checkFreePreview(user, brainId);
  }

  res.json({
    user,
    agent: agentAddr ?? null,
    balanceHandle,
    freeCallsRemaining,
    freePreviewLimit: ledger.FREE_PREVIEW_LIMIT,
  });
});

/**
 * GET /v4/billing/top-up-info
 * Static metadata for building a top-up call client-side.
 */
v4.get('/billing/top-up-info', (_req: Request, res: Response) => {
  res.json({
    wrappedUsdc: process.env.WRAPPED_USDC_ADDRESS ?? null,
    agentBilling: process.env.AGENT_BILLING_ADDRESS ?? null,
    settlementLedger: process.env.SETTLEMENT_LEDGER_ADDRESS ?? null,
    network: process.env.X402_NETWORK ?? 'arbitrum-sepolia',
    chainId: 421614,
    decimals: 6, // Circle USDC
    suggestedTopUpsUsd: ['1', '5', '20'],
  });
});

/**
 * POST /v4/billing/top-up
 * Returns ABI-encoded calldata for AgentBilling.topUp so Privy can silent-sign.
 * Body: { agent: address, encryptedAmount: bytes }
 *
 * The encrypted amount is produced client-side via cofhejs; server only assembles
 * the calldata, never sees the plaintext amount.
 */
v4.post('/billing/top-up', async (req: AuthRequest, res: Response) => {
  const { agent, encryptedAmount } = req.body ?? {};
  if (!ethers.isAddress(agent)) return res.status(400).json({ error: 'invalid agent address' });
  if (!encryptedAmount || typeof encryptedAmount !== 'string' || !encryptedAmount.startsWith('0x')) {
    return res.status(400).json({ error: 'encryptedAmount required (0x-prefixed hex)' });
  }

  const iface = new ethers.Interface(AgentBillingABI as readonly string[]);
  const calldata = iface.encodeFunctionData('topUp', [agent, encryptedAmount]);
  res.json({
    to: envOrThrow('AGENT_BILLING_ADDRESS'),
    calldata,
    chainId: 421614,
  });
});

/**
 * GET /v4/settlement/:id
 * Returns the encrypted handles + plaintext metadata for a single settlement.
 * Only payer + payee can decrypt the handles via their permits.
 */
v4.get('/settlement/:id', async (req: AuthRequest, res: Response) => {
  const id = req.params.id;
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) return res.status(400).json({ error: 'invalid id' });

  try {
    const h = await ledgerContract().getSettlementHandles(id);
    res.json({
      id,
      amount: h.amount,
      reasonHash: h.reasonHash,
      payer: h.payer,
      payee: h.payee,
      timestamp: Number(h.timestamp),
    });
  } catch (e) {
    logger.warn({ err: (e as Error).message, id }, 'v4:settlement:rpc_error');
    res.status(404).json({ error: 'settlement not found' });
  }
});

/**
 * GET /v4/settlement/user/:address
 * Returns the list of settlement IDs for a user (payer or payee).
 */
v4.get('/settlement/user/:address', async (req: AuthRequest, res: Response) => {
  const address = req.params.address.toLowerCase();
  if (!ethers.isAddress(address)) return res.status(400).json({ error: 'invalid address' });

  try {
    const ledgerC = ledgerContract();
    const count: bigint = await ledgerC.getUserSettlementCount(address);
    const ids: string[] = [];
    const max = Math.min(Number(count), 100); // cap for paginated future
    for (let i = 0; i < max; i++) {
      ids.push(await ledgerC.getUserSettlementId(address, i));
    }
    res.json({ address, count: Number(count), ids });
  } catch (e) {
    logger.warn({ err: (e as Error).message, address }, 'v4:settlement:user:rpc_error');
    res.status(503).json({ error: 'rpc_unavailable' });
  }
});

// /v4/admin/stats — 14 KPI metrics (T7/PRD-D).
//
// Auth: basic-auth via ADMIN_USER:ADMIN_PASS env vars. Frontend admin UI
// (v1.1) will mount it; daily Slack snapshot uses curl with -u.
v4.get('/admin/stats', async (req: Request, res: Response) => {
  // Basic-auth — single line, no library dep.
  const expected = process.env.ADMIN_USER && process.env.ADMIN_PASS
    ? 'Basic ' + Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASS}`).toString('base64')
    : null;
  if (!expected || req.headers.authorization !== expected) {
    res.set('WWW-Authenticate', 'Basic realm="openx-admin"');
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const values = await refreshKpiGauges(pool);
    const relayer = await collectRelayerStats();
    res.json({
      generated_at: new Date().toISOString(),
      feature_fhe_pay: process.env.FEATURE_FHE_PAY === 'true',
      feature_gasless_onboard: process.env.FEATURE_GASLESS_ONBOARD === 'true',
      free_preview_limit: ledger.FREE_PREVIEW_LIMIT,
      metrics: values,
      relayer,
    });
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'v4:admin:stats:failed');
    res.status(503).json({ error: 'kpi_refresh_failed' });
  }
});

// PRD-19 — relayer health snapshot. Cached 60s so a tight admin-poll
// loop doesn't hammer the RPC. Returns balance in ETH + queue depth +
// failure counters + p50 confirmation latency.
let _relayerCache: { ts: number; data: Awaited<ReturnType<typeof buildRelayerStats>> } | null = null;
async function collectRelayerStats() {
  if (_relayerCache && Date.now() - _relayerCache.ts < 60_000) return _relayerCache.data;
  const data = await buildRelayerStats();
  _relayerCache = { ts: Date.now(), data };
  return data;
}

async function buildRelayerStats() {
  const queue = await relayerStats(pool);
  // Fallback chain mirrors packages/worker/src/jobs/chain-relayer.ts so the
  // stats endpoint reports the same wallet the relayer actually uses.
  const key =
    process.env.RELAYER_PRIVATE_KEY ||
    process.env.DEPLOYER_PRIVATE_KEY ||
    process.env.PRIVATE_KEY;
  let address: string | null = null;
  let balanceEth = 0;
  if (key) {
    try {
      const wallet = new ethers.Wallet(key);
      address = wallet.address;
      const bal = await getProvider().getBalance(address);
      balanceEth = Number(ethers.formatEther(bal));
    } catch {
      /* leave address/balanceEth at defaults */
    }
  }
  return {
    address,
    balance_eth: balanceEth,
    balance_low: balanceEth > 0 && balanceEth < 0.005,
    pending: queue.pending,
    claimed: queue.claimed,
    failed_24h: queue.failed_24h,
    p50_latency_sec: queue.p50_latency_sec,
  };
}

export default v4;
