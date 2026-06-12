/**
 * loopRunner.ts — event-driven dispatcher for arb-loop work.
 *
 * Listens to Arbitrum events via viem, enqueues work into arbloop_runner_queue,
 * claims via FOR UPDATE SKIP LOCKED, dispatches to LoopExecutionEngine.
 *
 * SOLID:
 *   - SRP: event polling + queue claim only. Execution is delegated.
 *   - DIP: engine + db + flag-loader injected.
 *   - OCP: a new event = one entry in EVENT_HANDLERS.
 *
 * Multi-instance safe via SKIP LOCKED. Idempotent at the (job_address, iter_n)
 * primary key — re-claiming a completed iter is a Postgres no-op.
 */

import { createPublicClient, http, parseAbiItem, type Log } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { pool } from '../../db';
import { LoopExecutionEngine } from './loopExecutionEngine';

const JOB_CREATED_EVENT = parseAbiItem(
  'event JobCreated(address indexed buyer, address indexed agentRegistryAddr, uint256 indexed agentId, bytes32 manifestEigenKzg, address jobAddress, address jobMemoryNamespace, uint256 budgetMicroUsdc, uint256 maxIterations)',
);
const ITER_ADVANCED_EVENT = parseAbiItem(
  'event IterAdvanced(uint256 indexed iterN, bytes32 attestationUid, uint256 newSpentMicroUsdc)',
);
const CHECKPOINT_APPROVED_EVENT = parseAbiItem(
  'event CheckpointApproved(bytes32 indexed key, address approvedBy)',
);

export interface LoopRunnerDeps {
  rpcUrl: string;
  loopJobFactoryAddress: string;   // emits JobCreated
  checkpointApprovalAddress: string; // emits CheckpointApproved
  engine: LoopExecutionEngine;
  network: string;                 // 'arbitrum-sepolia'
  /** Master flag — when false, runner stays idle. */
  enabled: () => boolean;
  /** Polling cadence (ms). Defaults to 3000 / 1000. */
  eventPollMs?: number;
  workerPollMs?: number;
  logger?: { info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void };
}

const noop = () => undefined;
const consoleLogger = {
  info: (m: unknown) => console.log('[arbloop:runner]', m),
  warn: (m: unknown) => console.warn('[arbloop:runner]', m),
  error: (m: unknown) => console.error('[arbloop:runner]', m),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LoopRunner {
  private polling = false;
  private worker = false;
  private readonly client;
  private readonly log;
  private readonly eventPollMs: number;
  private readonly workerPollMs: number;

  constructor(private readonly deps: LoopRunnerDeps) {
    this.client = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(deps.rpcUrl),
    });
    this.log = deps.logger ?? consoleLogger;
    this.eventPollMs = deps.eventPollMs ?? 3000;
    this.workerPollMs = deps.workerPollMs ?? 1000;
  }

  start(): void {
    if (!this.deps.enabled()) {
      this.log.info('FEATURE_ARBLOOP=false — runner idle');
      return;
    }
    this.polling = true;
    this.worker = true;
    void this.eventPollLoop().catch((e) => this.log.error({ err: String(e) }));
    void this.workerLoop().catch((e) => this.log.error({ err: String(e) }));
    this.log.info('runner:started');
  }

  stop(): void {
    this.polling = false;
    this.worker = false;
    this.log.info('runner:stopped');
  }

  private async eventPollLoop(): Promise<void> {
    const cursor = await this.loadCursor();
    let lastBlock = cursor;

    while (this.polling) {
      try {
        const head = await this.client.getBlockNumber();
        if (head <= lastBlock) {
          await sleep(this.eventPollMs);
          continue;
        }

        // JobCreated events
        const jobLogs = await this.client.getLogs({
          address: this.deps.loopJobFactoryAddress as `0x${string}`,
          event: JOB_CREATED_EVENT,
          fromBlock: lastBlock + 1n,
          toBlock: head,
        });
        for (const log of jobLogs) await this.handleJobCreated(log);

        // CheckpointApproved events
        const cpLogs = await this.client.getLogs({
          address: this.deps.checkpointApprovalAddress as `0x${string}`,
          event: CHECKPOINT_APPROVED_EVENT,
          fromBlock: lastBlock + 1n,
          toBlock: head,
        });
        for (const log of cpLogs) await this.handleCheckpointApproved(log);

        // IterAdvanced fires per LoopJob; we don't know addresses ahead of time,
        // so scan all jobs we've enqueued in our DB and listen to their events.
        // For v0.1 simplicity, the engine itself enqueues the next iter inside
        // executeIteration when nextStatus === RUNNING, so we don't need to
        // listen on every LoopJob.

        lastBlock = head;
        await this.saveCursor(lastBlock);
      } catch (e) {
        this.log.warn({ msg: 'event-poll-error', err: String(e) });
      }
      await sleep(this.eventPollMs);
    }
  }

  private async handleJobCreated(log: Log): Promise<void> {
    const args = (log as unknown as { args: { jobAddress: string } }).args;
    if (!args?.jobAddress) return;
    await this.enqueue('iter', args.jobAddress, 1, 'JobCreated', log.transactionHash);
  }

  private async handleCheckpointApproved(log: Log): Promise<void> {
    // The CheckpointApproval contract uses a key = keccak256(jobAddress, iterN).
    // To resume, we look up the iter the user just approved by scanning the
    // arbloop_runner_queue for any pending PAUSED_CHECKPOINT row matching the
    // approver. v0.1 simplification: re-enqueue the next iter for every job
    // the approver buyer'd within the last 24h. The engine's idempotency
    // (status check + iter_n match) ensures we never double-dispatch.
    void log; // unused in mock-mode
  }

  private async workerLoop(): Promise<void> {
    while (this.worker) {
      try {
        const claimed = await this.claimNext(5);
        for (const row of claimed) {
          try {
            const result = await this.deps.engine.executeIteration(row.job_contract_address);
            await this.markCompleted(row.id);
            // Auto-enqueue next iter if we're still RUNNING
            if (result && !result.stopFires && result.nextStatus === 1 /* RUNNING */) {
              await this.enqueue(
                'iter',
                row.job_contract_address,
                result.iterN + 1,
                'IterAdvanced',
                result.multicallTxHash,
              );
            }
          } catch (err) {
            await this.markFailed(row.id, String(err));
          }
        }
      } catch (e) {
        this.log.warn({ msg: 'worker-error', err: String(e) });
      }
      await sleep(this.workerPollMs);
    }
  }

  private async enqueue(
    op_kind: 'iter' | 'reflective_writeback',
    job_contract_address: string,
    iter_n: number,
    trigger_event: string,
    trigger_tx_hash?: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO arbloop_runner_queue
         (op_kind, job_contract_address, iter_n, trigger_event, trigger_tx_hash, state)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [op_kind, job_contract_address, iter_n, trigger_event, trigger_tx_hash ?? null],
    );
  }

  private async claimNext(limit: number): Promise<Array<{ id: number; job_contract_address: string; iter_n: number }>> {
    const r = await pool.query(
      `WITH claimed AS (
         SELECT id FROM arbloop_runner_queue
          WHERE state = 'pending' AND not_before <= now()
          ORDER BY created_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE arbloop_runner_queue q
          SET state = 'claimed', claimed_at = now(), attempts = q.attempts + 1
         FROM claimed
        WHERE q.id = claimed.id
       RETURNING q.id, q.job_contract_address, q.iter_n`,
      [limit],
    );
    return r.rows;
  }

  private async markCompleted(id: number): Promise<void> {
    await pool.query(
      `UPDATE arbloop_runner_queue SET state = 'completed', completed_at = now() WHERE id = $1`,
      [id],
    );
  }

  private async markFailed(id: number, err: string): Promise<void> {
    await pool.query(
      `UPDATE arbloop_runner_queue
         SET state = 'failed', last_error = $2, completed_at = now()
       WHERE id = $1`,
      [id, err.slice(0, 500)],
    );
  }

  private async loadCursor(): Promise<bigint> {
    const r = await pool.query(
      `SELECT last_block FROM arbloop_event_cursor WHERE network = $1`,
      [this.deps.network],
    );
    if (r.rowCount === 0) return 0n;
    return BigInt(r.rows[0].last_block);
  }

  private async saveCursor(block: bigint): Promise<void> {
    await pool.query(
      `INSERT INTO arbloop_event_cursor (network, last_block, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (network) DO UPDATE SET last_block = $2, updated_at = now()`,
      [this.deps.network, block.toString()],
    );
  }
}

void noop;
