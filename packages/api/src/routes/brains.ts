import { Router } from 'express';
import { auth, AuthRequest } from '../middleware/auth';
import { pool } from '../db';
import { logger } from '../lib';

const router = Router();

router.get('/', async (req, res) => {
  const { page = '1', limit = '20' } = req.query;
  const offset = (+page - 1) * +limit;
  const { rows } = await pool.query(
    `SELECT id, owner_address, title, description, tags, created_at FROM brains WHERE published = true ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [+limit, offset]
  );
  res.json(rows);
});

router.get('/search', async (req, res) => {
  const { q = '', tags } = req.query;
  const tagArr = tags ? (tags as string).split(',') : [];
  const { rows } = await pool.query(
    `SELECT id, owner_address, title, description, tags, created_at FROM brains WHERE published = true AND (title ILIKE $1 OR description ILIKE $1 OR tags && $2::text[]) LIMIT 20`,
    [`%${q}%`, tagArr]
  );
  res.json(rows);
});

router.get('/mine', auth, async (req: AuthRequest, res) => {
  // owner_address storage is inconsistent across creation paths (legacy
  // /brains/create stores the header verbatim; v2 sellerPublishService
  // lowercases). LOWER() on both sides gives studio/marketplace parity
  // without a backfill migration. Mirrors the existing pattern at line 53.
  const { rows } = await pool.query(
    `SELECT * FROM brains WHERE LOWER(owner_address) = LOWER($1) ORDER BY created_at DESC`,
    [req.user!.address]
  );
  res.json(rows);
});

/**
 * GET /brains/earnings/:wallet — what this seller has earned.
 * Auth-gated; sellers see only their own. Sellers do NOT need a subscription.
 *
 * Earnings model (v0): every chat_history row authored by a non-owner is
 * counted as one paid query at PRICE_PER_QUERY_USDC. Demo agent traffic is
 * deliberately included — the seller seeing traffic IS the magic moment.
 */
const PRICE_PER_QUERY_USDC = 0.01;
router.get('/earnings/:wallet', auth, async (req: AuthRequest, res) => {
  const wallet = req.params.wallet.toLowerCase();
  if (req.user!.address.toLowerCase() !== wallet) {
    return res.status(403).json({ error: 'Can only view your own earnings' });
  }
  try {
    const { rows: brains } = await pool.query(
      `SELECT b.id, b.title, b.tags,
              COUNT(h.id) FILTER (WHERE h.role = 'user' AND LOWER(h.user_address) <> LOWER(b.owner_address)) AS query_count,
              MAX(h.created_at) FILTER (WHERE h.role = 'user' AND LOWER(h.user_address) <> LOWER(b.owner_address)) AS last_at
         FROM brains b
         LEFT JOIN chat_history h ON h.brain_id = b.id
        WHERE LOWER(b.owner_address) = $1
        GROUP BY b.id
        ORDER BY query_count DESC NULLS LAST, b.id DESC`,
      [wallet],
    );
    const { rows: receipts } = await pool.query(
      `SELECT h.brain_id, h.user_address AS agent_address, h.created_at, b.title AS brain_title
         FROM chat_history h
         JOIN brains b ON b.id = h.brain_id
        WHERE h.role = 'user'
          AND LOWER(b.owner_address) = $1
          AND LOWER(h.user_address) <> $1
        ORDER BY h.created_at DESC
        LIMIT 50`,
      [wallet],
    );

    // /api/v1 paid calls — the real on-chain settled receipts.
    const { rows: paidCallRows } = await pool.query(
      `SELECT pc.slug, pc.buyer, pc.amount_usdc, pc.tx_hash, pc.network, pc.method, pc.created_at,
              a.brain_id
         FROM paid_calls pc
         JOIN agents a ON a.id = pc.agent_id
        WHERE LOWER(a.owner_address) = $1
        ORDER BY pc.created_at DESC
        LIMIT 50`,
      [wallet],
    );
    const settledTotalUsdc = paidCallRows.reduce((s, r) => s + Number(r.amount_usdc || 0), 0);

    const totalQueries = brains.reduce((s, r) => s + Number(r.query_count || 0), 0);
    const totalUsdc = +(totalQueries * PRICE_PER_QUERY_USDC).toFixed(2);
    res.json({
      wallet,
      pricePerQueryUsdc: PRICE_PER_QUERY_USDC,
      totalQueries,
      totalUsdc,
      // New: real settled revenue (on-chain). Frontend can display both.
      settledTotalUsdc: +settledTotalUsdc.toFixed(6),
      settledCallCount: paidCallRows.length,
      brains: brains.map((b) => ({
        id: b.id,
        title: b.title,
        tags: b.tags ?? [],
        queryCount: Number(b.query_count || 0),
        earnedUsdc: +((Number(b.query_count || 0)) * PRICE_PER_QUERY_USDC).toFixed(2),
        lastAt: b.last_at,
      })),
      receipts: receipts.map((r) => ({
        brainId: r.brain_id,
        brainTitle: r.brain_title,
        agentAddress: r.agent_address,
        amount: PRICE_PER_QUERY_USDC.toFixed(2),
        currency: 'USDC',
        at: r.created_at,
      })),
      paidCalls: paidCallRows.map((r) => ({
        slug: r.slug,
        buyer: r.buyer,
        amountUsdc: r.amount_usdc,
        txHash: r.tx_hash,
        network: r.network,
        method: r.method,
        explorerUrl: `https://sepolia.arbiscan.io/tx/${r.tx_hash}`,
        at: r.created_at,
      })),
    });
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to load earnings' });
  }
});

router.post('/create', auth, async (req: AuthRequest, res) => {
  // Chain dispatch: the FHE permit gate is EVM-only — Fhenix CoFHE wraps
  // the AES key on Arbitrum, so EVM sellers must authorize a permit. The
  // Sui trustless tier uses Seal IBE-wrapping at the brain level, so the
  // platform permit doesn't apply (G5: EVM behavior is byte-identical
  // for clients that don't send `x-chain`).
  const isSui = String(req.header('x-chain') ?? '').toLowerCase() === 'sui';

  // Sui identity verification removed in arb-mem (Arbitrum-only build).
  // The legacy `x-sui-*` headers are silently ignored; strict mode is a
  // no-op. Single swap-point preserved for future re-introduction.
  if (isSui) {
    return res.status(410).json({ error: 'sui_disabled', detail: 'arbitrum_only_build' });
  }
  if (!req.user?.hasPermit) {
    return res.status(403).json({
      error: 'Permit required',
      reason: req.user?.permitReason ?? 'never_authorized',
      message: 'Authorize the FHE permit before creating your first agent.',
    });
  }

  const { title = 'New Brain' } = req.body;
  const chain = isSui ? (process.env.SUI_NETWORK ?? 'sui-testnet') : 'arbitrum-sepolia';
  const { rows } = await pool.query(
    `INSERT INTO brains (owner_address, title, chain) VALUES ($1, $2, $3) RETURNING *`,
    [req.user!.address, title, chain]
  );
  res.json(rows[0]);
});

router.get('/:id', async (req, res) => {
  // Standard-tier brains use INTEGER ids (auto-increment in `brains.id`).
  // Reject non-numeric params at the boundary so a malformed id (e.g. a
  // trustless tx digest accidentally routed here) cannot reach Postgres
  // and trigger an unhandled rejection that crashes the process.
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ error: 'Brain not found' });
  }
  try {
    const { rows } = await pool.query(`SELECT * FROM brains WHERE id = $1`, [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Brain not found' });
    res.json(rows[0]);
  } catch (err) {
    logger.warn({ err: (err as Error).message, id }, 'brains:get-by-id:error');
    res.status(503).json({ error: 'temporary' });
  }
});

router.post('/publish', auth, async (req: AuthRequest, res) => {
  // Publish is a DB-flag flip plus a fire-and-forget on-chain call signed by
  // the platform wallet. The user's FHE permit is irrelevant here — ownership
  // is enforced by the WHERE owner_address = req.user.address clause below.
  const { brainId, title, description, tags } = req.body;
  let txHash: string | null = null;
  if (brainId) {
    const { rows } = await pool.query(
      `UPDATE brains SET title = COALESCE($1, title), description = COALESCE($2, description), tags = COALESCE($3, tags), published = true WHERE id = $4 AND owner_address = $5 RETURNING *`,
      [title, description, tags || [], brainId, req.user!.address]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Brain not found or not owned' });
    // On-chain publish (fire-and-forget)
    try {
      const { ethers } = await import('ethers');
      const addr = process.env.KNOWLEDGE_REGISTRY_ADDRESS;
      if (process.env.PRIVATE_KEY && addr) {
        const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc');
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        const contract = new ethers.Contract(addr, ['function publish(uint256 brainId)'], wallet);
        const tx = await contract.publish(brainId);
        txHash = tx.hash;
      }
    } catch {}
    return res.json({ ...rows[0], txHash });
  }
  const { rows } = await pool.query(
    `INSERT INTO brains (owner_address, title, description, tags, published, chain) VALUES ($1,$2,$3,$4,true,'arbitrum-sepolia') RETURNING *`,
    [req.user!.address, title || 'Untitled', description || '', tags || []]
  );
  res.json(rows[0]);
});

export default router;
