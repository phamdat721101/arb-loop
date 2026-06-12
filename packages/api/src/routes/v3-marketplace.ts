/**
 * v3-marketplace — seller-first marketplace v1 + v2 routes.
 *
 *   Public (whitelisted in auth.ts):
 *     GET  /v3/marketplace/listings                  v1 catalog
 *     GET  /v3/marketplace/workflows                 v2 workflow catalog
 *     GET  /v3/marketplace/workflows/:slug           v2 workflow detail
 *     GET  /v3/marketplace/workflows/:slug/recent    v2 anonymized recent runs
 *
 *   Auth-gated:
 *     POST  /v3/marketplace/seller/publish           v1 atomic publish (now seller-aware)
 *     GET   /v3/marketplace/seller/me                v2 current seller profile
 *     PATCH /v3/marketplace/seller/me                v2 update profile
 *     GET   /v3/marketplace/seller/dashboard         v2 rolled-up earnings
 *     GET   /v3/marketplace/seller/dashboard.csv     v2 CSV export (streamed)
 *
 * SOLID:
 *   - SRP: this file owns marketplace HTTP. Business logic stays in
 *     `services/sellerPublishService.ts`. Aggregations live in this file
 *     because they are simple SQL — no separate service warranted.
 *   - DIP: pool is module-level (matches the rest of routes/*).
 */

import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { logger } from '../lib';
import type { AuthRequest } from '../middleware/auth';
import { publish, type SellerPublishInput } from '../services/sellerPublishService';

const router = Router();

const VALID_DOMAINS = new Set([
  'marketing',
  'finance',
  'research',
  'engineering',
  'generalist',
  'other',
]);
const VALID_TIERS = new Set(['basic', 'verified', 'tee_attested']);
const VALID_KINDS = new Set(['api', 'workflow', 'skill', 'brain']);

// ─── Public catalog ────────────────────────────────────────────────────────

router.get('/listings', async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const domain =
    typeof req.query.domain === 'string' && VALID_DOMAINS.has(req.query.domain)
      ? req.query.domain
      : null;
  const tier =
    typeof req.query.tier === 'string' && VALID_TIERS.has(req.query.tier)
      ? req.query.tier
      : null;
  const kind =
    typeof req.query.kind === 'string' && VALID_KINDS.has(req.query.kind)
      ? req.query.kind
      : null;

  const params: Array<string | number> = [limit, offset];
  let where = `WHERE a.published = true`;
  if (domain) {
    params.push(domain);
    where += ` AND a.domain = $${params.length}`;
  }
  if (tier) {
    params.push(tier);
    where += ` AND a.verification_tier = $${params.length}`;
  }
  if (kind) {
    params.push(kind);
    where += ` AND a.kind = $${params.length}`;
  }

  const r = await pool.query(
    `SELECT a.id, a.brain_id, a.slug, a.chain, a.domain, a.short_description,
            a.verification_tier, a.kind, a.privacy_mode, a.privacy_source,
            a.pricing, a.persona, a.created_at,
            b.title, b.description, b.tags
       FROM agents a
       JOIN brains b ON b.id = a.brain_id
       ${where}
   ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2`,
    params,
  );
  res.json({ listings: r.rows, limit, offset });
});

// ─── Public workflow catalog (PRD-15) ──────────────────────────────────────

router.get('/workflows', async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const r = await pool.query(
    `SELECT a.slug, a.short_description, a.domain, a.verification_tier,
            a.privacy_mode, a.kind, a.workflow_ref, a.created_at,
            b.title, b.description,
            cw.steps, cw.default_price_usdc, cw.runs, cw.successful_runs
       FROM agents a
       JOIN brains b ON b.id = a.brain_id
       LEFT JOIN cognitive_workflows cw
              ON cw.author_addr = a.owner_address
             AND cw.workflow_key = a.workflow_ref
      WHERE a.published = true AND a.kind = 'workflow'
   ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  res.json({ listings: r.rows, limit, offset });
});

router.get('/workflows/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug ?? '').toLowerCase();
  const r = await pool.query(
    `SELECT a.id, a.slug, a.owner_address, a.short_description, a.domain,
            a.verification_tier, a.privacy_mode, a.privacy_source,
            a.pricing, a.persona, a.manifest_yaml, a.workflow_ref, a.created_at,
            b.title, b.description, b.tags,
            cw.steps, cw.default_price_usdc, cw.author_bps, cw.platform_bps,
            cw.runs, cw.successful_runs
       FROM agents a
       JOIN brains b ON b.id = a.brain_id
       LEFT JOIN cognitive_workflows cw
              ON cw.author_addr = a.owner_address
             AND cw.workflow_key = a.workflow_ref
      WHERE a.published = true AND a.kind = 'workflow' AND a.slug = $1
      LIMIT 1`,
    [slug],
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'workflow not found' });
  res.json(r.rows[0]);
});

router.get('/workflows/:slug/recent', async (req: Request, res: Response) => {
  const slug = String(req.params.slug ?? '').toLowerCase();
  const limit = Math.min(Math.max(Number(req.query.limit ?? 5), 1), 25);
  const r = await pool.query(
    `SELECT cwr.id, cwr.success, cwr.outputs_hash, cwr.total_usdc,
            cwr.attestation_hash, cwr.started_at, cwr.ended_at
       FROM cognitive_workflow_runs cwr
       JOIN cognitive_workflows cw ON cw.id = cwr.workflow_id
       JOIN agents a ON a.workflow_ref = cw.workflow_key AND a.owner_address = cw.author_addr
      WHERE a.slug = $1
   ORDER BY cwr.created_at DESC
      LIMIT $2`,
    [slug, limit],
  );
  res.json({ runs: r.rows });
});

// POST /workflows/:slug/run — auth + paymentGate-gated. Resolves slug to a
// cognitive_workflows.id and delegates to the existing executor route. The
// indirection lets MCP hosts call by slug (stable) instead of internal id.
router.post('/workflows/:slug/run', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const slug = String(req.params.slug ?? '').toLowerCase();
  const r = await pool.query(
    `SELECT cw.id AS workflow_id
       FROM agents a
       JOIN cognitive_workflows cw
              ON cw.author_addr = a.owner_address
             AND cw.workflow_key = a.workflow_ref
      WHERE a.slug = $1 AND a.published = true AND a.kind = 'workflow'
      LIMIT 1`,
    [slug],
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'workflow not found' });
  const workflowId = r.rows[0].workflow_id;
  // Forward to the existing executor — preserves auth/pay flow + receipts.
  res.redirect(307, `/v3/workflows/${workflowId}/execute`);
});

// ─── Auth-gated seller surface (PRD-14) ────────────────────────────────────

router.post('/seller/publish', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  try {
    const apiBaseUrl = `${req.protocol}://${req.get('host')}`;
    const result = await publish(req.user.address, req.body as SellerPublishInput, {
      apiBaseUrl,
      permitJti: req.user.permitJti ?? null,
      permitExpSec: req.user.permitExpSec,
    });
    logger.info(
      {
        wallet: req.user.address,
        slug: result.slug,
        domain: result.domain,
        kind: result.kind,
        chain: result.chain,
        privacy_mode: result.privacy_mode,
        seller_id: result.seller_id,
      },
      'marketplace:seller:publish:ok',
    );
    res.json(result);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    const status = typeof err?.status === 'number' ? err.status : 500;
    logger.warn(
      { wallet: req.user.address, err: err?.message, status },
      'marketplace:seller:publish:failed',
    );
    res.status(status).json({ error: err?.message ?? 'publish failed' });
  }
});

// ─── PRD-19 — gasless on-chain registration status (public read) ───────────
//
// Frontend dashboard polls this every 5s after a publish to flip the
// "Live on-chain" badge. Public-by-default: returns only state + the
// transaction hash + the registry brain id, all of which are already
// queryable directly on Arbitrum Sepolia. No private data leaks.
//
// Returns {state:'none'} when no queue row exists (gasless flag was off
// at publish time) so the frontend can render "off-chain only" without
// a special 404 path.
router.get('/seller/agent/:id/onchain-status', async (req: Request, res: Response) => {
  const agentId = String(req.params.id ?? '');
  // UUID-v4 shape check — cheap, prevents SQL probing.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) {
    return res.status(400).json({ error: 'invalid agent id' });
  }
  const r = await pool.query(
    `SELECT state, tx_hash, on_chain_brain_id, attempts, last_error
       FROM chain_ops_queue
      WHERE agent_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [agentId],
  );
  if (r.rowCount === 0) {
    return res.json({ state: 'none', tx_hash: null, on_chain_brain_id: null, attempts: 0, error: null });
  }
  const row = r.rows[0];
  res.json({
    state: row.state,
    tx_hash: row.tx_hash,
    on_chain_brain_id: row.on_chain_brain_id !== null ? Number(row.on_chain_brain_id) : null,
    attempts: Number(row.attempts),
    error: row.last_error,
  });
});

router.get('/seller/me', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const owner = req.user.address.toLowerCase();
  const r = await pool.query(
    `SELECT id, wallet_address, display_name, bio, identity_type, identity_handle,
            kya_proof_id, kya_min_reputation, payout_method,
            contact_email, support_url, archived, created_at, updated_at
       FROM sellers WHERE wallet_address = $1`,
    [owner],
  );
  if (r.rowCount === 0) return res.json({ seller: null });
  res.json({ seller: r.rows[0] });
});

router.patch('/seller/me', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const owner = req.user.address.toLowerCase();
  const body = (req.body ?? {}) as Record<string, unknown>;
  const allowed = [
    'display_name',
    'bio',
    'identity_type',
    'identity_handle',
    'contact_email',
    'support_url',
  ];
  const fields = allowed.filter((k) => body[k] !== undefined);
  if (fields.length === 0) return res.status(400).json({ error: 'no updatable fields' });

  const sets = fields.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const params: Array<unknown> = [owner, ...fields.map((k) => body[k])];
  await pool.query(
    `INSERT INTO sellers (wallet_address, ${fields.join(', ')}, created_at, updated_at)
     VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(', ')}, now(), now())
     ON CONFLICT (wallet_address) DO UPDATE SET ${sets}, updated_at = now()`,
    params,
  );
  res.json({ ok: true });
});

router.get('/seller/dashboard', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const owner = req.user.address.toLowerCase();
  const sellerRow = await pool.query(`SELECT id FROM sellers WHERE wallet_address = $1`, [owner]);
  if (sellerRow.rowCount === 0) return res.json({ seller: null, agents: [], earnings: null });
  const sellerId = sellerRow.rows[0].id;

  const [agents, earnings] = await Promise.all([
    pool.query(
      `SELECT a.id, a.slug, a.kind, a.domain, a.verification_tier, a.privacy_mode,
              a.created_at,
              COALESCE(SUM(pc.amount_usdc), 0)::text AS earned_total,
              COUNT(pc.id)::int                      AS calls_total
         FROM agents a
         LEFT JOIN paid_calls pc ON pc.agent_id = a.id
        WHERE a.seller_id = $1
     GROUP BY a.id
     ORDER BY a.created_at DESC`,
      [sellerId],
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(pc.amount_usdc) FILTER (WHERE pc.created_at > now() - interval '7 days'), 0)::text  AS last_7d,
         COALESCE(SUM(pc.amount_usdc) FILTER (WHERE pc.created_at > now() - interval '30 days'), 0)::text AS last_30d,
         COALESCE(SUM(pc.amount_usdc), 0)::text                                                            AS all_time,
         COUNT(*) FILTER (WHERE pc.created_at > now() - interval '7 days')                                 AS calls_7d
       FROM paid_calls pc
       JOIN agents a ON a.id = pc.agent_id
      WHERE a.seller_id = $1`,
      [sellerId],
    ),
  ]);

  res.json({
    seller_id: sellerId,
    agents: agents.rows,
    earnings: earnings.rows[0] ?? { last_7d: '0', last_30d: '0', all_time: '0', calls_7d: 0 },
  });
});

router.get('/seller/dashboard.csv', async (req: AuthRequest, res: Response) => {
  if (!req.user?.address) return res.status(401).json({ error: 'auth required' });
  const owner = req.user.address.toLowerCase();
  const sellerRow = await pool.query(`SELECT id FROM sellers WHERE wallet_address = $1`, [owner]);
  if (sellerRow.rowCount === 0) return res.status(404).send('no seller');
  const sellerId = sellerRow.rows[0].id;

  res.setHeader('content-type', 'text/csv');
  res.setHeader('content-disposition', `attachment; filename="seller-${sellerId}-audit.csv"`);
  res.write('agent_slug,kind,buyer,amount_usdc,rail,tx_hash,created_at\n');
  const r = await pool.query(
    `SELECT a.slug, a.kind, pc.buyer, pc.amount_usdc, pc.method, pc.tx_hash, pc.created_at
       FROM paid_calls pc
       JOIN agents a ON a.id = pc.agent_id
      WHERE a.seller_id = $1
   ORDER BY pc.created_at DESC`,
    [sellerId],
  );
  for (const row of r.rows) {
    res.write(
      `${row.slug},${row.kind},${row.buyer},${row.amount_usdc},${row.method},${row.tx_hash},${row.created_at.toISOString?.() ?? row.created_at}\n`,
    );
  }
  res.end();
});

export default router;
