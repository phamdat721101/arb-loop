/**
 * cognitiveMemoryService — server-side orchestration for L1/L2/L3.
 *
 * SOLID:
 * - SRP: this module owns Postgres I/O + AES-GCM crypto for the 3 cognitive
 *   layers. Pure consolidation logic stays in `@fhe-ai-context/sdk`.
 * - DIP: route handlers depend on this service interface, not on `pg` or
 *   `crypto` directly.
 * - OCP: a Phase 2 monetization layer wraps `consolidateAndWrite`'s emitted
 *   events in x402 settlement without touching the function bodies here.
 *
 * Phase 1 trust posture:
 *   - L1 episode payload: AES-256-GCM with key = HKDF(KEK, owner+layer).
 *   - L2 fact: same; signed by the platform Memory-Agent (PLATFORM_SIGNER_PRIVATE_KEY)
 *     on the owner's behalf — semantics: "OpenX attests this fact was
 *     derived from owner X's L1 episodes". Phase 2 can upgrade to owner-signed.
 *   - L3 bundle: same encryption + same signing posture.
 *   - All decrypt paths run inside this process; plaintext never leaves the
 *     server boundary except as a chat reply or a TEE-attested skill run output.
 */

import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { pool } from '../db';
import { logger } from '../lib';
import { deriveLayerKey } from '@fhe-ai-context/sdk/dist/cognitive/keyWrap';
import {
  COGNITIVE_LAYERS as _COGNITIVE_LAYERS,
  L1_TTL_SEC,
  L2_TTL_SEC,
  L3_TTL_SEC,
  consolidate,
  promoteToProcedural,
  factSigningMessage,
  bundleSigningMessage,
  encryptContentWithKey,
  decryptContent,
  type CognitiveLayer,
  type Episode,
  type SemanticFact,
  type ProceduralBundle,
  type ConsolidationCandidate,
  type PromotionCandidate,
} from '@fhe-ai-context/sdk';

// ─── Lazy signer — PLATFORM_SIGNER_PRIVATE_KEY (backward-compat: ARKIV_BACKEND_PRIVATE_KEY) ─

let _signerAccount: ReturnType<typeof privateKeyToAccount> | null = null;
function getSigner() {
  if (_signerAccount) return _signerAccount;
  const pk = (process.env.PLATFORM_SIGNER_PRIVATE_KEY ??
    process.env.ARKIV_BACKEND_PRIVATE_KEY) as Hex | undefined;
  if (!pk) {
    throw Object.assign(
      new Error('PLATFORM_SIGNER_PRIVATE_KEY missing — cognitive service cannot sign'),
      { status: 503 },
    );
  }
  _signerAccount = privateKeyToAccount(pk);
  return _signerAccount;
}

// ─── Crypto helpers (AES-GCM wrapping the canonical JSON) ───────────────────

function encryptJson(obj: unknown, ownerAddr: string, layer: CognitiveLayer): Buffer {
  const key = deriveLayerKey(ownerAddr, layer);
  return encryptContentWithKey(JSON.stringify(obj), key).encrypted;
}

function decryptJson<T>(ct: Buffer, ownerAddr: string, layer: CognitiveLayer): T {
  const key = deriveLayerKey(ownerAddr, layer);
  return JSON.parse(decryptContent(ct, key)) as T;
}

function lower(addr: string): string {
  return String(addr).toLowerCase();
}

// ─── L1: write ─────────────────────────────────────────────────────────────

export interface WriteEpisodeArgs {
  ownerAddr: string;
  agentId: string;
  brainId: number | null;
  topic: string;
  sessionId: string;
  body: string;
}

export async function writeEpisode(
  args: WriteEpisodeArgs,
): Promise<{ id: string; createdAt: string }> {
  const owner = lower(args.ownerAddr);
  const episode: Episode = {
    body: args.body,
    topic: args.topic,
    agentId: lower(args.agentId) as Hex,
    brainId: args.brainId ?? 0,
    sessionId: args.sessionId,
    createdAt: Date.now(),
  };
  const ct = encryptJson(episode, owner, 'L1');

  const r = await pool.query(
    `INSERT INTO cognitive_episodes (owner_addr, agent_id, brain_id, topic, session_id, payload_ct, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::interval)
     RETURNING id, created_at`,
    [owner, lower(args.agentId), args.brainId, args.topic, args.sessionId, ct, L1_TTL_SEC],
  );
  logger.info(
    { episodeId: r.rows[0].id, owner, agent: lower(args.agentId), topic: args.topic, brainId: args.brainId },
    'cognitive:l1:write',
  );
  return { id: r.rows[0].id, createdAt: r.rows[0].created_at };
}

// ─── L1: read (server-side decrypt — used by consolidator) ─────────────────

interface RawEpisodeRow {
  id: string;
  payload_ct: Buffer;
  topic: string;
  agent_id: string;
  brain_id: number | null;
  session_id: string;
  created_at: Date;
}

async function loadRecentEpisodes(
  owner: string,
  windowSec = 24 * 60 * 60,
  limit = 200,
): Promise<Array<Episode & { id: string }>> {
  const r = await pool.query<RawEpisodeRow>(
    `SELECT id, payload_ct, topic, agent_id, brain_id, session_id, created_at
       FROM cognitive_episodes
      WHERE owner_addr = $1
        AND created_at > now() - ($2 || ' seconds')::interval
      ORDER BY created_at DESC
      LIMIT $3`,
    [owner, windowSec, limit],
  );
  const out: Array<Episode & { id: string }> = [];
  for (const row of r.rows) {
    try {
      const ep = decryptJson<Episode>(row.payload_ct, owner, 'L1');
      out.push({ ...ep, id: row.id });
    } catch (err) {
      logger.warn({ episodeId: row.id, err: (err as Error).message }, 'cognitive:l1:decrypt:failed');
    }
  }
  return out;
}

// ─── L2: consolidate + write (Task 6 — wired into chat handler) ────────────

export interface ConsolidationResult {
  newFacts: number;
  newBundles: number;
}

/**
 * Run consolidation + L3 promotion for an owner. Idempotent: existing facts
 * are skipped via the unique (owner_addr, fact_hash) index; existing bundles
 * via (owner_addr, procedure_key). Safe to call after every L1 write.
 *
 * Errors are swallowed at the row level (see logger.warn) — never crashes
 * the caller's chat response. The function only throws on KEK-missing or
 * Postgres-down errors that would indicate a deployment-level problem.
 */
export async function consolidateAndWrite(ownerAddr: string): Promise<ConsolidationResult> {
  const owner = lower(ownerAddr);

  const episodes = await loadRecentEpisodes(owner);
  if (episodes.length < 3) return { newFacts: 0, newBundles: 0 };

  const existingFactHashes = await loadExistingFactHashes(owner);
  const candidates = consolidate({ episodes, existingFactHashes });
  if (candidates.length === 0) return { newFacts: 0, newBundles: 0 };

  let newFacts = 0;
  for (const c of candidates) {
    try {
      await writeFact(owner, c);
      newFacts++;
    } catch (err) {
      const e = err as { code?: string; message: string };
      // 23505 = unique_violation (race with a parallel consolidation pass) —
      // expected and benign; skip silently.
      if (e.code !== '23505') {
        logger.warn({ owner, factHash: c.factHash, err: e.message }, 'cognitive:l2:write:failed');
      }
    }
  }

  // Cascade into L3 promotion if any new facts have a procedureKey.
  const newBundles = await promoteToProceduralAndWrite(owner);

  return { newFacts, newBundles };
}

async function loadExistingFactHashes(owner: string): Promise<Set<string>> {
  const r = await pool.query<{ fact_hash: string }>(
    `SELECT fact_hash FROM cognitive_facts WHERE owner_addr = $1`,
    [owner],
  );
  return new Set(r.rows.map((row) => row.fact_hash));
}

async function writeFact(owner: string, c: ConsolidationCandidate): Promise<void> {
  const signer = getSigner();
  const fact: SemanticFact = {
    fact: c.fact,
    factType: c.factType,
    topic: c.topic,
    confidence: c.confidence,
    derivedFrom: c.derivedFrom,
    procedureKey: c.procedureKey,
    derivedAt: c.derivedAt,
    signer: signer.address as Hex,
    signature: '0x' as Hex, // placeholder — populated below
  };
  const message = factSigningMessage(fact);
  fact.signature = (await signer.signMessage({ message })) as Hex;
  const ct = encryptJson(fact, owner, 'L2');

  await pool.query(
    `INSERT INTO cognitive_facts
       (owner_addr, brain_id, topic, fact_type, confidence, derived_from, payload_ct,
        procedure_key, fact_hash, signer, signature, expires_at)
     VALUES ($1, NULL, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, now() + ($11 || ' seconds')::interval)`,
    [
      owner,
      c.topic,
      c.factType,
      c.confidence,
      JSON.stringify(c.derivedFrom),
      ct,
      c.procedureKey ?? null,
      c.factHash,
      lower(signer.address),
      fact.signature,
      L2_TTL_SEC,
    ],
  );
  logger.info(
    { owner, topic: c.topic, factType: c.factType, derivedFromN: c.derivedFrom.length, confidence: c.confidence },
    'cognitive:l2:write',
  );
}

// ─── L3: promote + write (Task 7) ──────────────────────────────────────────

async function promoteToProceduralAndWrite(owner: string): Promise<number> {
  const r = await pool.query<{ id: string; payload_ct: Buffer }>(
    `SELECT id, payload_ct FROM cognitive_facts
      WHERE owner_addr = $1 AND procedure_key IS NOT NULL`,
    [owner],
  );
  const facts: Array<SemanticFact & { id: string }> = [];
  for (const row of r.rows) {
    try {
      const f = decryptJson<SemanticFact>(row.payload_ct, owner, 'L2');
      facts.push({ ...f, id: row.id });
    } catch {
      /* skip undecryptable rows */
    }
  }
  if (facts.length === 0) return 0;

  const existing = await pool.query<{ procedure_key: string }>(
    `SELECT procedure_key FROM cognitive_skills WHERE owner_addr = $1`,
    [owner],
  );
  const existingProcedureKeys = new Set(existing.rows.map((r) => r.procedure_key));
  const candidates = promoteToProcedural({ facts, existingProcedureKeys });

  let written = 0;
  for (const c of candidates) {
    try {
      await writeBundle(owner, c);
      written++;
    } catch (err) {
      const e = err as { code?: string; message: string };
      if (e.code !== '23505') {
        logger.warn({ owner, procedureKey: c.procedureKey, err: e.message }, 'cognitive:l3:write:failed');
      }
    }
  }
  return written;
}

async function writeBundle(owner: string, c: PromotionCandidate): Promise<void> {
  const signer = getSigner();
  const bundle: ProceduralBundle = {
    procedureKey: c.procedureKey,
    manifest: c.manifest,
    derivedFrom: c.derivedFrom,
    defaultPriceUsdc: c.defaultPriceUsdc,
    createdAt: c.createdAt,
    signer: signer.address as Hex,
    signature: '0x' as Hex,
  };
  const message = bundleSigningMessage(bundle);
  bundle.signature = (await signer.signMessage({ message })) as Hex;
  const ct = encryptJson(bundle, owner, 'L3');

  await pool.query(
    `INSERT INTO cognitive_skills
       (owner_addr, brain_id, procedure_key, manifest_ct, input_schema, output_schema,
        signer, signature, default_price_usdc, derived_from, expires_at)
     VALUES ($1, NULL, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb,
             now() + ($10 || ' seconds')::interval)`,
    [
      owner,
      c.procedureKey,
      ct,
      JSON.stringify(c.manifest.inputSchema),
      JSON.stringify(c.manifest.outputSchema),
      lower(signer.address),
      bundle.signature,
      c.defaultPriceUsdc,
      JSON.stringify(c.derivedFrom),
      L3_TTL_SEC,
    ],
  );
  logger.info(
    { owner, procedureKey: c.procedureKey, derivedFromN: c.derivedFrom.length },
    'cognitive:l3:mint',
  );
}

// ─── Public read paths (used by /v4/cognitive/* GET routes) ────────────────

export interface ListOpts {
  limit?: number;
}

export interface PublicEpisodeRow {
  id: string;
  agentId: string;
  topic: string;
  brainId: number | null;
  createdAt: string;
  /** Hex-encoded ciphertext — caller decrypts on demand if owner. */
  payloadHex: string;
  /** Plaintext body — populated only when caller is the owner. */
  body?: string;
}

export async function listEpisodes(ownerAddr: string, opts: ListOpts = {}): Promise<PublicEpisodeRow[]> {
  const owner = lower(ownerAddr);
  const r = await pool.query<RawEpisodeRow>(
    `SELECT id, payload_ct, topic, agent_id, brain_id, session_id, created_at
       FROM cognitive_episodes
      WHERE owner_addr = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [owner, Math.min(opts.limit ?? 50, 200)],
  );
  return r.rows.map((row) => {
    let body: string | undefined;
    try {
      const ep = decryptJson<Episode>(row.payload_ct, owner, 'L1');
      body = ep.body;
    } catch {
      /* leave body undefined */
    }
    return {
      id: row.id,
      agentId: row.agent_id,
      topic: row.topic,
      brainId: row.brain_id,
      createdAt: row.created_at.toISOString(),
      payloadHex: row.payload_ct.toString('hex'),
      body,
    };
  });
}

export interface PublicFactRow {
  id: string;
  topic: string;
  factType: string;
  confidence: number;
  derivedFrom: string[];
  procedureKey: string | null;
  signer: string;
  signature: string;
  createdAt: string;
  /** Hex-encoded ciphertext — caller decrypts on demand if owner. */
  payloadHex: string;
  /** Plaintext fact — populated only when caller is the owner. */
  fact?: string;
}

export async function listFacts(ownerAddr: string, opts: ListOpts = {}): Promise<PublicFactRow[]> {
  const owner = lower(ownerAddr);
  const r = await pool.query(
    `SELECT id, payload_ct, topic, fact_type, confidence, derived_from,
            procedure_key, signer, signature, created_at
       FROM cognitive_facts
      WHERE owner_addr = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [owner, Math.min(opts.limit ?? 50, 200)],
  );
  return r.rows.map((row) => {
    let fact: string | undefined;
    try {
      const f = decryptJson<SemanticFact>(row.payload_ct as Buffer, owner, 'L2');
      fact = f.fact;
    } catch {
      /* leave undefined */
    }
    return {
      id: row.id,
      topic: row.topic,
      factType: row.fact_type,
      confidence: row.confidence,
      derivedFrom: row.derived_from ?? [],
      procedureKey: row.procedure_key,
      signer: row.signer,
      signature: row.signature,
      createdAt: row.created_at.toISOString(),
      payloadHex: (row.payload_ct as Buffer).toString('hex'),
      fact,
    };
  });
}

export interface PublicSkillRow {
  id: string;
  procedureKey: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  defaultPriceUsdc: string;
  derivedFrom: string[];
  runCount: number;
  lastAttestation: string | null;
  signer: string;
  signature: string;
  createdAt: string;
  /** Decrypted manifest steps — populated only when caller is the owner. */
  steps?: Array<{ name: string; description: string }>;
}

export async function listSkills(ownerAddr: string, opts: ListOpts = {}): Promise<PublicSkillRow[]> {
  const owner = lower(ownerAddr);
  const r = await pool.query(
    `SELECT id, procedure_key, manifest_ct, input_schema, output_schema, default_price_usdc,
            derived_from, run_count, last_attestation, signer, signature, created_at
       FROM cognitive_skills
      WHERE owner_addr = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [owner, Math.min(opts.limit ?? 50, 200)],
  );
  return r.rows.map((row) => {
    let steps: Array<{ name: string; description: string }> | undefined;
    try {
      const b = decryptJson<ProceduralBundle>(row.manifest_ct as Buffer, owner, 'L3');
      steps = b.manifest.steps;
    } catch {
      /* leave undefined */
    }
    return {
      id: row.id,
      procedureKey: row.procedure_key,
      inputSchema: row.input_schema ?? {},
      outputSchema: row.output_schema ?? {},
      defaultPriceUsdc: String(row.default_price_usdc),
      derivedFrom: row.derived_from ?? [],
      runCount: row.run_count,
      lastAttestation: row.last_attestation,
      signer: row.signer,
      signature: row.signature,
      createdAt: row.created_at.toISOString(),
      steps,
    };
  });
}

// ─── L3 skill execution (Task 8) ────────────────────────────────────────────

export interface RunSkillResult {
  result: unknown;
  attestation: string;
}

/**
 * Run a skill. Phase 1: free; uses the existing chat LLM as the execution
 * substrate (the manifest's steps are turned into a system prompt). Phase 2:
 * routed to Phala TEE behind the same interface.
 *
 * Errors a 404 if the skill doesn't exist; any other failure becomes a 500.
 */
export async function runSkill(
  skillId: string,
  buyer: string,
  input: unknown,
): Promise<RunSkillResult> {
  const r = await pool.query(
    `SELECT id, owner_addr, manifest_ct, signer, signature
       FROM cognitive_skills
      WHERE id = $1`,
    [skillId],
  );
  if (r.rowCount === 0) throw Object.assign(new Error('skill not found'), { status: 404 });
  const row = r.rows[0];

  const bundle = decryptJson<ProceduralBundle>(row.manifest_ct as Buffer, row.owner_addr, 'L3');

  // Build a deterministic execution context. In Phase 2 this is sent to Phala
  // TEE; in Phase 1 we delegate to the existing chat LLM with the manifest as
  // the system prompt. The output is the LLM's structured reply.
  const { llmChat } = await import('./chat');
  const stepList = bundle.manifest.steps.map((s, i) => `${i + 1}. ${s.name}: ${s.description}`).join('\n');
  const system = `You are executing a procedural skill. Follow these steps:\n${stepList}\n\n` +
    `Output ONLY a JSON object matching the output schema: ${JSON.stringify(bundle.manifest.outputSchema)}`;
  const reply = await llmChat(system, [{ role: 'user', content: JSON.stringify(input ?? {}) }]);

  let parsedResult: unknown = { raw: reply };
  try {
    parsedResult = JSON.parse(reply);
  } catch {
    /* leave as raw */
  }

  // Phase 1: deterministic mock attestation. Phase 2: real Phala quote.
  const attestation = sha256Hex(`${skillId}:${buyer}:${reply}:${Date.now()}`);

  await pool.query(
    `UPDATE cognitive_skills
        SET run_count = run_count + 1,
            last_attestation = $1
      WHERE id = $2`,
    [attestation, skillId],
  );
  await pool.query(
    `INSERT INTO cognitive_skill_runs (skill_id, buyer, attestation, input_hash, result_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      skillId,
      lower(buyer),
      attestation,
      sha256Hex(JSON.stringify(input ?? {})),
      sha256Hex(reply),
    ],
  );
  logger.info({ skillId, buyer: lower(buyer), attestation }, 'cognitive:l3:run');
  return { result: parsedResult, attestation };
}

// ─── Brain snapshot for /agent/[id] (Task 10) ──────────────────────────────

export interface BrainSnapshot {
  brainId: number;
  ownerAddr: string | null;
  episodes: number;
  facts: number;
  skills: number;
  topics: Array<{ key: string; count: number }>;
  /** 14 buckets, oldest → newest, count of episodes per day. */
  activity14d: number[];
  lastQueryAt: string | null;
  fhenixVaultAddress: string | null;
  recentSkills: Array<{
    id: string;
    procedureKey: string;
    defaultPriceUsdc: string;
    runCount: number;
  }>;
  recentAttestations: Array<{ runId: number; attestation: string; createdAt: string }>;
}

const SNAPSHOT_TTL_MS = 30_000;
const _snapshotCache = new Map<number, { exp: number; data: BrainSnapshot }>();

export async function getBrainSnapshot(brainId: number): Promise<BrainSnapshot | null> {
  const cached = _snapshotCache.get(brainId);
  if (cached && cached.exp > Date.now()) return cached.data;

  const brainRow = await pool.query<{ owner_address: string }>(
    `SELECT owner_address FROM brains WHERE id = $1`,
    [brainId],
  );
  if (brainRow.rowCount === 0) return null;
  const ownerAddr = lower(brainRow.rows[0].owner_address);

  const [counts, topics, activity, lastQuery, skillsR, attR] = await Promise.all([
    pool.query<{ episodes: string; facts: string; skills: string }>(
      `SELECT
         (SELECT COUNT(*) FROM cognitive_episodes WHERE owner_addr = $1) AS episodes,
         (SELECT COUNT(*) FROM cognitive_facts    WHERE owner_addr = $1) AS facts,
         (SELECT COUNT(*) FROM cognitive_skills   WHERE owner_addr = $1) AS skills`,
      [ownerAddr],
    ),
    pool.query<{ topic: string; count: string }>(
      `SELECT topic, COUNT(*)::text AS count
         FROM cognitive_facts
        WHERE owner_addr = $1
        GROUP BY topic
        ORDER BY COUNT(*) DESC
        LIMIT 8`,
      [ownerAddr],
    ),
    pool.query<{ bucket: number; count: string }>(
      `SELECT FLOOR(EXTRACT(EPOCH FROM (now() - created_at)) / 86400)::int AS bucket,
              COUNT(*)::text AS count
         FROM cognitive_episodes
        WHERE owner_addr = $1 AND created_at > now() - interval '14 days'
        GROUP BY bucket`,
      [ownerAddr],
    ),
    pool.query<{ created_at: Date }>(
      `SELECT created_at FROM cognitive_episodes
        WHERE owner_addr = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [ownerAddr],
    ),
    pool.query(
      `SELECT id, procedure_key, default_price_usdc, run_count
         FROM cognitive_skills
        WHERE owner_addr = $1
        ORDER BY created_at DESC
        LIMIT 10`,
      [ownerAddr],
    ),
    pool.query<{ id: number; attestation: string; created_at: Date }>(
      `SELECT r.id, r.attestation, r.created_at
         FROM cognitive_skill_runs r
         JOIN cognitive_skills s ON s.id = r.skill_id
        WHERE s.owner_addr = $1
        ORDER BY r.created_at DESC
        LIMIT 5`,
      [ownerAddr],
    ),
  ]);

  const activity14d = Array.from({ length: 14 }, () => 0);
  for (const a of activity.rows) {
    const idx = 13 - a.bucket;
    if (idx >= 0 && idx < 14) activity14d[idx] = Number(a.count);
  }

  const data: BrainSnapshot = {
    brainId,
    ownerAddr,
    episodes: Number(counts.rows[0]?.episodes ?? 0),
    facts: Number(counts.rows[0]?.facts ?? 0),
    skills: Number(counts.rows[0]?.skills ?? 0),
    topics: topics.rows.map((t) => ({ key: t.topic, count: Number(t.count) })),
    activity14d,
    lastQueryAt: lastQuery.rows[0]?.created_at.toISOString() ?? null,
    fhenixVaultAddress: process.env.BRAIN_KEY_VAULT_ADDRESS ?? null,
    recentSkills: skillsR.rows.map((r) => ({
      id: r.id,
      procedureKey: r.procedure_key,
      defaultPriceUsdc: String(r.default_price_usdc),
      runCount: r.run_count,
    })),
    recentAttestations: attR.rows.map((r) => ({
      runId: r.id,
      attestation: r.attestation,
      createdAt: r.created_at.toISOString(),
    })),
  };

  _snapshotCache.set(brainId, { exp: Date.now() + SNAPSHOT_TTL_MS, data });
  return data;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
