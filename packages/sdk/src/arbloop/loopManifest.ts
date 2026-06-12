/**
 * loopManifest.ts — Zod schema + types for arb-loop manifest YAML.
 *
 * SOLID:
 *   - SRP: schema definition only. No I/O, no validation side-effects.
 *   - DIP: callers (api, frontend, scripts) consume `parseLoopManifest()`; the
 *     internal Zod shape is an implementation detail.
 */

import { z } from 'zod';

// ─── Primitive types ─────────────────────────────────────────────────────

export const HexString32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be 32-byte hex');
export const HexString20 = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be 20-byte hex');
export const ArweaveTxId = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'must be 43-char Arweave tx-id');

export type EigenDaBlobRef = z.infer<typeof HexString32>;     // KZG commitment
export type ArweaveBundleRef = z.infer<typeof ArweaveTxId>;
export type EasAttestationUid = z.infer<typeof HexString32>;

// ─── Manifest sub-schemas ────────────────────────────────────────────────

const SellerAgentRef = z.object({
  agent_registry: HexString20,
  agent_id: z.number().int().nonnegative(),
});

const StopCondition = z.object({
  predicate: z.string().min(1).max(2000),
  fallback_max_iterations: z.number().int().positive().max(50),
});

const Backend = z.enum([
  'phala-tee',
  'aizel',
  'venice-tee',
  'venice-e2ee',
  'venice-anonymized',
  'bedrock',
]);

const InferenceConfig = z.object({
  backend: Backend,
  model_id: z.string().min(1).max(120),
  privacy_mode: z.enum(['tee', 'e2ee', 'anonymized', 'plain']).default('tee'),
  streaming: z.boolean().default(true),
  fallback_backends: z
    .array(z.object({ backend: Backend, model_id: z.string().min(1) }))
    .max(3)
    .default([]),
  backend_options: z.record(z.unknown()).optional(),
});

const MemoryRead = z.object({
  level: z.enum(['L1', 'L2', 'L3', 'L4']),
  window: z.number().int().positive().max(500).optional(),
  filter: z.string().max(500).optional(),
});

const MemoryWrite = z.object({
  level: z.enum(['L1', 'L2', 'L4']),
  mode: z.enum(['append', 'pattern_extract']).default('append'),
});

const MemoryConfig = z.object({
  namespace: z.string().min(1).max(120),
  read: z.array(MemoryRead).default([]),
  write: z.array(MemoryWrite).default([]),
  encryption: z
    .object({
      method: z.literal('lit_pkp_threshold_aes256gcm'),
      permit_strategy: z.enum(['job_scope', 'agent_scope', 'global']),
      fallback: z.enum(['client_ecdh', 'none']).default('client_ecdh'),
    })
    .default({
      method: 'lit_pkp_threshold_aes256gcm',
      permit_strategy: 'job_scope',
      fallback: 'client_ecdh',
    }),
});

const Tool = z.object({
  id: z.string().min(1).max(120),
  options: z.record(z.unknown()).optional(),
});

const SplitRecipient = z.object({
  to: z.enum(['seller', 'compute', 'eigenda', 'arweave', 'lit', 'platform']),
  bps: z.number().int().min(0).max(10000),
});

const PricingConfig = z
  .object({
    per_iter_micro_usdc: z.number().int().positive(),
    splits: z
      .array(SplitRecipient)
      .min(1)
      .max(6)
      .refine(
        (s) => s.reduce((sum, x) => sum + x.bps, 0) === 10000,
        'splits bps must sum to 10000',
      )
      .refine(
        (s) => new Set(s.map((x) => x.to)).size === s.length,
        'duplicate recipient',
      ),
    cost_tiers: z
      .array(
        z.object({
          condition: z.string().min(1).max(500),
          multiplier: z.number().min(0.1).max(10),
        }),
      )
      .max(5)
      .optional(),
  })
  .strict();

const Checkpoint = z
  .object({
    after_iter: z.number().int().positive().max(50),
    require_buyer_approval: z.boolean().default(true),
    timeout_ms: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000),
    on_timeout: z.enum(['pause', 'cancel']).default('pause'),
  })
  .strict();

const Iteration = z
  .object({
    inference: InferenceConfig,
    memory: MemoryConfig,
    tools: z.array(Tool).max(20).default([]),
    pricing: PricingConfig,
    storage_tier: z.enum(['hot', 'cold']).default('hot'),
  })
  .strict();

const Reflective = z
  .object({
    on_complete: z
      .object({
        write_to_l5: z.string().min(1).max(2000),
      })
      .optional(),
  })
  .strict();

const Metadata = z
  .object({
    estimated_iters: z.number().int().positive().optional(),
    estimated_seconds_per_iter: z.number().int().positive().optional(),
    estimated_total_cost_usd: z.number().nonnegative().optional(),
    category: z
      .enum(['research', 'content', 'code', 'support', 'analysis', 'monitoring', 'other'])
      .default('other'),
    tags: z.array(z.string().min(1).max(40)).max(10).default([]),
    preserve_l1_to_eigenda: z.boolean().default(false),
  })
  .strict();

// ─── Top-level manifest schema ───────────────────────────────────────────

export const LoopManifestSchema = z
  .object({
    kind: z.literal('loop'),
    spec_version: z.literal(1),
    target_chain: z.enum(['arbitrum-sepolia', 'arbitrum-one']),
    title: z.string().min(3).max(80),
    description: z.string().min(10).max(500),
    seller_agent_ref: SellerAgentRef,
    stop_condition: StopCondition,
    iteration: Iteration,
    checkpoints: z.array(Checkpoint).max(10).default([]),
    reflective: Reflective.default({}),
    metadata: Metadata.default({ category: 'other', tags: [] }),
  })
  .strict();

export type LoopManifest = z.infer<typeof LoopManifestSchema>;

// ─── Public parse helpers ────────────────────────────────────────────────

/**
 * Parse + validate a YAML/JSON object as a LoopManifest. Throws on schema
 * violation; returns a fully-typed manifest on success.
 */
export function parseLoopManifest(input: unknown): LoopManifest {
  return LoopManifestSchema.parse(input);
}

/**
 * Soft validation — returns a Zod SafeParseReturnType so callers can render
 * structured errors (e.g. wizard form-level validation).
 */
export function safeParseLoopManifest(input: unknown) {
  return LoopManifestSchema.safeParse(input);
}
