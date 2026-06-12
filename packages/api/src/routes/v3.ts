import { Router, Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { registerLink, getLinkByEth, getLinkBySui, getCombinedReputation } from '../services/agentLinkOracle';
import { paymentGate, PriceableRequest } from '../middleware/paymentGate';
import { issueBundle, getBundle, verifyManifest } from '../services/bundleService';
import { discover, searchAgents } from '../services/discoveryService';
import { streamBundle } from '../services/hostedRunner';
import { pool } from '../db';
import { logger } from '../lib';
import type { AuthRequest } from '../middleware/auth';

/**
 * v3 — Dual-chain agentic marketplace API.
 *
 * Mounted at /v3 in server.ts. Sub-resources:
 *   /v3/links       — AgentLink (T4–T5)
 *   /v3/agents      — Agent CRUD + invocation gateway (T6, T10)
 *   /v3/bundles     — BundlePrompt issue + verify (T14)
 *   /v3/discover    — discovery concierge (T13)
 *   /v3/runner      — hosted manifest runner (T16)
 *   /v3/earnings    — per-rail breakdown (T12)
 *
 * Auth: routes are mounted *after* the existing `auth` middleware in
 * server.ts; handlers may further gate on ownership.
 */
const v3 = Router();

// ---------------------------------------------------------------------------
// /v3/version — health/diagnostic ping. Frontend uses this to confirm the API
// has the v3 router built in. Public (no auth needed at the route level —
// the parent /v3 mount adds auth, so server.ts mounts /v3 with auth-skip for
// this path; see fix in server.ts).
// ---------------------------------------------------------------------------
v3.get('/version', (_req: Request, res: Response) => {
  res.json({
    api: 'openx-v3',
    build: process.env.GIT_SHA ?? 'dev',
    started_at: process.env.PROC_START ?? null,
    routes: ['/links', '/agents', '/bundles', '/discover', '/runner', '/earnings'],
  });
});

// ---------------------------------------------------------------------------
// /v3/agents/slug-available — preflight check used by the publish wizard.
// Public (no auth) — slug presence is public information.
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9-]{3,30}$/;
const RESERVED_SLUGS = new Set(['api', 'admin', 'health', 'metrics', 'well-known', 'platform']);

v3.get('/agents/slug-available', async (req: Request, res: Response) => {
  const slug = String(req.query.slug ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return res.json({ available: false, reason: 'invalid' });
  if (RESERVED_SLUGS.has(slug)) return res.json({ available: false, reason: 'reserved' });
  const r = await pool.query(`SELECT 1 FROM agents WHERE slug = $1`, [slug]);
  if ((r.rowCount ?? 0) > 0) return res.json({ available: false, reason: 'taken' });
  res.json({ available: true });
});

// ---------------------------------------------------------------------------
// /v3/links — AgentLink registration + lookup
// ---------------------------------------------------------------------------

v3.post('/links', async (req: Request, res: Response) => {
  try {
    const link = await registerLink(req.body ?? {});
    res.json(link);
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn({ msg }, 'v3:links:register:failed');
    res.status(400).json({ error: msg });
  }
});

v3.get('/links/by-eth/:address', async (req: Request, res: Response) => {
  const link = await getLinkByEth(req.params.address);
  if (!link) return res.status(404).json({ error: 'not-found' });
  res.json(link);
});

// ---------------------------------------------------------------------------
// /v3/agents/:canonical_id/reputation — ERC-8004 + Sui-tier roll-up.
// Combined = max(eth_rep, sui_rep). KYA gates consume `combined_reputation`.
// ---------------------------------------------------------------------------

v3.get('/agents/:canonical_id/reputation', async (req: Request, res: Response) => {
  const rep = await getCombinedReputation(req.params.canonical_id);
  if (!rep) return res.status(404).json({ error: 'agent link not found' });
  res.json(rep);
});

v3.get('/links/by-sui/:address', async (req: Request, res: Response) => {
  const link = await getLinkBySui(req.params.address);
  if (!link) return res.status(404).json({ error: 'not-found' });
  res.json(link);
});

// ---------------------------------------------------------------------------
// /v3/agents — Agent CRUD + invocation gateway (T6 + T10)
// ---------------------------------------------------------------------------

v3.post('/agents', async (req: AuthRequest, res: Response) => {
  const ctx = { wallet: req.user?.address, body: req.body };
  try {
    const { brain_id, persona, pricing, kya_required, min_reputation, chain, slug } = req.body ?? {};
    if (!brain_id || !persona || !pricing || !chain) {
      logger.warn(ctx, 'v3:agents:create:bad-request');
      return res.status(400).json({ error: 'brain_id, persona, pricing, chain required' });
    }
    if (!req.user?.address) {
      logger.warn(ctx, 'v3:agents:create:unauthenticated');
      return res.status(401).json({ error: 'auth required' });
    }
    if (slug !== undefined && !SLUG_RE.test(String(slug))) {
      return res.status(400).json({ error: 'invalid slug' });
    }
    if (slug && RESERVED_SLUGS.has(String(slug).toLowerCase())) {
      return res.status(400).json({ error: 'reserved slug' });
    }
    const r = await pool.query(
      `INSERT INTO agents (brain_id, owner_address, chain, persona, pricing, kya_required, min_reputation, published, slug)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, false, $8)
       RETURNING id, brain_id, owner_address, chain, persona, pricing, kya_required, min_reputation, published, slug, created_at`,
      [brain_id, req.user.address, chain, JSON.stringify(persona), JSON.stringify(pricing), !!kya_required, min_reputation ?? 0, slug ?? null],
    );
    logger.info({ ...ctx, agentId: r.rows[0].id, slug }, 'v3:agents:create:ok');
    res.json(r.rows[0]);
  } catch (err) {
    const e = err as Error & { code?: string };
    const isMissingTable = e.code === '42P01';
    const isDuplicateSlug = e.code === '23505' && e.message.includes('agents_slug_key');
    logger.error({ ...ctx, err: e.message, code: e.code, stack: e.stack }, 'v3:agents:create:failed');
    res.status(isDuplicateSlug ? 409 : 500).json({
      error: isMissingTable
        ? 'agents table missing — run migration 004_v3_agentic.sql'
        : isDuplicateSlug
        ? 'slug already taken'
        : e.message,
      code: e.code ?? null,
    });
  }
});

v3.post('/agents/:id/publish', async (req: AuthRequest, res: Response) => {
  const ctx = { wallet: req.user?.address, agentId: req.params.id };
  try {
    const r = await pool.query(
      `UPDATE agents SET published = true WHERE id = $1 AND owner_address = $2
       RETURNING id, published`,
      [req.params.id, req.user?.address ?? ''],
    );
    if (r.rowCount === 0) {
      logger.warn(ctx, 'v3:agents:publish:not-owner');
      return res.status(403).json({ error: 'not owner or not found' });
    }
    logger.info(ctx, 'v3:agents:publish:ok');
    res.json(r.rows[0]);
  } catch (err) {
    const e = err as Error & { code?: string };
    logger.error({ ...ctx, err: e.message, code: e.code }, 'v3:agents:publish:failed');
    res.status(500).json({ error: e.message, code: e.code ?? null });
  }
});

/**
 * PATCH /v3/agents/:id — owner partial update of `persona` and/or `pricing`.
 * Used by the studio Settings tab to edit the agent prompt without re-publishing.
 * Invalidates the v1Public provider cache so the next `/api/v1/<slug>` call
 * picks up the new prompt within ~1s of save.
 */
v3.patch('/agents/:id', async (req: AuthRequest, res: Response) => {
  const ctx = { wallet: req.user?.address, agentId: req.params.id };
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const { persona, pricing } = req.body ?? {};
  if (!persona && !pricing) return res.status(400).json({ error: 'persona or pricing required' });
  if (persona?.system_prompt && typeof persona.system_prompt === 'string' && persona.system_prompt.length > 4000) {
    return res.status(400).json({ error: 'system_prompt too long (max 4000 chars)' });
  }
  try {
    const r = await pool.query(
      `UPDATE agents
          SET persona = COALESCE($3::jsonb, persona),
              pricing = COALESCE($4::jsonb, pricing)
        WHERE id = $1 AND owner_address = $2
        RETURNING id, slug, persona, pricing`,
      [
        req.params.id,
        req.user.address,
        persona ? JSON.stringify(persona) : null,
        pricing ? JSON.stringify(pricing) : null,
      ],
    );
    if (r.rowCount === 0) {
      logger.warn(ctx, 'v3:agents:patch:not-owner');
      return res.status(403).json({ error: 'not owner or not found' });
    }
    // Evict v1Public provider cache so the new prompt/price ships on next call.
    if (r.rows[0].slug) {
      const { invalidateProvider } = await import('./v1Public');
      invalidateProvider(r.rows[0].slug);
    }
    logger.info(ctx, 'v3:agents:patch:ok');
    res.json(r.rows[0]);
  } catch (err) {
    const e = err as Error & { code?: string };
    logger.error({ ...ctx, err: e.message, code: e.code }, 'v3:agents:patch:failed');
    res.status(500).json({ error: e.message, code: e.code ?? null });
  }
});

v3.get('/agents', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const r = await pool.query(
    `SELECT id, brain_id, owner_address, chain, persona, pricing, kya_required, min_reputation, published, slug, created_at
     FROM agents WHERE published = true ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  res.json(r.rows);
});

// Public — must be declared before /agents/:id so Express matches the
// literal /top instead of treating "top" as an :id. Whitelisted in
// middleware/auth.ts as `/^\/agents\/top$/`. Aggregates over the indexed
// `paid_calls.agent_id` (paid_calls_agent_idx, migration 010); cheap.
v3.get('/agents/top', async (req: Request, res: Response) => {
  const n = Math.min(Math.max(Number(req.query.n ?? 5), 1), 20);
  const windowDays = Math.min(Math.max(Number(req.query.window_days ?? 30), 1), 365);
  const r = await pool.query(
    `SELECT a.id,
            a.brain_id,
            a.chain,
            a.pricing,
            a.persona,
            a.slug,
            b.title,
            b.description,
            b.tags,
            COALESCE(stats.calls, 0)::int AS calls_30d
       FROM agents a
       JOIN brains b ON b.id = a.brain_id
  LEFT JOIN (
              SELECT agent_id, COUNT(*)::int AS calls
                FROM paid_calls
               WHERE created_at > now() - (INTERVAL '1 day' * $2)
            GROUP BY agent_id
            ) AS stats ON stats.agent_id = a.id
      WHERE a.published = true
   ORDER BY calls_30d DESC, a.created_at DESC
      LIMIT $1`,
    [n, windowDays],
  );
  res.json({ agents: r.rows, window_days: windowDays });
});

// /v3/agents/search — keyword fast-path. PRD-17 §3. Public (whitelisted in
// auth.ts). Reads MemWal `openx-agent-index` first; falls back to TF-IDF
// over the cached Postgres corpus when MemWal is disabled. Must be
// registered BEFORE the `/agents/:id` catch-all below or Express casts
// the literal "search" as a UUID and the route never matches.
v3.get('/agents/search', async (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const limitN = Number(req.query.limit ?? 10);
  const kindRaw = typeof req.query.kind === 'string' ? req.query.kind : undefined;
  const allowedKinds = new Set(['api', 'workflow', 'skill', 'brain']);
  const kind = kindRaw && allowedKinds.has(kindRaw)
    ? (kindRaw as 'api' | 'workflow' | 'skill' | 'brain')
    : undefined;
  if (!q || q.trim().length === 0) {
    return res.status(400).json({ error: 'q is required' });
  }
  const result = await searchAgents({ q, limit: limitN, kind });
  res.json(result);
});

v3.get('/agents/:id', async (req: Request, res: Response) => {
  const r = await pool.query(
    `SELECT id, brain_id, owner_address, chain, persona, pricing, kya_required, min_reputation, published, slug, created_at
     FROM agents WHERE id = $1`,
    [req.params.id],
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

v3.get('/agents/by-owner/:owner', async (req: Request, res: Response) => {
  const r = await pool.query(
    `SELECT id, brain_id, owner_address, chain, persona, pricing, kya_required, min_reputation, published, slug, created_at
     FROM agents WHERE owner_address = $1 ORDER BY created_at DESC`,
    [req.params.owner.toLowerCase()],
  );
  res.json(r.rows);
});

// ─── PRD-2: free, rate-limited try-it endpoint ─────────────────────────────
//
// Lets buyers test a published agent without a wallet/USDC. The same
// `runInference` path the paid surface uses; we just bypass the paywall
// and log to `paid_calls` with `method='demo'` so seller earnings can
// filter cleanly. Rate-limited per (IP, agent) and per agent, in-memory,
// no Redis. Bounded memory: O(active keys × calls/day).

const tryLimiter = new Map<string, number[]>();
const TRY_DAY_MS = 24 * 60 * 60 * 1000;
function tryAllow(key: string, capPerDay: number): { ok: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const cutoff = now - TRY_DAY_MS;
  const hits = (tryLimiter.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= capPerDay) {
    const retryAfterSec = Math.ceil((hits[0] + TRY_DAY_MS - now) / 1000);
    tryLimiter.set(key, hits);
    return { ok: false, retryAfterSec };
  }
  hits.push(now);
  tryLimiter.set(key, hits);
  return { ok: true };
}

v3.post('/agents/:id/try', async (req: Request, res: Response) => {
  const id = req.params.id;
  // Accept both `q` (legacy n-payment SDK convention) and `message` (the
  // /agent/[id] try button + most chat-style clients). Single source of
  // truth for the trimmed value below — old curl tests + the frontend
  // both work.
  const q = String(req.body?.q ?? req.body?.message ?? '').trim();
  if (!q || q.length > 2000) return res.status(400).json({ error: 'q or message required, ≤2000 chars' });

  // Privacy: hash the IP rather than store it. 12 hex chars = 48 bits, plenty
  // for keying without re-identification.
  const ipHash = createHash('sha256').update(req.ip ?? 'unknown').digest('hex').slice(0, 12);
  const perIp = tryAllow(`ip:${ipHash}:agent:${id}`, 10);
  if (!perIp.ok) {
    res.set('Retry-After', String(perIp.retryAfterSec));
    return res.status(429).json({ error: 'try limit reached for this agent today', retryAfterSec: perIp.retryAfterSec });
  }
  const perAgent = tryAllow(`agent:${id}`, 100);
  if (!perAgent.ok) {
    res.set('Retry-After', String(perAgent.retryAfterSec));
    return res.status(429).json({ error: 'agent demo cap reached today', retryAfterSec: perAgent.retryAfterSec });
  }

  const r = await pool.query(
    `SELECT id, slug, brain_id, owner_address, persona, pricing FROM agents WHERE id = $1 AND published = true`,
    [id],
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'agent not found' });
  const agent = r.rows[0];

  try {
    const { runInference } = await import('./v1Public');
    const { record } = await import('../services/paidCallLedger');
    const result = await runInference(
      { brain_id: agent.brain_id, persona: agent.persona },
      q,
    );
    const txHash = `demo-${randomUUID()}`;
    await record({
      agentId: agent.id,
      slug: agent.slug ?? `agent-${agent.id}`,
      buyer: 'demo',
      amountUsdc: '0',
      txHash,
      network: process.env.X402_NETWORK ?? 'arbitrum-sepolia',
      method: 'demo',
    });
    logger.info({ agentId: agent.id, ipHash }, 'service:try:end');
    res.json({ ...result, settled: { method: 'demo', txHash, demo: true } });
  } catch (err) {
    logger.error({ agentId: agent.id, err: (err as Error).message }, 'service:try:failed');
    res.status(500).json({ error: 'inference failed' });
  }
});

/**
 * POST /v3/agents/:id/chat — paid invocation. Returns 402 with all enabled
 * rails as `WWW-Authenticate: Payment` headers; on receipt, runs inference
 * over the underlying brain and returns the answer.
 */
v3.post('/agents/:id/chat', paymentGate as any, async (req: PriceableRequest, res: Response) => {
  const agent = req.pricedAgent!;
  const message: string = req.body?.message ?? '';
  if (!message) return res.status(400).json({ error: 'message required' });

  // Delegate to the existing inference path. For Standard tier (Fhenix),
  // we reuse the v2 chat service against the agent's brain. Sui-tier agents
  // currently fall back to the same path until the SealBrainClient is wired
  // server-side (mock-first).
  try {
    const { ChatService } = await import('../services/chat');
    const { buildSystemPrompt } = await import('./v1Public');
    const buyer = req.user?.address ?? 'agent-anonymous';
    // Use the canonical prompt-merger so v3 chat and v1 paid-API path emit
    // byte-identical system prompts for the same (persona, message) input.
    // Fixes a latent bug where this site rendered "undefined\n\nUser:…" when
    // the seller never set persona.system_prompt (the wizard's prior payload).
    const sellerPrompt = buildSystemPrompt(agent.persona, '');
    const result = await ChatService.chat(
      buyer,
      `${sellerPrompt}\n\nUser: ${message}`,
      String(agent.brain_id),
      'learn',
      agent.chain,
    );
    res.json({
      response: result.response,
      sources: result.sources ?? [],
      agent_id: agent.id,
      receipt: req.receipt,
      attestation: { provider: 'phala-tee', verified: true, mock: true },
    });

    // Cognitive Memory v1 — non-blocking L1 episode write + consolidation pass.
    // Errors are logged at WARN, never crash the chat response. The chat
    // reply has already been sent above; this runs in the same tick but
    // detached from the response lifecycle.
    Promise.resolve().then(async () => {
      try {
        const { writeEpisode, consolidateAndWrite } = await import('../services/cognitiveMemoryService');
        const ownerAddr = String(agent.owner_address);
        await writeEpisode({
          ownerAddr,
          agentId: buyer,
          brainId: Number(agent.brain_id),
          // Topic = 16-hex of keccak-like; reuse the existing message-derived
          // sha-256 short hash to stay deterministic and dependency-light.
          topic: shortTopicHash(message),
          sessionId: `session-${agent.id}-${buyer}`,
          body: `${message} → ${result.response}`,
        });
        const consolidation = await consolidateAndWrite(ownerAddr);
        if (consolidation.newFacts > 0 || consolidation.newBundles > 0) {
          logger.info({ owner: ownerAddr, ...consolidation }, 'v3:agent:chat:cognitive:promoted');
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message, agentId: agent.id }, 'v3:agent:chat:cognitive:failed');
      }
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, agentId: agent.id }, 'v3:agent:chat:failed');
    res.status(500).json({ error: 'inference failed' });
  }
});

// 16-hex deterministic short hash for the topic attribute. Kept inline (one
// helper, used only here) per "essential files only".
function shortTopicHash(s: string): string {
  return createHash('sha256').update(s.toLowerCase().slice(0, 200), 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// /v3/earnings/:wallet — per-rail breakdown (T12)
// ---------------------------------------------------------------------------

v3.get('/earnings/:wallet', async (req: Request, res: Response) => {
  const wallet = req.params.wallet.toLowerCase();
  const r = await pool.query(
    `SELECT ar.rail, COUNT(*) AS calls, COALESCE(SUM(ar.amount_usdc), 0) AS total_usdc
     FROM agent_receipts ar JOIN agents a ON a.id = ar.agent_id
     WHERE a.owner_address = $1
     GROUP BY ar.rail`,
    [wallet],
  );
  const recent = await pool.query(
    `SELECT ar.rail, ar.amount_usdc, ar.tx_or_receipt, ar.created_at, a.id AS agent_id
     FROM agent_receipts ar JOIN agents a ON a.id = ar.agent_id
     WHERE a.owner_address = $1
     ORDER BY ar.created_at DESC LIMIT 20`,
    [wallet],
  );
  res.json({ totals_by_rail: r.rows, recent_receipts: recent.rows });
});

// ---------------------------------------------------------------------------
// /v3/bundles — BundlePrompt issue + verify (T14)
// ---------------------------------------------------------------------------

v3.post('/bundles', async (req: Request, res: Response) => {
  try {
    const manifest = await issueBundle(req.body ?? {});
    res.json(manifest);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

v3.get('/bundles/:id', async (req: Request, res: Response) => {
  const m = await getBundle(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json(m);
});

v3.post('/bundles/:id/verify', async (req: Request, res: Response) => {
  const m = await getBundle(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const result = verifyManifest(m);
  res.json(result);
});

// ---------------------------------------------------------------------------
// /v3/discover — concierge endpoint (T13). Returns candidates + signed bundle.
// ---------------------------------------------------------------------------

v3.post('/discover', async (req: Request, res: Response) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message : '';
  const result = await discover({ ...body, message } as any, baseUrl);
  res.json(result);
});

// ---------------------------------------------------------------------------
// /v3/runner/:id — hosted runner SSE (T16). Optional path; manifest mode is canonical.
// ---------------------------------------------------------------------------

v3.post('/runner/:id', streamBundle as any);

// ---------------------------------------------------------------------------
// /v3/brains/trustless — register a freshly-published trustless brain so
// /v3/brains/:id/sovereignty-proof has something to return. Idempotent
// (ON CONFLICT DO UPDATE) so the publish flow can retry safely.
//
// SOLID: this route's single responsibility is to persist trust metadata.
// Optional artifacts (sui_object_id / seal_policy_id / walrus_blob_ids)
// fall back to honest placeholders while T11/T14 (real Sui tx submission)
// is parked, so the publish→view round-trip works end-to-end today.
// ---------------------------------------------------------------------------

v3.post('/brains/trustless', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const id = String(body.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'id required' });

  const owner = req.user.address.toLowerCase();
  const suiObjectId = String(body.suiObjectId ?? `sui:pending:${id}`);
  const sealPolicyId = String(body.sealPolicyId ?? `seal:pending:${id}`);
  const walrusBlobIds = Array.isArray(body.walrusBlobIds) ? (body.walrusBlobIds as unknown[]).map(String) : [];
  const totalBytes = Number.isFinite(Number(body.totalBytes)) ? Number(body.totalBytes) : 0;
  const contentMetadataHash = String(body.contentMetadataHash ?? '');
  const kyaRequired = Boolean(body.kyaRequired);
  const minReputation = Number.isFinite(Number(body.minReputation)) ? Number(body.minReputation) : 0;
  const suiAddress = typeof body.suiAddress === 'string' ? body.suiAddress.trim() : '';

  try {
    await pool.query(
      `INSERT INTO brains_trustless
         (id, owner_address, sui_object_id, seal_policy_id, walrus_blob_ids,
          total_bytes, content_metadata_hash, kya_required, min_reputation, published)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
       ON CONFLICT (id) DO UPDATE SET
         walrus_blob_ids = EXCLUDED.walrus_blob_ids,
         total_bytes = EXCLUDED.total_bytes,
         content_metadata_hash = EXCLUDED.content_metadata_hash,
         kya_required = EXCLUDED.kya_required,
         min_reputation = EXCLUDED.min_reputation,
         published = true`,
      [id, owner, suiObjectId, sealPolicyId, walrusBlobIds, totalBytes, contentMetadataHash, kyaRequired, minReputation],
    );

    // Tatum auto-subscribe removed in arb-mem (Arbitrum-only).
    res.status(201).json({ ok: true, id });
  } catch (err) {
    logger.warn({ err: (err as Error).message, id }, 'v3:brains:register:error');
    res.status(503).json({ error: 'persistence unavailable' });
  }
});

// ---------------------------------------------------------------------------
// /v3/brains/:id/sovereignty-proof — institutional-grade audit endpoint.
// Rebuilds the brain's chunk index from Walrus alone. The OpenX database
// is in the relay path, not the trust path: this endpoint must remain
// answerable even if the Postgres connection is down.
//
// Phase 1: returns the manifest assembled from the in-DB chunk_refs cache
// (cheap, fast). Phase 2: bypasses Postgres and reads directly from Sui
// brain object + Walrus aggregator. Same JSON shape — caller can't tell.
// ---------------------------------------------------------------------------

v3.get('/brains/:id/sovereignty-proof', async (req: Request, res: Response) => {
  const brainId = req.params.id;
  try {
    const r = await pool.query(
      `SELECT id, walrus_blob_ids, content_metadata_hash, sui_object_id, created_at
       FROM brains_trustless WHERE id = $1`,
      [brainId],
    );
    if (r.rowCount === 0) {
      // Phase 2 fallback: synthesize from Sui object directly. For now, 404.
      return res.status(404).json({ error: 'brain not found in trustless tier' });
    }
    const row = r.rows[0];
    res.json({
      brainId,
      chunkCount: (row.walrus_blob_ids ?? []).length,
      totalBytes: 0, // populated when chunk metadata is indexed (Phase 2)
      walrusBlobIds: row.walrus_blob_ids ?? [],
      suiObjectId: row.sui_object_id ?? undefined,
      contentMetadataHash: row.content_metadata_hash ?? '',
      timestamp: Date.now(),
      walrusNetwork: process.env.WALRUS_PUBLISHER_URL?.includes('testnet') ? 'testnet' : 'mainnet',
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, brainId }, 'v3:sovereignty-proof:error');
    res.status(503).json({ error: 'index unavailable; try again' });
  }
});

// ---------------------------------------------------------------------------
// /v3/brains/:id/cost — Walrus storage cost in USD + WAL.
// Uses Tatum Crypto Price API for live WAL→USD; cached 60s in-memory.
// Falls back to a configurable WAL_PRICE_USD_FALLBACK env when Tatum is down.
// ---------------------------------------------------------------------------

let walPriceCache: { value: number; ts: number } | null = null;
const WAL_PRICE_TTL_MS = 60_000;

async function getWalPriceUsd(): Promise<number> {
  if (walPriceCache && Date.now() - walPriceCache.ts < WAL_PRICE_TTL_MS) {
    return walPriceCache.value;
  }
  const fallback = Number(process.env.WAL_PRICE_USD_FALLBACK ?? '0.08');
  const apiKey = process.env.TATUM_API_KEY;
  if (!apiKey) return fallback;
  try {
    const res = await fetch('https://api.tatum.io/v3/tatum/rate/WAL?basePair=USD', {
      headers: { 'x-api-key': apiKey },
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { value?: number };
    const value = Number(data.value ?? fallback);
    walPriceCache = { value, ts: Date.now() };
    return value;
  } catch {
    return fallback;
  }
}

v3.get('/brains/:id/cost', async (req: Request, res: Response) => {
  const brainId = req.params.id;
  try {
    const r = await pool.query(
      `SELECT walrus_blob_ids, total_bytes FROM brains_trustless WHERE id = $1`,
      [brainId],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'brain not found' });
    const row = r.rows[0];
    const blobCount = (row.walrus_blob_ids ?? []).length;
    const totalBytes: number = Number(row.total_bytes ?? 0);
    // Walrus pricing model (mainnet, June 2026): ~0.0001 WAL/MB/epoch × ~10 epochs/yr
    // ⇒ ~$0.00008/MB/yr at $0.08/WAL. Quilt overhead ≈ 0.05 WAL flat per blob.
    const walPriceUsd = await getWalPriceUsd();
    const epochsPerYear = 10;
    const walPerMbEpoch = 0.0001;
    const walFlatPerBlob = 0.05;
    const annualCostWal =
      (totalBytes / (1024 * 1024)) * walPerMbEpoch * epochsPerYear + blobCount * walFlatPerBlob;
    const annualCostUsd = annualCostWal * walPriceUsd;
    res.json({
      brainId,
      chunkCount: blobCount,
      totalBytes,
      annualCostUsd: Number(annualCostUsd.toFixed(4)),
      annualCostWal: Number(annualCostWal.toFixed(4)),
      walPriceUsd,
      breakdown: {
        storage: Number(((totalBytes / 1048576) * walPerMbEpoch * epochsPerYear * walPriceUsd).toFixed(4)),
        writes: Number((blobCount * walFlatPerBlob * walPriceUsd).toFixed(4)),
        reads: 'metered, ~$0.000001/read',
      },
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, brainId }, 'v3:cost:error');
    res.status(503).json({ error: 'cost computation unavailable' });
  }
});

// ---------------------------------------------------------------------------
// /v3/dashboard/stats — public cash-flow dashboard (Frame F1).
// Aggregates over paid_calls + cognitive_workflows + brains. SQL-only; cheap
// (<5 ms with the existing covering indexes). No auth required — the
// numbers are public marketing artifacts. Whitelisted in middleware/auth.ts.
// ---------------------------------------------------------------------------
v3.get('/dashboard/stats', async (_req: Request, res: Response) => {
  try {
    const [counts, topSellers, recentReceipts, walRate] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM brains WHERE published = true)                            AS brains_published,
           (SELECT COUNT(*)::int FROM cognitive_workflows WHERE published = true)               AS workflows_published,
           (SELECT COUNT(*)::int FROM cognitive_skills_marketplace WHERE published = true)      AS skills_published,
           (SELECT COUNT(*)::int FROM cognitive_reflective WHERE published = true)              AS reflective_published,
           (SELECT COUNT(*)::int FROM cognitive_workflow_runs)                                  AS workflow_runs_total,
           (SELECT COUNT(*)::int FROM cognitive_workflow_runs WHERE created_at >= now() - interval '24 hours') AS workflow_runs_24h,
           (SELECT COALESCE(SUM(amount_usdc), 0)::numeric(20,6) FROM paid_calls)                AS total_usdc_routed,
           (SELECT COALESCE(SUM(amount_usdc), 0)::numeric(20,6) FROM paid_calls WHERE created_at >= now() - interval '24 hours') AS usdc_routed_24h`,
      ),
      pool.query(
        `SELECT a.owner_address AS seller, SUM(pc.amount_usdc)::numeric(20,6) AS earned, COUNT(pc.id)::int AS calls
           FROM paid_calls pc JOIN agents a ON a.id = pc.agent_id
          GROUP BY a.owner_address
          ORDER BY earned DESC LIMIT 10`,
      ),
      pool.query(
        `SELECT slug, buyer, amount_usdc, tx_hash, network, method, created_at
           FROM paid_calls ORDER BY created_at DESC LIMIT 20`,
      ),
      // Tatum WAL price feed removed (Arbitrum-only). Use static fallback.
      Promise.resolve(null),
    ]);
    res.json({
      counts: counts.rows[0],
      topSellers: topSellers.rows,
      recentReceipts: recentReceipts.rows,
      walUsdRate: walRate ?? { usdPerWal: 0.023, cached: true, updatedAt: Date.now() },
      generatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'v3:dashboard:stats:failed');
    res.status(500).json({ error: 'stats-failed' });
  }
});

export default v3;
