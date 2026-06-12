/**
 * Cognitive Memory v1 — type contracts (no runtime besides sign/verify helpers).
 *
 * Three layers, one file (SOLID-SRP at the module level): types.ts owns
 * shapes + the lightweight sign/verify glue; keyWrap.ts owns key derivation;
 * consolidator.ts owns the L1→L2→L3 promotion logic.
 *
 * Includes a self-contained canonical-JSON signer so this module has zero
 * cross-module dependencies inside the SDK.
 */

import { recoverMessageAddress, type Hex } from 'viem';

// ─── Canonical-JSON signing primitives (self-contained, no cross-imports) ────

/** Recursive deterministic stringifier with sorted keys. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/** The exact bytes a signer commits to (signature field is stripped). */
function buildSigningMessage<T extends { signer: Hex }>(unsigned: T): string {
  const { signature: _drop, ...body } = unsigned as { signature?: unknown } & T;
  return canonicalize({ ...body, signer: (body.signer as string).toLowerCase() });
}

// ─── TTLs (single source of truth) ──────────────────────────────────────────

export const L1_TTL_SEC = 60 * 60 * 24 * 7;
export const L2_TTL_SEC = 60 * 60 * 24 * 30;
export const L3_TTL_SEC = 60 * 60 * 24 * 90;
export const L4_TTL_SEC = 60 * 60 * 24 * 180; // workflows live longer
export const L5_TTL_SEC = 60 * 60 * 24 * 365; // reflective traces are licensed assets

// ─── Layer key ──────────────────────────────────────────────────────────────

export const COGNITIVE_LAYERS = ['L1', 'L2', 'L3'] as const;
export type CognitiveLayer = typeof COGNITIVE_LAYERS[number];

/** L1→L5 layer key (additive — does not break the L1/L2/L3 union). */
export const COGNITIVE_LAYERS_V2 = ['L1', 'L2', 'L3', 'L4', 'L5'] as const;
export type CognitiveLayerV2 = typeof COGNITIVE_LAYERS_V2[number];

/** Tier discriminator — used by promoteToWorkflow tier-guard (G3 isolation). */
export type CognitiveTier = 'standard' | 'trustless';

// ─── L1 Episode ─────────────────────────────────────────────────────────────

/** L1 episode — one paid agent interaction. Plaintext shape (encrypted at rest). */
export interface Episode {
  /** Free-text body — chat turn, tool call, or decision summary. */
  body: string;
  /** Topic hash (16-hex), used to group facts/decisions by topic. */
  topic: string;
  /** Address of the agent that triggered this episode. */
  agentId: Hex;
  /** Brain id this episode is associated with. */
  brainId: number;
  /** Session id — groups consecutive turns of the same conversation. */
  sessionId: string;
  /** Unix ms. */
  createdAt: number;
}

// ─── L2 SemanticFact ────────────────────────────────────────────────────────

export const FACT_TYPES = ['fact', 'preference', 'relation', 'profile', 'event'] as const;
export type FactType = typeof FACT_TYPES[number];

/** L2 fact — atomic claim derived from ≥3 corroborating L1 episodes. */
export interface SemanticFact {
  fact: string;
  factType: FactType;
  topic: string;
  /** 0..100. */
  confidence: number;
  /** L1 episode ids this fact was derived from (≥3). */
  derivedFrom: string[];
  /** Optional grouping key for the L3 promoter. */
  procedureKey?: string;
  /** Brain owner wallet. */
  signer: Hex;
  /** EIP-191 signature over canonicalize(body without signature). */
  signature: Hex;
  /** Unix ms. */
  derivedAt: number;
}

// ─── L3 ProceduralBundle ────────────────────────────────────────────────────

export interface CognitiveBundleStep {
  name: string;
  description: string;
}

/** L3 bundle — runnable, signed, encrypted manifest. Phala TEE executes it. */
export interface ProceduralBundle {
  procedureKey: string;
  manifest: {
    steps: CognitiveBundleStep[];
    /** JSON-Schema-like shape — public so buyers know what to send. */
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
  };
  /** L2 fact ids that justified the promotion (≥5). */
  derivedFrom: string[];
  /** USDC string, e.g. "0.05". Phase 2 monetization hook. */
  defaultPriceUsdc: string;
  signer: Hex;
  signature: Hex;
  createdAt: number;
}

// ─── Sign / verify (reuse memory/serialize.canonicalize via buildSigningMessage) ─

/** Errors thrown by sign/verify — typed for caller pattern-matching. */
export class CognitiveSchemaError extends Error {
  constructor(
    message: string,
    public readonly code: 'INVALID_SIGNATURE' | 'BAD_PAYLOAD',
  ) {
    super(message);
    this.name = 'CognitiveSchemaError';
  }
}

/**
 * Build the canonical signing message for a SemanticFact. Strips signature
 * field so write-side and read-side reconstruct the exact same bytes.
 */
export function factSigningMessage(fact: Omit<SemanticFact, 'signature'> & { signature?: Hex }): string {
  return buildSigningMessage(fact as { signer: Hex });
}

/** Verify a SemanticFact's signature against its declared signer. */
export async function verifyFact(fact: SemanticFact): Promise<boolean> {
  try {
    const msg = factSigningMessage(fact);
    const recovered = await recoverMessageAddress({ message: msg, signature: fact.signature });
    return recovered.toLowerCase() === fact.signer.toLowerCase();
  } catch {
    return false;
  }
}

/** Build the canonical signing message for a ProceduralBundle. */
export function bundleSigningMessage(b: Omit<ProceduralBundle, 'signature'> & { signature?: Hex }): string {
  return buildSigningMessage(b as { signer: Hex });
}

/** Verify a ProceduralBundle's signature against its declared signer. */
export async function verifyBundle(b: ProceduralBundle): Promise<boolean> {
  try {
    const msg = bundleSigningMessage(b);
    const recovered = await recoverMessageAddress({ message: msg, signature: b.signature });
    return recovered.toLowerCase() === b.signer.toLowerCase();
  } catch {
    return false;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// L4 / L5 / Skill — additive types for the tri-marketplace pivot (2026-06-04)
// ═══════════════════════════════════════════════════════════════════════════
//
// Three new sellable product layers share the L1/L2/L3 sign/verify convention:
//   - L4 Workflow      : runnable signed DAG of steps  (per-execution)
//   - L5 ReflectiveTrace: success/failure rule license (per-license)
//   - Skill            : standalone single-tool product (per-call)
//
// Tier-guard (G3 isolation): consolidator's `promoteToWorkflow` only operates
// on bundles whose owner brain is on the trustless tier. The tier flag is
// passed at the input boundary (see consolidator.ts) so existing
// ProceduralBundle stays untouched.

// ─── L4 Workflow ───────────────────────────────────────────────────────────

export type WorkflowStepType = 'procedure' | 'skill' | 'brain_ask' | 'transform';
export type TransformFn = 'extract' | 'filter' | 'merge' | 'split';

export interface WorkflowStep {
  /** Unique within the DAG. Kebab-case recommended. */
  id: string;
  name: string;
  type: WorkflowStepType;
  /** L3 procedural reference. */
  procedureRef?: { brainId: number; procedureKey: string };
  /** External or internal paid skill. */
  skillRef?: { url: string; pricingMode: 'per-call'; priceUsdc: string };
  /** Paid OpenX brain query. */
  brainAskRef?: { brainId: number; queryTemplate: string; priceUsdc: string };
  /** Pure deterministic transform (no payment). */
  transform?: { fn: TransformFn; args: Record<string, unknown> };
  /** Step ids this one waits for. Empty = root. */
  dependsOn: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface Workflow {
  workflowKey: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  /** L3 procedural ids (≥3) when promoted; or `[]` when author-curated. */
  derivedFrom: string[];
  defaultPriceUsdc: string;
  /** 9500 = 95% to author + sellers; 500 = 5% platform. Sum = 10_000. */
  revenueSplit: { authorBps: number; platformBps: number };
  signer: Hex;
  signature: Hex;
  createdAt: number;
}

/** Pre-signing candidate emitted by `promoteToWorkflow`. */
export type WorkflowCandidate = Omit<Workflow, 'signer' | 'signature'>;

export interface WorkflowStepReceipt {
  stepId: string;
  outputHash: string;        // sha256 of canonical output JSON
  attestationHash?: string;  // Phala TEE attestation when applicable
  paymentReceiptTxHash?: string;
  amountUsdc: string;        // "0.00" for transform steps
  sellerAddress: string;     // 0x… (zero address for transforms)
  startedAt: number;
  endedAt: number;
  success: boolean;
  failureMode?: string;
}

export interface WorkflowRunReceipt {
  runId: string;
  workflowKey: string;
  buyer: Hex;
  /** sha256(canonical(input)) — used by L5 promotion to fingerprint runs. */
  inputFingerprint: string;
  success: boolean;
  outputs: Record<string, unknown>;       // stepId → output payload
  stepReceipts: WorkflowStepReceipt[];
  totalUsdc: string;
  startedAt: number;
  endedAt: number;
}

export function workflowSigningMessage(
  w: Omit<Workflow, 'signature'> & { signature?: Hex },
): string {
  return buildSigningMessage(w as { signer: Hex });
}

export async function verifyWorkflow(w: Workflow): Promise<boolean> {
  try {
    const msg = workflowSigningMessage(w);
    const recovered = await recoverMessageAddress({ message: msg, signature: w.signature });
    return recovered.toLowerCase() === w.signer.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * DAG validity helper — used by both publish path (reject bad authoring)
 * and runner path (defense in depth). O(V+E) Kahn cycle detection.
 */
export function isWorkflowDagValid(
  steps: WorkflowStep[],
): { ok: true } | { ok: false; reason: string } {
  if (steps.length === 0) return { ok: false, reason: 'empty-dag' };
  const ids = new Set(steps.map((s) => s.id));
  if (ids.size !== steps.length) return { ok: false, reason: 'duplicate-step-id' };
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) return { ok: false, reason: `unknown-dependency:${dep}` };
    }
  }
  // Kahn topo sort — if not all visited, there's a cycle.
  const inDeg = new Map<string, number>();
  for (const s of steps) inDeg.set(s.id, s.dependsOn.length);
  const queue: string[] = [];
  for (const [id, d] of inDeg) if (d === 0) queue.push(id);
  let visited = 0;
  while (queue.length) {
    const cur = queue.shift()!;
    visited++;
    for (const s of steps) {
      if (!s.dependsOn.includes(cur)) continue;
      const d = (inDeg.get(s.id) ?? 0) - 1;
      inDeg.set(s.id, d);
      if (d === 0) queue.push(s.id);
    }
  }
  if (visited !== steps.length) return { ok: false, reason: 'cycle-detected' };
  return { ok: true };
}

// ─── L5 ReflectiveTrace ────────────────────────────────────────────────────

export interface ReflectiveObservation {
  runId: string;
  success: boolean;
  failureMode?: string;
  inputFingerprint: string;
  /** 0-100; from Phala TEE judge or human eval. */
  outputQualityScore: number;
}

export interface DerivedRule {
  rule: string;
  /** 0-100; |Pearson correlation| × 100 between dimension and success. */
  confidence: number;
  evidenceRunIds: string[];
}

export interface ReflectiveTrace {
  traceKey: string;
  workflowKey: string;
  observations: ReflectiveObservation[];
  derivedRules: DerivedRule[];
  derivedFrom: string[];                 // L4 run ids
  defaultLicensePriceUsdc: string;
  signer: Hex;
  signature: Hex;
  createdAt: number;
}

export type ReflectiveCandidate = Omit<ReflectiveTrace, 'signer' | 'signature'>;

export function reflectiveSigningMessage(
  r: Omit<ReflectiveTrace, 'signature'> & { signature?: Hex },
): string {
  return buildSigningMessage(r as { signer: Hex });
}

export async function verifyReflective(r: ReflectiveTrace): Promise<boolean> {
  try {
    const msg = reflectiveSigningMessage(r);
    const recovered = await recoverMessageAddress({ message: msg, signature: r.signature });
    return recovered.toLowerCase() === r.signer.toLowerCase();
  } catch {
    return false;
  }
}

// ─── Skill (Sui marketplace product type — distinct from packages/sdk/src/skill/) ──

export interface SkillManifest {
  skillKey: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /** internal=server-side handler in /v3/skills/internal/<ref>; external=arbitrary URL. */
  endpoint: { type: 'internal' | 'external'; ref: string };
}

export interface Skill {
  skillKey: string;
  manifest: SkillManifest;
  defaultPriceUsdc: string;
  /** Optional cite-to-extend lineage (L2 facts that justified publishing). */
  derivedFrom?: string[];
  signer: Hex;
  signature: Hex;
  createdAt: number;
}

export function skillSigningMessage(
  s: Omit<Skill, 'signature'> & { signature?: Hex },
): string {
  return buildSigningMessage(s as { signer: Hex });
}

export async function verifySkill(s: Skill): Promise<boolean> {
  try {
    const msg = skillSigningMessage(s);
    const recovered = await recoverMessageAddress({ message: msg, signature: s.signature });
    return recovered.toLowerCase() === s.signer.toLowerCase();
  } catch {
    return false;
  }
}
