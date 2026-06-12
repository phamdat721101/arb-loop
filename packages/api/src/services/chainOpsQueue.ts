import type { Pool, PoolClient } from 'pg';

/**
 * chainOpsQueue — Postgres queue for asynchronous on-chain ops.
 *
 * PRD-19. Drives gasless non-crypto seller onboarding: the publish
 * transaction enqueues a `create_brain` op; the chain-relayer worker
 * (packages/worker/src/jobs/chain-relayer.ts) drains it.
 *
 * SOLID:
 *   - SRP: this module owns enqueue/claim/complete/fail, nothing else.
 *   - DIP: callers inject a Pool or PoolClient; we never construct one.
 *     This lets `enqueueCreateBrain` live inside an outer publish TX with
 *     no second connection acquired.
 *   - OCP: a new op_type adds one helper function next to enqueueCreateBrain;
 *     `claimNext` and the markers stay generic over the op_type column.
 *
 * Performance:
 *   - claimNext uses `FOR UPDATE SKIP LOCKED LIMIT 1` so N parallel workers
 *     never block each other and never double-claim.
 *   - markFailed schedules retries via `not_before` — the pending index is
 *     a partial index on (not_before, id) so backoff rows are skipped
 *     cheaply until their window opens.
 */

export type OpType = 'create_brain';
export type OpState = 'pending' | 'claimed' | 'confirmed' | 'failed';

export interface ChainOp {
  id: number;
  op_type: OpType;
  agent_id: string;
  seller_address: string;
  chain: string;
  state: OpState;
  payload: Record<string, unknown>;
  attempts: number;
  tx_hash: string | null;
  on_chain_brain_id: number | null;
  last_error: string | null;
}

const MAX_ATTEMPTS = 3;

/**
 * Enqueue a `create_brain` op. Accepts Pool OR PoolClient so the call
 * composes into the existing sellerPublishService publish() transaction —
 * the queue insert and the agents/brain inserts commit together or
 * roll back together.
 */
export async function enqueueCreateBrain(
  client: Pool | PoolClient,
  args: { agentId: string; sellerAddress: string; chain?: string; brainId?: number },
): Promise<{ id: number }> {
  const payload = args.brainId !== undefined ? { db_brain_id: args.brainId } : {};
  const r = await client.query(
    `INSERT INTO chain_ops_queue (op_type, agent_id, seller_address, chain, payload)
     VALUES ('create_brain', $1, $2, $3, $4::jsonb)
     RETURNING id`,
    [args.agentId, args.sellerAddress.toLowerCase(), args.chain ?? 'arbitrum-sepolia', JSON.stringify(payload)],
  );
  return { id: Number(r.rows[0].id) };
}

/**
 * Claim the next pending op for the given chain. MUST be called inside a
 * transaction the caller owns: we lock the row with `FOR UPDATE SKIP LOCKED`
 * and the lock releases on commit/rollback. The caller is responsible for
 * COMMITting before the on-chain RPC round-trip so a single hot wallet's
 * nonce doesn't get pinned behind a 30-second tx confirmation.
 */
export async function claimNext(
  client: PoolClient,
  opts?: { chain?: string },
): Promise<ChainOp | null> {
  const chain = opts?.chain ?? 'arbitrum-sepolia';
  const r = await client.query(
    `UPDATE chain_ops_queue q
        SET state = 'claimed',
            claimed_at = now(),
            attempts = q.attempts + 1
       FROM (
         SELECT id FROM chain_ops_queue
          WHERE state = 'pending' AND chain = $1 AND not_before <= now()
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       ) sub
      WHERE q.id = sub.id
      RETURNING q.id, q.op_type, q.agent_id, q.seller_address, q.chain,
                q.state, q.payload, q.attempts, q.tx_hash, q.on_chain_brain_id, q.last_error`,
    [chain],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return {
    id: Number(row.id),
    op_type: row.op_type,
    agent_id: row.agent_id,
    seller_address: row.seller_address,
    chain: row.chain,
    state: row.state,
    payload: row.payload ?? {},
    attempts: Number(row.attempts),
    tx_hash: row.tx_hash,
    on_chain_brain_id: row.on_chain_brain_id !== null ? Number(row.on_chain_brain_id) : null,
    last_error: row.last_error,
  };
}

export async function markConfirmed(
  client: Pool | PoolClient,
  id: number,
  txHash: string,
  onChainBrainId: number,
): Promise<void> {
  await client.query(
    `UPDATE chain_ops_queue
        SET state = 'confirmed',
            tx_hash = $2,
            on_chain_brain_id = $3,
            confirmed_at = now(),
            last_error = NULL
      WHERE id = $1`,
    [id, txHash, onChainBrainId],
  );
}

/**
 * Mark a claimed op as failed. When `retryable && attempts < MAX_ATTEMPTS`
 * the row goes back to 'pending' with exponential backoff (2^attempts
 * minutes from now). Otherwise it stays 'failed' and the operator
 * triages via /v4/admin/stats.
 */
export async function markFailed(
  client: Pool | PoolClient,
  id: number,
  attempts: number,
  error: string,
  retryable: boolean,
): Promise<void> {
  if (retryable && attempts < MAX_ATTEMPTS) {
    const backoffMin = 2 ** attempts; // 2, 4, 8 minutes
    await client.query(
      `UPDATE chain_ops_queue
          SET state = 'pending',
              last_error = $2,
              not_before = now() + ($3 || ' minutes')::interval
        WHERE id = $1`,
      [id, error.slice(0, 500), String(backoffMin)],
    );
    return;
  }
  await client.query(
    `UPDATE chain_ops_queue
        SET state = 'failed',
            last_error = $2
      WHERE id = $1`,
    [id, error.slice(0, 500)],
  );
}

/** Used by /v4/admin/stats — cheap, indexed counts. */
export async function relayerStats(
  client: Pool,
): Promise<{
  pending: number;
  claimed: number;
  failed_24h: number;
  p50_latency_sec: number;
}> {
  const r = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE state = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE state = 'claimed')::int AS claimed,
       COUNT(*) FILTER (
         WHERE state = 'failed' AND created_at > now() - interval '24 hours'
       )::int AS failed_24h,
       COALESCE(
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (confirmed_at - created_at))
         ) FILTER (
           WHERE state = 'confirmed' AND confirmed_at > now() - interval '24 hours'
         ),
         0
       )::float AS p50_latency_sec
     FROM chain_ops_queue`,
  );
  return r.rows[0];
}
