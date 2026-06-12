import { createPublicClient, http, type WalletClient } from 'viem';
import { PermitUtils } from '@cofhe/sdk/permits';
import { arbitrumSepolia as viemArbitrumSepolia, arbitrum as viemArbitrum } from 'viem/chains';
import type { SupportedChain } from '../client/chains';
import { getCofheClient } from '../client/cofheClient';

export interface PermitOptions {
  contractAddress: `0x${string}`;
  agentAddress: `0x${string}`;
}

export async function createPermit(
  options: PermitOptions,
  chain: SupportedChain,
  signer: WalletClient,
): Promise<string> {
  const client = getCofheClient();

  const account = signer.account?.address
    ?? (await signer.getAddresses())[0];
  if (!account) throw new Error('No account found in wallet client');

  const viemChain = chain.id === 421614 ? viemArbitrumSepolia : viemArbitrum;
  const publicClient = createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl) });
  await client.connect(publicClient as any, signer as any);

  const permit = account.toLowerCase() === options.agentAddress.toLowerCase()
    ? await client.permits.getOrCreateSelfPermit()
    : await client.permits.createSharing({
        issuer: account,
        recipient: options.agentAddress,
        name: `agent-permit-${options.agentAddress.slice(0, 8)}`,
      });

  return PermitUtils.export(permit);
}

// ─── Onboard permit (PRD-18) ────────────────────────────────────────────────
//
// Mint a *scoped, short-lived, single-use* Fhenix child-permit for one-prompt
// onboarding. The scope is encoded in the permit's `name` field as
// `openx-onboard:<jti>`; the API auth middleware parses it via the shared
// `ONBOARD_SCOPE_PREFIX` constant. Single-use is enforced at the DB layer
// (`onboard_permits_spent`); this call is the issuance side.
//
// Recipient design (PRD-18 §B fix): we use the BrainKeyVaultV2 contract
// address as the permit recipient — NOT the platform wallet. Onboard
// permits are scoped bearer tokens, not decryption grants, so the recipient
// field is structural only. Using the contract address (a) sidesteps the
// CoFHE SDK's `issuer !== recipient` constraint (a contract has no private
// key, so it can never collide with a user wallet — even when the platform
// operator is testing with their own wallet), and (b) is semantically
// truthful — the seller IS authorizing access to the BrainKeyVault system.
//
// Default TTL is 15 min — matches the design spec. The CoFHE SDK's signed
// expiration is the cryptographic ceiling; the DB record is the practical
// floor (single-use). Whichever fires first wins.

export const ONBOARD_SCOPE_PREFIX = 'openx-onboard:';
export const DEFAULT_ONBOARD_TTL_SEC = 15 * 60;

export interface MintOnboardOptions {
  /** BrainKeyVaultV2 address — used as BOTH the permit's `contract` field
   *  (which it already was) and its `recipient` (PRD-18 §B fix). */
  contractAddress: `0x${string}`;
  /** Override TTL; defaults to 900s (15 min). */
  ttlSec?: number;
  /** Override jti; defaults to crypto.randomUUID(). */
  jti?: string;
}

export interface OnboardPermit {
  /** Serialized permit blob (the value the agent sends in `x-fhenix-permit`). */
  serialized: string;
  /** Encoded inside the permit's `name`; persisted server-side on first use. */
  jti: string;
  /** Issuance timestamp + ttlSec, expressed as a unix epoch in seconds. */
  expiresAtSec: number;
  /** Lower-cased issuer address — convenient for display in /docs. */
  walletAddress: string;
}

export async function mintOnboardPermit(
  options: MintOnboardOptions,
  chain: SupportedChain,
  signer: WalletClient,
): Promise<OnboardPermit> {
  const client = getCofheClient();
  const account = signer.account?.address ?? (await signer.getAddresses())[0];
  if (!account) throw new Error('No account found in wallet client');

  const viemChain = chain.id === 421614 ? viemArbitrumSepolia : viemArbitrum;
  const publicClient = createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl) });
  await client.connect(publicClient as any, signer as any);

  const jti =
    options.jti ??
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36));
  const ttlSec = options.ttlSec ?? DEFAULT_ONBOARD_TTL_SEC;
  const expiresAtSec = Math.floor(Date.now() / 1000) + ttlSec;

  // `expiration` is best-effort: when the SDK supports it, the cryptographic
  // proof carries the same TTL; when it doesn't, the DB single-use ledger is
  // still authoritative. Either way the agent gets a token that publishes
  // exactly once.
  const permit = await client.permits.createSharing({
    issuer: account,
    recipient: options.contractAddress,
    name: `${ONBOARD_SCOPE_PREFIX}${jti}`,
    expiration: expiresAtSec,
  } as Parameters<typeof client.permits.createSharing>[0]);

  return {
    serialized: PermitUtils.export(permit),
    jti,
    expiresAtSec,
    walletAddress: account.toLowerCase(),
  };
}
