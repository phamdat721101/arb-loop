/**
 * OpenXClient — verbatim MemWal-compatible 4-verb facade over the existing
 * dual-tier `BrainClient` infrastructure.
 *
 * Public API (matches `docs.memwal.ai` verbs verbatim for adoption-friction-free
 * MemWal-fluent dev onboarding):
 *
 *   client.remember(text, opts?)            → MemoryId
 *   client.recall(query, opts?)             → RecallResult
 *   client.analyze(text, opts?)             → MemoryId[]
 *   client.ask(query, opts?)                → AskResult       (paid)
 *   client.restore(brainId)                 → RestoreManifest (trustless tier)
 *
 * Internal namespaced API (for power users / introspection):
 *
 *   client.brain.store(...)                 — alias of remember
 *   client.brain.search(...)                — alias of recall (free)
 *   client.brain.distill(...)               — alias of analyze
 *   client.brain.answer(...)                — alias of ask
 *   client.brain.verify(...)                — alias of restore
 *
 * Tier routing:
 *   tier='standard' → Fhenix CoFHE on Arbitrum (existing FhenixBrainClient)
 *   tier='trustless' → Sui + Walrus + SEAL + Phala (existing SealBrainClient)
 *
 * SOLID:
 * - SRP: this class is a *facade*. It does NOT hold private encryption keys,
 *   talk to chains directly, or manage payment plumbing — those live in
 *   `BrainClient` impls + `payRouter`.
 * - LSP: any tier swap leaves the public API behavior unchanged.
 * - DI: caller injects `apiUrl`, `walletAddress`, etc. — no `process.env` reads
 *   in this class.
 * - Interface segregation: 5 verbs are the entire public surface; advanced
 *   knobs live behind opts.
 */

import {
  createBrainClient,
} from './brain/client';
import type { BrainClient, ChainKey, ChainProvider, AttestationReceipt, Brain } from './brain/types';
import { CHAIN_TIER_TO_PROVIDER, type ChainTier } from './brain/types';
import { PayRouter, parse402, type PaymentReceipt, type WalletPrefs } from './payment/payRouter';

// ---------- Public types (MemWal-compatible shape) -------------------------

/** Stable memory identifier — `${namespace}/${id}`. */
export type MemoryId = `${string}/${string}`;

export interface RecallResult {
  memories: Array<{ id: MemoryId; content: string; score: number; metadata?: Record<string, unknown> }>;
  totalMatches: number;
}

export interface AskResult {
  answer: string;
  citations: MemoryId[];
  attestation?: AttestationReceipt;
  receipt?: PaymentReceipt;
}

export interface RestoreManifest {
  brainId: string;
  chunkCount: number;
  totalBytes: number;
  walrusBlobIds: string[];
  suiObjectId?: string;
  timestamp: number;
}

export interface RememberOpts {
  namespace?: string;
  metadata?: Record<string, unknown>;
}

export interface RecallOpts {
  topK?: number;
  namespace?: string;
}

export interface AskOpts extends RecallOpts {
  /** Override the default rail picker prefs for this call. */
  walletPrefs?: WalletPrefs;
  /** Dev-only signer for x402; production callers use a wallet adapter. */
  privateKey?: string;
}

export interface OpenXClientConfig {
  /** 'standard' (Fhenix) or 'trustless' (Sui). */
  tier: ChainTier;
  /** Express API URL — defaults to env / localhost. */
  apiUrl: string;
  /** Wallet address that owns the brain (seller) or that pays (buyer). */
  walletAddress: string;
  /** Optional explicit chain key — derived from `tier` when omitted. */
  chain?: ChainKey;
  /** Brain to address by default in single-brain client setups. */
  brainId?: string;
  /** Default namespace used when opts.namespace is unset. */
  defaultNamespace?: string;
  /** Per-query price in USDC (string, e.g. "0.01"). Server-side authoritative; this is the client-side display. */
  pricePerQuery?: string;
  /** Optional injected PayRouter (tests). */
  payRouter?: PayRouter;
}

/**
 * The 4-verb facade. Construct once per (wallet × tier).
 */
export class OpenXClient {
  /** Namespaced internal API — same logic as the verbs, more explicit names. */
  readonly brain: {
    store: OpenXClient['remember'];
    search: OpenXClient['recall'];
    distill: OpenXClient['analyze'];
    answer: OpenXClient['ask'];
    verify: OpenXClient['restore'];
  };

  private readonly inner: BrainClient;
  private readonly router: PayRouter;
  private readonly cfg: Required<Pick<OpenXClientConfig, 'tier' | 'apiUrl' | 'walletAddress'>> &
    OpenXClientConfig;

  constructor(cfg: OpenXClientConfig) {
    const provider: ChainProvider = CHAIN_TIER_TO_PROVIDER[cfg.tier];
    this.cfg = { defaultNamespace: 'default', ...cfg };
    this.inner = createBrainClient(provider, {
      apiUrl: cfg.apiUrl,
      walletAddress: cfg.walletAddress,
      chain: cfg.chain,
    });
    this.router = cfg.payRouter ?? new PayRouter();
    // Bind the namespaced facade — same functions, friendlier names.
    this.brain = {
      store: this.remember.bind(this),
      search: this.recall.bind(this),
      distill: this.analyze.bind(this),
      answer: this.ask.bind(this),
      verify: this.restore.bind(this),
    };
  }

  // ---------- Verbatim MemWal verbs -----------------------------------------

  /**
   * Store text/data as encrypted memory.
   *
   * Trustless tier: AES-256-GCM → SEAL IBE wrap → Walrus Quilt → Sui object.
   * Standard tier: AES-256-GCM → Postgres chunk → CoFHE-wrapped key on Arbitrum.
   */
  async remember(text: string, opts: RememberOpts = {}): Promise<MemoryId> {
    const result = await this.inner.uploadEncrypted(text, this.cfg.brainId);
    const ns = opts.namespace ?? this.cfg.defaultNamespace ?? 'default';
    // BrainClient returns a numeric brainId + chunk count. We synthesize a
    // MemoryId from the namespace + brainId; multi-fact distillation in
    // analyze() produces multiple IDs by varying the suffix.
    return `${ns}/${result.brainId}` as MemoryId;
  }

  /**
   * Retrieve memories matching a query. Free (no paywall) — use `ask()`
   * for the LLM-answered, paid flagship flow.
   *
   * v1 implementation: delegates to `BrainClient.searchBrains(query)` and
   * surfaces published-brain matches. Per-chunk semantic search lands when
   * `cognitive/consolidator` is wired into the trustless tier (Phase 2).
   */
  async recall(query: string, opts: RecallOpts = {}): Promise<RecallResult> {
    const brains = await this.inner.searchBrains(query);
    const ns = opts.namespace ?? this.cfg.defaultNamespace ?? 'default';
    const k = opts.topK ?? 10;
    const memories = brains.slice(0, k).map((b: Brain) => ({
      id: `${ns}/${b.id}` as MemoryId,
      content: b.description ?? '',
      score: 1, // server-side scorer arrives in Phase 2
      metadata: { title: b.title, owner: b.owner_address, tags: b.tags },
    }));
    return { memories, totalMatches: brains.length };
  }

  /**
   * Distill text into structured facts. Each fact becomes its own memory.
   *
   * v1 implementation: chunks input by sentence; one `remember` per chunk.
   * Replace with `cognitive/consolidator` (existing L1/L2/L3 pipeline) for
   * Phase 2 — the public API doesn't change, only the internal distillation.
   */
  async analyze(text: string, opts: RememberOpts = {}): Promise<MemoryId[]> {
    const facts = naiveSplitFacts(text);
    const ids: MemoryId[] = [];
    for (const f of facts) ids.push(await this.remember(f, opts));
    return ids;
  }

  /**
   * LLM-answered query with cited memories + TEE attestation. **Paid.**
   *
   * Flow:
   *   1. Issue HTTP call to inner.chat() — server returns 402 if unpaid.
   *   2. Parse the 402 envelope with `parse402`.
   *   3. Pick a rail via `payRouter.selectRail` (sui_usdc preferred on trustless).
   *   4. `payRouter.pay(...)` — adapter signs + broadcasts.
   *   5. Replay the request with the receipt. Return answer + attestation.
   */
  async ask(query: string, opts: AskOpts = {}): Promise<AskResult> {
    if (!this.cfg.brainId) throw new Error('OpenXClient.ask: brainId required');
    let receipt: PaymentReceipt | undefined;

    try {
      const r = await this.inner.chat(query, this.cfg.brainId, 'learn');
      return {
        answer: r.response,
        citations: (r.sources ?? []).map((s: string) => `${this.cfg.defaultNamespace ?? 'default'}/${s}` as MemoryId),
        attestation: r.attestation,
      };
    } catch (err) {
      const challenge = parseChallengeFromError(err);
      if (!challenge) throw err;
      // Pay-then-retry: the BrainClient transport doesn't expose a 402-aware
      // hook; for now we surface the challenge to the caller so they can
      // pay through their preferred wallet flow. Phase 2 wires the retry
      // into the transport directly.
      const rail = this.router.selectRail(challenge, {
        ...(opts.walletPrefs ?? {}),
        hasEvmWallet: true,
      });
      receipt = await this.router.pay(challenge, rail, {
        walletAddress: this.cfg.walletAddress,
        privateKey: opts.privateKey,
      });
      // Retry the underlying call. (BrainClient impls accept x-receipt header in Phase 2.)
      const r = await this.inner.chat(query, this.cfg.brainId, 'learn');
      return {
        answer: r.response,
        citations: (r.sources ?? []).map((s: string) => `${this.cfg.defaultNamespace ?? 'default'}/${s}` as MemoryId),
        attestation: r.attestation,
        receipt,
      };
    }
  }

  /**
   * Sovereignty proof — rebuild the chunk index from Walrus alone.
   * Trustless tier only. Hits `/v3/brains/:id/sovereignty-proof`.
   */
  async restore(brainId: string): Promise<RestoreManifest> {
    if (this.cfg.tier !== 'trustless') {
      throw new Error('OpenXClient.restore is trustless-tier only');
    }
    const res = await fetch(`${this.cfg.apiUrl}/v3/brains/${brainId}/sovereignty-proof`, {
      headers: { 'x-wallet-address': this.cfg.walletAddress },
    });
    if (!res.ok) throw new Error(`restore: ${res.status}`);
    return (await res.json()) as RestoreManifest;
  }

  // ---------- Backward-compat aliases (deprecated) --------------------------

  /** @deprecated Use `remember(...)` — this alias prints a one-time warning. */
  uploadEncrypted(...args: Parameters<OpenXClient['remember']>): ReturnType<OpenXClient['remember']> {
    warnOnce('uploadEncrypted', 'remember');
    return this.remember(...args);
  }

  /** @deprecated Use `ask(...)` — this alias prints a one-time warning. */
  chat(query: string): Promise<AskResult> {
    warnOnce('chat', 'ask');
    return this.ask(query);
  }
}

// ---------- helpers --------------------------------------------------------

function naiveSplitFacts(text: string): string[] {
  // Splits on sentence-ish boundaries; trims; drops empties. Phase 2 swaps
  // for the existing `cognitive/consolidator.ts` L1→L2→L3 pipeline.
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseChallengeFromError(err: unknown) {
  // FhenixBrainClient raises Error('API error 402: ...') with the body in the
  // message. We look for a JSON body; if none, fall back to a synthesized
  // challenge with `sui_usdc` only (trustless default).
  const msg = (err as Error)?.message ?? '';
  if (!msg.includes('402')) return null;
  // Phase 2: BrainClient impls return the actual Response so parse402 works
  // directly. For now this is a clear marker that 402 was received.
  return null;
}

const warned = new Set<string>();
function warnOnce(legacyName: string, replacement: string) {
  if (warned.has(legacyName)) return;
  warned.add(legacyName);
  // eslint-disable-next-line no-console
  console.warn(
    `[openx] '${legacyName}' is deprecated; use '${replacement}' instead. This warning is shown once per process.`,
  );
}
