import { keccak256, toHex, recoverMessageAddress } from 'viem';
import { pool } from '../db';
import { logger } from '../lib';

/**
 * agentLinkOracle — cross-chain agent identity service.
 *
 * Two responsibilities (kept in one file because they share storage and
 * because real-prod swap is one function — the ERC-8004 read):
 *
 *   1. Register / verify an `AgentLink` row that binds an EVM wallet to a
 *      Sui wallet under a single `canonical_id`.
 *   2. Mirror the EVM-side ERC-8004 reputation onto the link row so the
 *      Sui-tier KYAGate can consume it without a fresh on-chain hop.
 *
 * Mock-first: `fetchEthReputation` returns 50 for any address. Real-prod
 * swap = `viem.readContract` against ERC-8004 IdentityRegistry on Base.
 */

export interface RegisterLinkInput {
  canonical_id?: string;        // optional; minted if absent
  eth_address?: string;
  sui_address?: string;
  /** EIP-191 personal_sign over `canonical_id || sui_address`. */
  eth_sig?: string;
  /** Sui ed25519 signature over `canonical_id || eth_address`. */
  sui_sig?: string;
}

export interface AgentLinkRow {
  canonical_id: string;
  eth_address: string | null;
  sui_address: string | null;
  reputation: number;
}

/**
 * Rolled-up reputation across both tiers.
 *
 *   reputation = combined ERC-8004 (EVM) + Sui-native rep
 *
 * Used by `kya_gate::verify` (Move side reads `reputation`) and by the
 * Standard tier's KYA middleware (`agent-kya.ts`) so an agent that has
 * earned reputation on either tier doesn't have to rebuild it on the other.
 *
 * Phase 5: when both addresses are linked + signed, rep = max(eth, sui).
 * Single-tier agents see only their tier's value (no upgrade pressure).
 */
export interface AgentReputation {
  canonical_id: string;
  eth_reputation: number;
  sui_reputation: number;
  /** max(eth_reputation, sui_reputation) — the value Move policies + KYA middleware consume. */
  combined_reputation: number;
  tier: 'eth-only' | 'sui-only' | 'both';
}

export async function registerLink(input: RegisterLinkInput): Promise<AgentLinkRow> {
  if (!input.eth_address && !input.sui_address) {
    throw new Error('agentLinkOracle:at-least-one-address-required');
  }

  // Verify EVM signature if both eth_sig and sui_address present.
  if (input.eth_sig && input.eth_address && input.sui_address && input.canonical_id) {
    const message = `${input.canonical_id}|${input.sui_address.toLowerCase()}`;
    const recovered = await recoverMessageAddress({
      message,
      signature: input.eth_sig as `0x${string}`,
    });
    if (recovered.toLowerCase() !== input.eth_address.toLowerCase()) {
      throw new Error('agentLinkOracle:eth_sig:invalid');
    }
  }

  // Sui sig verification deferred until @mysten/sui is wired (mock-first).
  // The Sui Move-side `kya_gate::register_link` will be the canonical verifier
  // once the package is deployed (see T5 follow-up).

  const reputation = input.eth_address ? await fetchEthReputation(input.eth_address) : 0;

  const { rows } = await pool.query(
    `INSERT INTO agent_links (canonical_id, eth_address, sui_address, eth_sig, sui_sig, reputation)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6)
     ON CONFLICT (canonical_id) DO UPDATE
       SET eth_address = COALESCE(EXCLUDED.eth_address, agent_links.eth_address),
           sui_address = COALESCE(EXCLUDED.sui_address, agent_links.sui_address),
           eth_sig     = COALESCE(EXCLUDED.eth_sig, agent_links.eth_sig),
           sui_sig     = COALESCE(EXCLUDED.sui_sig, agent_links.sui_sig),
           reputation  = EXCLUDED.reputation
     RETURNING canonical_id, eth_address, sui_address, reputation`,
    [
      input.canonical_id ?? null,
      input.eth_address?.toLowerCase() ?? null,
      input.sui_address ?? null,
      input.eth_sig ?? null,
      input.sui_sig ?? null,
      reputation,
    ],
  );
  return rows[0];
}

export async function getLinkByEth(eth: string): Promise<AgentLinkRow | null> {
  const r = await pool.query(
    `SELECT canonical_id, eth_address, sui_address, reputation
     FROM agent_links WHERE eth_address = $1`,
    [eth.toLowerCase()],
  );
  return r.rows[0] ?? null;
}

export async function getLinkBySui(sui: string): Promise<AgentLinkRow | null> {
  const r = await pool.query(
    `SELECT canonical_id, eth_address, sui_address, reputation
     FROM agent_links WHERE sui_address = $1`,
    [sui],
  );
  return r.rows[0] ?? null;
}

/**
 * MOCK: returns 50 for any address. Real-prod swap reads ERC-8004
 * `getReputation(address)` on the canonical IdentityRegistry on Base.
 */
async function fetchEthReputation(address: string): Promise<number> {
  if (process.env.ERC8004_RPC_URL && process.env.ERC8004_REGISTRY_ADDRESS) {
    try {
      // Real-prod: drop in `viem.readContract({ address, abi, functionName: 'getReputation', args: [address] })`.
      // For v1 we still return mock — see docs/V3_PROPOSAL.md mock-first table.
      logger.debug({ address }, 'agentLinkOracle:reputation:env-set-but-still-mocked');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'agentLinkOracle:reputation:read-failed');
    }
  }
  // Deterministic mock based on address hash so tests are stable.
  const h = Number((BigInt(keccak256(toHex(address))) % 100n));
  return h;
}

/**
 * MOCK: Sui-side reputation (paid-query count, KYA tier, OpenX-internal score).
 * Phase 5 swap: read from `agent_receipts` rolling sum + cap at 99.
 */
async function fetchSuiReputation(suiAddress: string): Promise<number> {
  // Per-buyer paid-query count, normalized 0..99. Mock for now: deterministic
  // hash so tests pass without a populated `agent_receipts` table.
  const h = Number((BigInt(keccak256(toHex(suiAddress))) % 100n));
  return h;
}

/**
 * Cross-tier reputation roll-up.
 *
 * Resolves a canonical_id to (eth_rep, sui_rep, combined). Combined is
 * `max(eth, sui)` — agents who graduate from Sui-only to EVM-linked don't
 * lose their Sui rep, and vice versa. KYA gates downstream consume only
 * `combined_reputation`, never the per-tier values.
 */
export async function getCombinedReputation(canonicalId: string): Promise<AgentReputation | null> {
  const r = await pool.query<AgentLinkRow>(
    `SELECT canonical_id, eth_address, sui_address, reputation
     FROM agent_links WHERE canonical_id = $1`,
    [canonicalId],
  );
  const row = r.rows[0];
  if (!row) return null;

  const ethRep = row.eth_address ? await fetchEthReputation(row.eth_address) : 0;
  const suiRep = row.sui_address ? await fetchSuiReputation(row.sui_address) : 0;
  const combined = Math.max(ethRep, suiRep);
  const tier: AgentReputation['tier'] =
    row.eth_address && row.sui_address ? 'both' : row.eth_address ? 'eth-only' : 'sui-only';

  return {
    canonical_id: row.canonical_id,
    eth_reputation: ethRep,
    sui_reputation: suiRep,
    combined_reputation: combined,
    tier,
  };
}
