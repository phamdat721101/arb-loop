/**
 * workflowRunner — server-side topological executor for L4 Workflow runs.
 *
 * SOLID:
 *   - SRP: this module owns ONE thing — execute a published workflow's DAG
 *     and record the run receipt. Storage lookup, payment, attestation, and
 *     promotion live in their own modules and are injected as dependencies.
 *   - DIP: callers (the /v3/workflows route) inject `pool`, `signer`, plus
 *     thin function deps `payStep` / `attestStep` / `recordPaidCall`. This
 *     keeps the runner itself testable without spinning up a DB.
 *   - OCP: adding a new WorkflowStepType means adding a clause in
 *     `runStep()`; nothing else changes.
 *
 * G2 isolation (Adjustment 2): the runner refuses to execute any workflow
 * whose `sui_object_id` is null/missing. The DB schema (migration 013) makes
 * the column NOT NULL, so an out-of-band insert is the only way to even land
 * such a row — and `runWorkflow()` throws on attempt anyway. Belt + braces.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Hex } from 'viem';
import { pool as defaultPool } from '../db';
import { logger } from '../lib';
import { record as recordPaidCallDefault } from './paidCallLedger';
import {
  isWorkflowDagValid,
  type Workflow,
  type WorkflowStep,
  type WorkflowStepReceipt,
  type WorkflowRunReceipt,
} from '@fhe-ai-context/sdk';

// ─── Public types ──────────────────────────────────────────────────────────

export interface WorkflowRow {
  id: string;
  workflow_key: string;
  author_addr: string;
  sui_object_id: string;          // G2: NOT NULL by migration 013
  manifest_blob_id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  default_price_usdc: string;
  author_bps: number;
  platform_bps: number;
  published: boolean;
  signer: string;
  signature: string;
}

export interface RunInput {
  /** Pre-validated input object — runner does not enforce a schema. */
  input: Record<string, unknown>;
  buyer: Hex;
  /** Optional Sui PTB digest the route already settled (skip payment if present). */
  alreadyPaidTxDigest?: string;
}

/** Hook for invoking a paid step (skill / brain_ask). Returns output + receipt fields. */
export type PayStep = (
  step: WorkflowStep,
  resolvedInput: Record<string, unknown>,
) => Promise<{
  output: unknown;
  amountUsdc: string;
  sellerAddress: string;
  txHash?: string;
  attestationHash?: string;
}>;

/** Phala TEE attestation hook — optional; transform/no-pay steps skip. */
export type AttestStep = (
  step: WorkflowStep,
  output: unknown,
) => Promise<string | undefined>;

/** paidCallLedger.record signature (DI for tests). */
export type RecordPaidCall = typeof recordPaidCallDefault;

export interface WorkflowRunnerDeps {
  pool?: Pool;
  payStep: PayStep;
  attestStep?: AttestStep;
  recordPaidCall?: RecordPaidCall;
}

// ─── Errors ────────────────────────────────────────────────────────────────

export class WorkflowRunnerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_FOUND'
      | 'NOT_SUI_RESIDENT'
      | 'NOT_PUBLISHED'
      | 'INVALID_DAG'
      | 'STEP_FAILED'
      | 'STEP_PAYMENT_FAILED',
  ) {
    super(message);
    this.name = 'WorkflowRunnerError';
  }
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export class WorkflowRunner {
  private readonly pool: Pool;
  private readonly payStep: PayStep;
  private readonly attestStep?: AttestStep;
  private readonly recordPaidCall: RecordPaidCall;

  constructor(deps: WorkflowRunnerDeps) {
    this.pool = deps.pool ?? defaultPool;
    this.payStep = deps.payStep;
    this.attestStep = deps.attestStep;
    this.recordPaidCall = deps.recordPaidCall ?? recordPaidCallDefault;
  }

  /**
   * Execute a published workflow end-to-end.
   *
   * Hard preconditions:
   *  1. Row exists in `cognitive_workflows`.
   *  2. `sui_object_id` is non-empty (G2).
   *  3. `published = true`.
   *  4. DAG topo-validates (defense in depth — caller may pre-validate).
   */
  async runWorkflow(workflowId: string, input: RunInput): Promise<WorkflowRunReceipt> {
    const wf = await this.loadWorkflow(workflowId);
    this.assertSuiResident(wf);
    if (!wf.published) throw new WorkflowRunnerError('not published', 'NOT_PUBLISHED');

    const dag = isWorkflowDagValid(wf.steps);
    if (dag.ok === false) {
      throw new WorkflowRunnerError(`bad dag: ${dag.reason}`, 'INVALID_DAG');
    }

    const order = topoOrder(wf.steps);
    const stepReceipts: WorkflowStepReceipt[] = [];
    const outputs: Record<string, unknown> = {};
    const startedAt = Date.now();
    let success = true;
    let totalUsdc = 0;

    for (const stepId of order) {
      const step = wf.steps.find((s) => s.id === stepId)!;
      const stepInput = resolveStepInput(step, input.input, outputs);
      const stepStart = Date.now();
      try {
        const result = await this.runStep(step, stepInput, wf, input.buyer);
        outputs[stepId] = result.output;
        totalUsdc += Number(result.amountUsdc);
        stepReceipts.push({
          stepId,
          outputHash: hashCanonical(result.output),
          attestationHash: result.attestationHash,
          paymentReceiptTxHash: result.txHash,
          amountUsdc: result.amountUsdc,
          sellerAddress: result.sellerAddress,
          startedAt: stepStart,
          endedAt: Date.now(),
          success: true,
        });
      } catch (e: any) {
        success = false;
        stepReceipts.push({
          stepId,
          outputHash: '',
          amountUsdc: '0',
          sellerAddress: '',
          startedAt: stepStart,
          endedAt: Date.now(),
          success: false,
          failureMode: String(e?.message ?? e),
        });
        logger.error({ workflowId, stepId, err: e?.message }, 'workflowRunner:step:failed');
        break; // fail-fast — partial outputs preserved on the receipt
      }
    }

    const runId = randomUUID();
    const inputFingerprint = hashCanonical(input.input);
    const outputsHash = hashCanonical(outputs);
    const receipt: WorkflowRunReceipt = {
      runId,
      workflowKey: wf.workflow_key,
      buyer: input.buyer,
      inputFingerprint,
      success,
      outputs,
      stepReceipts,
      totalUsdc: totalUsdc.toFixed(6),
      startedAt,
      endedAt: Date.now(),
    };

    await this.persistRun(wf, receipt, outputsHash);
    return receipt;
  }

  /** Load the workflow row + parsed steps. */
  async loadWorkflow(workflowId: string): Promise<WorkflowRow> {
    const r = await this.pool.query<WorkflowRow>(
      `SELECT id, workflow_key, author_addr, sui_object_id, manifest_blob_id,
              name, description, steps, default_price_usdc, author_bps, platform_bps,
              published, signer, signature
         FROM cognitive_workflows
        WHERE id = $1`,
      [workflowId],
    );
    if (r.rowCount === 0) throw new WorkflowRunnerError('not found', 'NOT_FOUND');
    return r.rows[0];
  }

  /** Adjustment 2 (G2) — Sui-resident assertion. Throws when missing. */
  private assertSuiResident(wf: WorkflowRow): void {
    if (!wf.sui_object_id || wf.sui_object_id.length < 3) {
      throw new WorkflowRunnerError(
        `workflow ${wf.id} has no sui_object_id (Standard tier brains cannot run workflows)`,
        'NOT_SUI_RESIDENT',
      );
    }
  }

  private async runStep(
    step: WorkflowStep,
    stepInput: Record<string, unknown>,
    wf: WorkflowRow,
    _buyer: Hex,
  ): Promise<{
    output: unknown;
    amountUsdc: string;
    sellerAddress: string;
    txHash?: string;
    attestationHash?: string;
  }> {
    if (step.type === 'transform') {
      const out = applyTransform(step, stepInput);
      const att = this.attestStep ? await this.attestStep(step, out) : undefined;
      return { output: out, amountUsdc: '0', sellerAddress: '', attestationHash: att };
    }

    // procedure / skill / brain_ask all flow through the injected payStep.
    const paid = await this.payStep(step, stepInput);
    // Attestation is independent of payment — fire for ALL non-transform steps too.
    const attestationHash = paid.attestationHash
      ?? (this.attestStep ? await this.attestStep(step, paid.output) : undefined);
    if (paid.txHash) {
      try {
        await this.recordPaidCall({
          agentId: wf.author_addr,
          slug: `workflow:${wf.workflow_key}:${step.id}`,
          buyer: _buyer.toLowerCase(),
          amountUsdc: paid.amountUsdc,
          txHash: paid.txHash,
          network: 'sui-testnet',
          method: 'exact',
        });
      } catch (e: any) {
        logger.warn({ err: e?.message }, 'workflowRunner:ledger:write-failed');
      }
    }
    return { ...paid, attestationHash };
  }

  /**
   * Persist the run + bump counters in one transaction.
   * `cognitive_workflow_runs` insert + `cognitive_workflows` UPDATE.
   * Move-side `register_run` is the responsibility of the route handler
   * (it builds the Sui PTB); the runner records the off-chain mirror only.
   */
  private async persistRun(
    wf: WorkflowRow,
    receipt: WorkflowRunReceipt,
    outputsHash: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO cognitive_workflow_runs
           (workflow_id, workflow_key, buyer, input_fingerprint, success,
            step_receipts, outputs_hash, total_usdc, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, to_timestamp($9 / 1000.0),
                 to_timestamp($10 / 1000.0))`,
        [
          wf.id,
          wf.workflow_key,
          (receipt.buyer as string).toLowerCase(),
          receipt.inputFingerprint,
          receipt.success,
          JSON.stringify(receipt.stepReceipts),
          outputsHash,
          receipt.totalUsdc,
          receipt.startedAt,
          receipt.endedAt,
        ],
      );
      await client.query(
        `UPDATE cognitive_workflows
            SET runs = runs + 1,
                successful_runs = successful_runs + CASE WHEN $2 THEN 1 ELSE 0 END
          WHERE id = $1`,
        [wf.id, receipt.success],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

// ─── Pure helpers (no I/O — separated for unit tests) ──────────────────────

/** Kahn topo sort. Throws on cycle (caller pre-validates with isWorkflowDagValid). */
export function topoOrder(steps: WorkflowStep[]): string[] {
  const inDeg = new Map<string, number>();
  const out: string[] = [];
  for (const s of steps) inDeg.set(s.id, s.dependsOn.length);
  const queue: string[] = [];
  for (const [id, d] of inDeg) if (d === 0) queue.push(id);
  while (queue.length) {
    const cur = queue.shift()!;
    out.push(cur);
    for (const s of steps) {
      if (!s.dependsOn.includes(cur)) continue;
      const d = (inDeg.get(s.id) ?? 0) - 1;
      inDeg.set(s.id, d);
      if (d === 0) queue.push(s.id);
    }
  }
  if (out.length !== steps.length) throw new Error('topoOrder: cycle');
  return out;
}

/**
 * Resolve a step's input payload from upstream outputs.
 *
 * Strategy:
 *   - If step.dependsOn is empty: pass the run input verbatim.
 *   - If single dependency: pass that dependency's output as the input.
 *   - If multiple: merge under their step ids — `{ stepA: outA, stepB: outB }`.
 *
 * This is the deterministic JSONPath substitution the dossier specs in §6
 * — kept simple to avoid pulling a JSONPath library. Authors who need
 * fancier wiring should use a `transform` step.
 */
export function resolveStepInput(
  step: WorkflowStep,
  runInput: Record<string, unknown>,
  outputs: Record<string, unknown>,
): Record<string, unknown> {
  if (step.dependsOn.length === 0) return runInput;
  if (step.dependsOn.length === 1) {
    const dep = step.dependsOn[0];
    const out = outputs[dep];
    return typeof out === 'object' && out !== null ? (out as Record<string, unknown>) : { value: out };
  }
  const merged: Record<string, unknown> = {};
  for (const dep of step.dependsOn) merged[dep] = outputs[dep];
  return merged;
}

/** Pure deterministic transform handlers. Extend by clause when adding more. */
export function applyTransform(step: WorkflowStep, input: Record<string, unknown>): unknown {
  if (!step.transform) return input;
  const { fn, args } = step.transform;
  switch (fn) {
    case 'extract': {
      const path = (args.path as string) ?? '';
      return path
        .split('.')
        .filter(Boolean)
        .reduce<any>((acc, k) => (acc == null ? acc : acc[k]), input);
    }
    case 'filter': {
      const arr = (input as any).items;
      if (!Array.isArray(arr)) return [];
      const key = (args.key as string) ?? '';
      const value = args.value;
      return arr.filter((it) => (it as any)?.[key] === value);
    }
    case 'merge':
      return { ...input, ...(args.with as Record<string, unknown> | undefined) };
    case 'split': {
      const sep = (args.separator as string) ?? '\n';
      const text = (input as any).text ?? '';
      return typeof text === 'string' ? text.split(sep) : [];
    }
    default:
      return input;
  }
}

/** sha256 of canonical-JSON stringification (sorted keys, deterministic). */
export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}
