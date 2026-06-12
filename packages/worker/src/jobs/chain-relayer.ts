/**
 * chain-relayer.ts — drains chain_ops_queue and signs on-chain ops with
 * the platform relayer wallet.
 *
 * PRD-19 v1: only `create_brain` on KnowledgeBaseRegistryV2 (Arbitrum
 * Sepolia). Single-poller / single-hot-wallet by design — keeps nonce
 * management trivial and matches expected testnet throughput. Upgrade
 * paths (multi-wallet rotation, EIP-2771 forwarder) are queued for PRD-20.
 *
 * SOLID:
 *   - SRP: one job — drain queue, sign, write back.
 *   - DIP: pg + ethers are constructor-free singletons; env supplies
 *     RPC URL, registry address, and the relayer key. No global state
 *     other than the cached provider/wallet/contract triple.
 *   - I3: queue verbs (claimNext, markConfirmed, markFailed) live in the
 *     api package's chainOpsQueue.ts. We re-implement the SQL inline here
 *     to avoid a worker→api workspace dep just for three statements; the
 *     SQL shape is verbatim and a comment points at the canonical source.
 *
 * Failure model:
 *   - retryable: provider/network errors, nonce stale → re-enqueue with
 *     exponential backoff (handled by markFailed).
 *   - terminal:  contract revert, insufficient funds → state='failed',
 *     surfaced in /v4/admin/stats for operator triage.
 *
 * Funding:
 *   - Reads RELAYER_PRIVATE_KEY first; falls back to DEPLOYER_PRIVATE_KEY
 *     so existing deploy infra works unchanged.
 *   - Skips draining when balance < SAFE_MIN_BALANCE_WEI; posts a once-
 *     per-hour Slack alert (when SLACK_ALERTS_WEBHOOK is set).
 */
import 'dotenv/config';
import pg from 'pg';
import { ethers } from 'ethers';

const POLL_INTERVAL_MS = Number(process.env.RELAYER_POLL_MS ?? 5_000);
const MAX_ATTEMPTS = 3;
const SAFE_MIN_BALANCE_WEI = ethers.parseEther('0.005');
const ALERT_COOLDOWN_MS = 60 * 60_000;

const REGISTRY_ABI = [
  'function createBrain() external returns (uint256)',
  'function getBrainCount() view returns (uint256)',
  'event BrainCreated(uint256 indexed id, address indexed owner)',
];

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let _provider: ethers.JsonRpcProvider | null = null;
let _wallet: ethers.Wallet | null = null;
let _registry: ethers.Contract | null = null;
let _lastAlertAt = 0;

function getRelayerKey(): string | null {
  // Fallback chain follows project convention:
  //   1. RELAYER_PRIVATE_KEY  — explicit, for ops who want a dedicated wallet.
  //   2. DEPLOYER_PRIVATE_KEY — already used by hardhat (`DEPLOYER_PRIVATE_KEY` in
  //      packages/contracts/.env.example) so existing deploy infra works as-is.
  //   3. PRIVATE_KEY          — the canonical platform-signer var used elsewhere
  //      in this repo (api/fhe/client.ts, services/knowledge-ingest.ts, etc.).
  return (
    process.env.RELAYER_PRIVATE_KEY ||
    process.env.DEPLOYER_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    null
  );
}

function ensureSigner(): { provider: ethers.JsonRpcProvider; wallet: ethers.Wallet; registry: ethers.Contract } | null {
  if (_wallet && _provider && _registry) return { provider: _provider, wallet: _wallet, registry: _registry };
  const key = getRelayerKey();
  const registryAddr = process.env.KNOWLEDGE_REGISTRY_ADDRESS;
  if (!key || !registryAddr) return null;
  const rpc = process.env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
  _provider = new ethers.JsonRpcProvider(rpc);
  _wallet = new ethers.Wallet(key, _provider);
  _registry = new ethers.Contract(registryAddr, REGISTRY_ABI, _wallet);
  return { provider: _provider, wallet: _wallet, registry: _registry };
}

function isRetryable(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  if (msg.includes('insufficient funds')) return false;
  if (msg.includes('execution reverted')) return false;
  if (msg.includes('nonce too low')) return true; // resolves on next poll
  return true; // default: retry transient/network errors
}

async function postLowBalanceAlert(addr: string, balance: bigint): Promise<void> {
  const url = process.env.SLACK_ALERTS_WEBHOOK;
  if (!url) return;
  if (Date.now() - _lastAlertAt < ALERT_COOLDOWN_MS) return;
  _lastAlertAt = Date.now();
  const balEth = ethers.formatEther(balance);
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: `:warning: OpenX relayer ${addr} low balance: ${balEth} ETH on Arbitrum Sepolia. Top up before queue stalls.`,
    }),
  }).catch(() => undefined);
}

/**
 * Claim the next pending op via FOR UPDATE SKIP LOCKED. Mirrors
 * packages/api/src/services/chainOpsQueue.ts::claimNext — kept inline
 * here to avoid a workspace cross-package dep for one query.
 */
async function claimNext(client: pg.PoolClient): Promise<{
  id: number; agent_id: string; attempts: number;
} | null> {
  const r = await client.query(
    `UPDATE chain_ops_queue q
        SET state = 'claimed', claimed_at = now(), attempts = q.attempts + 1
       FROM (
         SELECT id FROM chain_ops_queue
          WHERE state = 'pending' AND chain = 'arbitrum-sepolia' AND not_before <= now()
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       ) sub
      WHERE q.id = sub.id
      RETURNING q.id, q.agent_id, q.attempts`,
  );
  return r.rowCount === 0
    ? null
    : { id: Number(r.rows[0].id), agent_id: r.rows[0].agent_id, attempts: Number(r.rows[0].attempts) };
}

async function markConfirmed(id: number, txHash: string, brainId: number, agentId: string): Promise<void> {
  // Two writes, two purposes — one keeps the queue row's audit trail
  // intact, the other surfaces the on-chain id on the agent for the
  // dashboard badge. Run in parallel; both are tiny indexed updates.
  await Promise.all([
    db.query(
      `UPDATE chain_ops_queue
          SET state='confirmed', tx_hash=$2, on_chain_brain_id=$3,
              confirmed_at=now(), last_error=NULL
        WHERE id=$1`,
      [id, txHash, brainId],
    ),
    db.query(
      `UPDATE agents
          SET on_chain_brain_id=$2, on_chain_tx=$3, on_chain_chain='arbitrum-sepolia'
        WHERE id=$1`,
      [agentId, brainId, txHash],
    ),
  ]);
}

async function markFailed(id: number, attempts: number, error: string, retryable: boolean): Promise<void> {
  if (retryable && attempts < MAX_ATTEMPTS) {
    const backoffMin = 2 ** attempts;
    await db.query(
      `UPDATE chain_ops_queue
          SET state='pending', last_error=$2, not_before=now() + ($3 || ' minutes')::interval
        WHERE id=$1`,
      [id, error.slice(0, 500), String(backoffMin)],
    );
    return;
  }
  await db.query(
    `UPDATE chain_ops_queue SET state='failed', last_error=$2 WHERE id=$1`,
    [id, error.slice(0, 500)],
  );
}

/**
 * One poll iteration: claim → release lock → sign → write back.
 * Splitting claim and send across two transactions matters: the row lock
 * releases on COMMIT before we hit the network, so a slow RPC round-trip
 * never holds a Postgres connection or blocks parallel pollers (when
 * we move beyond single-poller in PRD-20).
 */
async function drainOnce(): Promise<void> {
  const ctx = ensureSigner();
  if (!ctx) return;

  // Cheap balance gate — skip the Postgres claim entirely on low funds.
  const bal = await ctx.provider.getBalance(ctx.wallet.address);
  if (bal < SAFE_MIN_BALANCE_WEI) {
    await postLowBalanceAlert(ctx.wallet.address, bal);
    return;
  }

  const client = await db.connect();
  let claimed: { id: number; agent_id: string; attempts: number } | null = null;
  try {
    await client.query('BEGIN');
    claimed = await claimNext(client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[chain-relayer] claim failed:', (e as Error).message);
    return;
  } finally {
    client.release();
  }
  if (!claimed) return;

  try {
    const tx = await ctx.registry.createBrain();
    const receipt = await tx.wait(1);
    if (!receipt) throw new Error('null receipt');

    // Parse BrainCreated(uint256 id, address owner) — id is the indexed
    // first topic after the signature; ethers v6 gives us a structured log.
    const iface = new ethers.Interface(REGISTRY_ABI);
    let brainId = -1;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'BrainCreated') {
          brainId = Number(parsed.args[0]);
          break;
        }
      } catch {
        /* not our event */
      }
    }
    if (brainId < 0) throw new Error('BrainCreated event not found in receipt');

    await markConfirmed(claimed.id, tx.hash, brainId, claimed.agent_id);
    console.log(
      `[chain-relayer] op=${claimed.id} agent=${claimed.agent_id} brainId=${brainId} tx=${tx.hash}`,
    );
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await markFailed(claimed.id, claimed.attempts, msg, isRetryable(e));
    console.warn(`[chain-relayer] op=${claimed.id} failed: ${msg}`);
  }
}

let _timer: NodeJS.Timeout | null = null;

export function startChainRelayer(): void {
  if (_timer) return;
  if (!ensureSigner()) {
    console.warn('[chain-relayer] not started: missing RELAYER_PRIVATE_KEY/DEPLOYER_PRIVATE_KEY or KNOWLEDGE_REGISTRY_ADDRESS');
    return;
  }
  _timer = setInterval(() => {
    drainOnce().catch((e) => console.error('[chain-relayer] drain crashed:', e));
  }, POLL_INTERVAL_MS);
  console.log(`[chain-relayer] started, polling every ${POLL_INTERVAL_MS}ms`);
}
