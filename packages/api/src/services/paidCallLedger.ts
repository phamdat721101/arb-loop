/**
 * paidCallLedger — single insertion point for /api/v1 settlement records.
 *
 * SOLID:
 *   - SRP: this module owns writes to the `paid_calls` table. Nothing else.
 *   - DIP: x402 path AND fherc20 path both call `record()`; neither knows about the other.
 *
 * Idempotent on (network, tx_hash) — re-submitting the same proof is a no-op.
 */

import { randomUUID } from 'node:crypto';
import { pool } from '../db';
import { logger } from '../lib';

/** Per (wallet × brain) freemium quota. 0 disables freemium entirely. */
export const FREE_PREVIEW_LIMIT = Number(process.env.FREE_PREVIEW_LIMIT ?? 5);

export interface PaidCallRecord {
  agentId: string;
  slug: string;
  buyer: string;
  amountUsdc: string;          // decimal string, e.g. "0.01"
  txHash: string;
  network: string;             // 'arbitrum-sepolia' | 'base-sepolia' | …
  method: 'exact' | 'fherc20' | 'demo' | 'free'; // x402 / FHERC20 confidential / free try-it / freemium
}

/** Returns true if a fresh row was inserted, false if it was a duplicate. */
export async function record(call: PaidCallRecord): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO paid_calls (agent_id, slug, buyer, amount_usdc, tx_hash, network, method)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (network, tx_hash) DO NOTHING
     RETURNING id`,
    [call.agentId, call.slug, call.buyer.toLowerCase(), call.amountUsdc, call.txHash, call.network, call.method],
  );
  const fresh = (r.rowCount ?? 0) > 0;
  if (fresh) {
    logger.info({ slug: call.slug, txHash: call.txHash, method: call.method }, 'paidCall:recorded');
  } else {
    logger.debug({ txHash: call.txHash }, 'paidCall:duplicate');
  }
  return fresh;
}

/** Today's call count for a slug — used by daily_request_cap rate limiter. */
export async function countToday(slug: string): Promise<number> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM paid_calls
      WHERE slug = $1 AND created_at >= NOW() - INTERVAL '1 day'`,
    [slug],
  );
  return r.rows[0]?.c ?? 0;
}

// ── Freemium gate (T5 / PRD-B) ───────────────────────────────────────────────
//
// The freemium counter is *implicit*: rows in paid_calls with method='free' and
// amount_usdc=0. Migration 010 adds a covering index so the count query is <5ms.
//
// SOLID:
//   - SRP: same module, same table — no new "freemium service" abstraction.
//   - I3: BOTH buyer paywalls (paymentGate.ts /v3, v1Public.ts /api/v1) call
//     these two functions. Single source of truth for the freemium rule.

const NETWORK = process.env.X402_NETWORK ?? 'arbitrum-sepolia';

/**
 * Returns the number of free queries remaining for (buyer, agentId).
 * Returns 0 when freemium is disabled (FREE_PREVIEW_LIMIT=0). Cheap (<5ms
 * with the freemium index from migration 010).
 */
export async function checkFreePreview(buyer: string, agentId: string): Promise<number> {
  if (FREE_PREVIEW_LIMIT === 0) return 0;
  const r = await pool.query(
    `SELECT COUNT(*)::int AS used FROM paid_calls
      WHERE buyer = $1 AND agent_id = $2 AND method = 'free'`,
    [buyer.toLowerCase(), agentId],
  );
  return Math.max(0, FREE_PREVIEW_LIMIT - (r.rows[0]?.used ?? 0));
}

/**
 * Records a free query as a paid_calls row. Synthetic tx_hash keeps the
 * (network, tx_hash) UNIQUE invariant. Idempotent.
 */
export async function recordFree(buyer: string, agentId: string, slug: string): Promise<void> {
  await record({
    agentId,
    slug,
    buyer,
    amountUsdc: '0',
    txHash: `free-${randomUUID()}`,
    network: NETWORK,
    method: 'free',
  });
}
