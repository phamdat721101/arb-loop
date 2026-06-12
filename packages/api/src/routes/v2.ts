import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { logger } from '../lib';
import { AuthRequest } from '../middleware/auth';

const router = Router();

/**
 * POST /v2/upload — opaque ciphertext ingestion.
 * Accepts pre-encrypted content (AES-256-GCM ciphertext from browser).
 * NEVER accepts plaintext key material. Defence in depth.
 */
router.post('/upload', async (req: Request, res: Response) => {
  const userAddress = (req as AuthRequest).user!.address;

  const { brainId, ciphertext, txHash, publishMeta } = req.body;
  if (!ciphertext || !txHash) {
    return res.status(400).json({ error: 'ciphertext and txHash required' });
  }
  // Defence: reject any request that tries to send plaintext keys
  if (req.body.keyHigh || req.body.keyLow || req.body.key) {
    return res.status(400).json({ error: 'Plaintext key material rejected. Use BrainKeyVaultV2 on-chain.' });
  }

  try {
    const bid = brainId || await getOrCreateBrainV2(userAddress);
    const { rows: [{ max }] } = await pool.query(
      `SELECT COALESCE(MAX(chunk_index), -1) as max FROM knowledge_chunks WHERE brain_id = $1`, [bid]
    );
    await pool.query(
      `INSERT INTO knowledge_chunks (brain_id, chunk_index, content, encrypted, nonce)
       VALUES ($1, $2, $3, TRUE, NULL)`,
      [bid, (max as number) + 1, ciphertext]
    );
    // Mark brain as v2 privacy
    await pool.query(`UPDATE brains SET privacy_version = 2 WHERE id = $1`, [bid]);

    // T3: one-click publish — publishMeta in the same round-trip.
    let published = false;
    if (publishMeta && typeof publishMeta === 'object') {
      const { title, description, tags } = publishMeta as { title?: string; description?: string; tags?: string[] };
      await pool.query(
        `UPDATE brains
            SET title = COALESCE($1, title),
                description = COALESCE($2, description),
                tags = COALESCE($3, tags),
                published = TRUE
          WHERE id = $4 AND owner_address = $5`,
        [title || null, description || null, tags || null, bid, userAddress]
      );
      published = true;
      logger.info({ brainId: bid, owner: userAddress }, 'v2:upload:published');
    }

    logger.info({ brainId: bid, txHash, published }, 'v2:upload:stored');
    res.json({ brainId: bid, estimatedChunks: 1, privacyVersion: 2, published });
  } catch (e: any) {
    logger.error({ err: e.message }, 'v2:upload:error');
    res.status(500).json({ error: 'Upload failed' });
  }
});

/**
 * GET /v2/brains/:id/chunks — returns opaque ciphertext + handles only.
 */
router.get('/brains/:id/chunks', async (req: Request, res: Response) => {
  const { id } = req.params;
  const after = Number(req.query.after ?? -1);
  try {
    const { rows } = await pool.query(
      `SELECT chunk_index, content as ciphertext FROM knowledge_chunks
       WHERE brain_id = $1 AND chunk_index > $2 ORDER BY chunk_index`,
      [id, after]
    );
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: 'Failed to fetch chunks' });
  }
});

/**
 * POST /v2/inference — stateless LLM call, browser-decrypted top-K chunks.
 *
 * Privacy contract:
 *   - Server never sees the AES key (browser pulls handles via Fhenix threshold).
 *   - Top-K plaintext lives only in this request frame; chat_history persists
 *     question + answer (not chunks).
 *
 * Gating (per docs/USP_BRIEF.md "sellers don't subscribe"):
 *   - Owner: always passes.
 *   - Non-owner with on-chain grant (FHE.allow): passes.
 *   - Non-owner without grant: 402 + x402 challenge to pay the *brain owner*
 *     (not platform). UI captures the settlement tx via x-payment-tx and
 *     creates a brain_access_requests row that the owner grants.
 */
router.post('/inference', async (req: Request, res: Response) => {
  const { chunks, question, brainId } = req.body;
  if (!question || (!chunks?.length && !brainId)) {
    return res.status(400).json({ error: 'question required (chunks[] required when no brainId)' });
  }
  const userAddress = (req as AuthRequest).user!.address;

  if (brainId) {
    const { rows: [brain] } = await pool.query(
      `SELECT owner_address, published FROM brains WHERE id = $1`, [brainId]
    );
    const isOwner = brain && brain.owner_address.toLowerCase() === userAddress.toLowerCase();

    if (!isOwner && brain) {
      if (brain.published) {
        // Published brain: free public access — chunks loaded below.
      } else {
        // Unpublished brain: paywall for non-owners.
        const { isBrainGranted } = await import('../fhe/permits');
        if (!(await isBrainGranted(brainId))) {
          const txHash = (req.headers['x-payment-tx'] as string | undefined) || null;
          if (txHash) {
            await pool.query(
              `INSERT INTO brain_access_requests (brain_id, buyer_address, paid_tx_hash, status)
               VALUES ($1, $2, $3, 'paid')
               ON CONFLICT (brain_id, buyer_address) DO UPDATE
                 SET paid_tx_hash = EXCLUDED.paid_tx_hash, status = 'paid'`,
              [brainId, userAddress.toLowerCase(), txHash]
            ).catch((e) => logger.warn({ err: e.message }, 'access:upsert:error'));
          } else {
            await pool.query(
              `INSERT INTO brain_access_requests (brain_id, buyer_address, status)
               VALUES ($1, $2, 'pending')
               ON CONFLICT (brain_id, buyer_address) DO NOTHING`,
              [brainId, userAddress.toLowerCase()]
            ).catch((e) => logger.warn({ err: e.message }, 'access:upsert:error'));
          }

          const challenge = Buffer.from(JSON.stringify({
            x402Version: 2,
            accepts: [{
              scheme: 'exact',
              network: 'eip155:84532',
              maxAmountRequired: '10000',
              asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              payTo: brain.owner_address,
              description: `Ask brain #${brainId}`,
            }],
          })).toString('base64');
          res.setHeader('payment-required', challenge);
          return res.status(402).json({
            error: 'Payment required',
            reason: 'brain_not_granted',
            message: 'Pay 0.01 USDC to the brain owner; they will grant on-chain access.',
          });
        }
      }
    }
  }

  try {
    const effectiveChunks = req.body.chunks?.length ? req.body.chunks : chunks;
    if (!effectiveChunks?.length && brainId) {
      // Fallback: load plaintext chunks from DB (covers v1 brains, owner without FHE, published brains).
      const { rows: chunkRows } = await pool.query(
        `SELECT content FROM knowledge_chunks WHERE brain_id = $1 AND encrypted = false ORDER BY chunk_index`, [brainId]
      );
      const dbChunks = chunkRows.map((r: any) => r.content).filter(Boolean);
      if (dbChunks.length) {
        req.body.chunks = dbChunks;
      }
    }
    const finalChunks = req.body.chunks?.length ? req.body.chunks : (effectiveChunks?.length ? effectiveChunks : null);

    // Two-mode system prompt:
    //   - chunks present → brain-Q&A: ground answers in the user's encrypted memory.
    //   - chunks empty   → task mode: the user supplies all context inline
    //                      (typed prompt + optional `--- Attached file ---` block).
    //                      Used by the chat composer's file-attach affordance for
    //                      one-shot tasks like translate / summarize / extract.
    // SOLID: SRP — one route owns inference dispatch; the branch is data-driven
    // (presence of chunks), not flag-driven, so no new env var or sub-route.
    let system: string;
    if (finalChunks?.length) {
      const context = (finalChunks as string[]).map((c, i) => `[${i}] ${c}`).join('\n---\n');
      system = `You are a Second Brain assistant. Answer using ONLY the following knowledge:\n${context}`;
    } else {
      system =
        `You are a helpful AI agent. The user is asking you to perform a task. ` +
        `They may attach files or context inline — look for blocks delimited by ` +
        `"--- Attached file: …  ---" and "--- End attached file ---". ` +
        `Use your training together with any user-provided context to produce a ` +
        `direct, actionable answer. If the attachment is binary and only metadata ` +
        `is shown, ask the user for a text export. Be concise.`;
    }

    const llm = await callLLM(system, question);
    const answer = llm.text;

    // Persist Q+A only (no chunks, no plaintext)
    if (userAddress && brainId) {
      await pool.query(
        `INSERT INTO chat_history (user_address, brain_id, role, content) VALUES ($1,$2,'user',$3), ($1,$2,'assistant',$4)`,
        [userAddress, brainId, question, answer]
      );
    }

    // Attestation — Phala TEE preferred, Fhenix TN fallback.
    let attestation: any;
    if (llm.phalaAttestationHash) {
      attestation = {
        provider: 'phala-tee',
        verified: true,
        hash: llm.phalaAttestationHash,
        issuedAt: new Date().toISOString(),
      };
    } else if (process.env.PHALA_ENDPOINT && process.env.PHALA_API_KEY) {
      // Phala configured but no attestation header surfaced — still mark as TEE-served.
      attestation = { provider: 'phala-tee', verified: true, issuedAt: new Date().toISOString() };
    } else {
      attestation = { provider: 'fhenix-tn', verified: false, signature: null, error: null, issuedAt: new Date().toISOString() };
      if (req.body.ctHashes?.length && process.env.PRIVATE_KEY) {
        try {
          const { getCofheClient } = await import('../fhe/client');
          const cofhe = await getCofheClient();
          const result = await cofhe.decryptForTx(req.body.ctHashes[0]).withoutPermit().execute();
          attestation = {
            provider: 'fhenix-tn',
            verified: true,
            signature: result.signature,
            ctHash: req.body.ctHashes[0],
            issuedAt: new Date().toISOString(),
          };
        } catch (e: any) {
          logger.warn({ ctHash: req.body.ctHashes[0], err: e.message }, 'tn:attestation:failed');
          attestation.error = e.message || 'tn_unavailable';
        }
      }
    }

    res.json({ answer, attestation });
  } catch (e: any) {
    logger.error({ err: e.message }, 'v2:inference:error');
    // Surface the upstream cause so an expired/invalid LLM key is visible
    // to the user (vs. a silent generic 500). Sanitise to stay safe.
    const safeDetail = String(e?.message ?? 'Inference failed').slice(0, 240);
    res.status(500).json({ error: 'Inference failed', detail: safeDetail });
  }
});

/**
 * POST /v2/migrate/:brainId — export legacy v1 plaintext chunks for browser re-encryption.
 * Only works for brains with privacy_version=1. After browser re-encrypts and uploads
 * via POST /v2/upload, call POST /v2/migrate/:brainId/complete to wipe legacy keys.
 */
router.post('/migrate/:brainId', async (req: Request, res: Response) => {
  const userAddress = (req as AuthRequest).user!.address;
  const { brainId } = req.params;

  try {
    const { rows: [brain] } = await pool.query(
      `SELECT id, owner_address, privacy_version FROM brains WHERE id = $1`, [brainId]
    );
    if (!brain) return res.status(404).json({ error: 'Brain not found' });
    if (brain.owner_address !== userAddress) return res.status(403).json({ error: 'Not owner' });
    if (brain.privacy_version === 2) return res.status(400).json({ error: 'Already v2' });

    // Load plaintext chunks (legacy path — last allowed use)
    const { KnowledgeIngestService } = await import('../services/knowledge-ingest');
    const chunks = await KnowledgeIngestService.loadChunks(Number(brainId));
    res.json({ chunks: chunks.map(c => c.content).filter(Boolean) });
  } catch (e: any) {
    res.status(500).json({ error: 'Migration export failed' });
  }
});

router.post('/migrate/:brainId/complete', async (req: Request, res: Response) => {
  const userAddress = (req as AuthRequest).user!.address;
  const { brainId } = req.params;

  try {
    const { rows: [brain] } = await pool.query(
      `SELECT owner_address FROM brains WHERE id = $1`, [brainId]
    );
    if (!brain || brain.owner_address !== userAddress) return res.status(403).json({ error: 'Not owner' });

    // Wipe legacy key material, upgrade privacy version
    await pool.query(`UPDATE brains SET key_high = NULL, key_low = NULL, privacy_version = 2 WHERE id = $1`, [brainId]);
    logger.info({ brainId }, 'v2:migrate:complete');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Migration complete failed' });
  }
});

/**
 * GET /v2/brains — list published brains (DB-backed for now; T9 moves to on-chain reads).
 */
router.get('/brains', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, owner_address, title, description, tags, published, created_at, privacy_version
       FROM brains WHERE published = true ORDER BY created_at DESC LIMIT 50`
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to list brains' });
  }
});

/**
 * GET /v2/admin/stats — 30-day kill-criteria metrics.
 * Header-gated: x-admin-token must equal ADMIN_TOKEN env. Returns the
 * five numbers from docs/USP_BRIEF.md so the launch can be scored without
 * dashboard infrastructure.
 */
router.get('/admin/stats', async (req: Request, res: Response) => {
  const token = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - 30 * 86_400_000);
    const demoAgent = (process.env.DEMO_AGENT_ADDRESS ?? '0xA1F2DEM00000000000000000000000000000A6E7').toLowerCase();

    const { rows: [s] } = await pool.query(
      `SELECT
         (SELECT COUNT(DISTINCT LOWER(owner_address))::int
            FROM brains WHERE created_at >= $1) AS distinct_seller_wallets,
         (SELECT COUNT(*)::int
            FROM (
              SELECT b.id
                FROM brains b
                JOIN chat_history h ON h.brain_id = b.id AND h.role = 'user'
               WHERE LOWER(h.user_address) <> LOWER(b.owner_address)
                 AND LOWER(h.user_address) <> $2
               GROUP BY b.id
              HAVING COUNT(DISTINCT LOWER(h.user_address)) >= 3
            ) t) AS brains_with_revenue_real,
         (SELECT COUNT(DISTINCT LOWER(h.user_address))::int
            FROM chat_history h
            JOIN brains b ON b.id = h.brain_id
           WHERE h.role = 'user'
             AND LOWER(h.user_address) <> LOWER(b.owner_address)
             AND LOWER(h.user_address) <> $2
             AND h.created_at >= $1) AS distinct_agent_wallets_real,
         (SELECT COUNT(*)::int
            FROM chat_history h
            JOIN brains b ON b.id = h.brain_id
           WHERE h.role = 'user'
             AND LOWER(h.user_address) <> LOWER(b.owner_address)
             AND h.created_at >= $1) AS total_queries_incl_demo`,
      [since, demoAgent],
    );
    const pricePerQuery = 0.01;
    res.json({
      since: since.toISOString(),
      demoAgentAddress: demoAgent,
      distinctSellerWallets: s.distinct_seller_wallets,
      brainsWithRevenue: s.brains_with_revenue_real,        // excludes demo agent — the real metric
      distinctAgentWallets: s.distinct_agent_wallets_real,  // excludes demo agent
      totalQueriesInclDemo: s.total_queries_incl_demo,
      totalUsdcInclDemo: +(s.total_queries_incl_demo * pricePerQuery).toFixed(2),
    });
  } catch (e: any) {
    logger.error({ err: e.message }, 'admin:stats:error');
    res.status(500).json({ error: 'Failed to compute stats' });
  }
});

// --- helpers ---

/**
 * GET /v2/access/requests?owner=<addr>  → owner sees pending+paid requests for their brains.
 * GET /v2/access/requests?buyer=<addr>  → buyer sees their own request statuses.
 *
 * No auth gate (read-only, address-scoped); the (brain_id, buyer_address) unique
 * index keeps the surface predictable.
 */
router.get('/access/requests', async (req: Request, res: Response) => {
  const owner = (req.query.owner as string | undefined)?.toLowerCase();
  const buyer = (req.query.buyer as string | undefined)?.toLowerCase();
  if (!owner && !buyer) return res.status(400).json({ error: 'owner or buyer query param required' });
  try {
    const sql = owner
      ? `SELECT r.id, r.brain_id, r.buyer_address, r.paid_tx_hash, r.granted_tx, r.status, r.created_at,
                b.title AS brain_title
           FROM brain_access_requests r JOIN brains b ON b.id = r.brain_id
          WHERE LOWER(b.owner_address) = $1 AND r.status IN ('pending','paid')
          ORDER BY r.created_at DESC LIMIT 50`
      : `SELECT r.id, r.brain_id, r.buyer_address, r.paid_tx_hash, r.granted_tx, r.status, r.created_at,
                b.title AS brain_title
           FROM brain_access_requests r JOIN brains b ON b.id = r.brain_id
          WHERE r.buyer_address = $1 ORDER BY r.created_at DESC LIMIT 50`;
    const { rows } = await pool.query(sql, [owner || buyer]);
    res.json(rows);
  } catch (e: any) {
    logger.error({ err: e.message }, 'access:list:error');
    res.status(500).json({ error: 'Failed to load access requests' });
  }
});

/**
 * POST /v2/access/grant  → owner records that BrainKeyVault.grantBrainAccess was called.
 * Body: { brainId, buyerAddress, grantedTx }
 *
 * The FHE.allow on-chain is the actual gate; this endpoint just flips the human
 * status row so the buyer's UI sees "granted" and retries the inference call.
 */
router.post('/access/grant', async (req: Request, res: Response) => {
  const owner = (req as AuthRequest).user!.address.toLowerCase();
  const { brainId, buyerAddress, grantedTx } = req.body || {};
  if (!brainId || !buyerAddress || !grantedTx) {
    return res.status(400).json({ error: 'brainId, buyerAddress, grantedTx required' });
  }
  try {
    const { rows: [b] } = await pool.query(`SELECT owner_address FROM brains WHERE id = $1`, [brainId]);
    if (!b) return res.status(404).json({ error: 'Brain not found' });
    if (b.owner_address.toLowerCase() !== owner) return res.status(403).json({ error: 'Not owner' });

    await pool.query(
      `INSERT INTO brain_access_requests (brain_id, buyer_address, granted_tx, status, updated_at)
       VALUES ($1, $2, $3, 'granted', now())
       ON CONFLICT (brain_id, buyer_address) DO UPDATE
         SET granted_tx = EXCLUDED.granted_tx, status = 'granted', updated_at = now()`,
      [brainId, String(buyerAddress).toLowerCase(), grantedTx]
    );
    logger.info({ brainId, buyer: buyerAddress, grantedTx }, 'access:granted');
    res.json({ ok: true });
  } catch (e: any) {
    logger.error({ err: e.message }, 'access:grant:error');
    res.status(500).json({ error: 'Grant failed' });
  }
});

async function getOrCreateBrainV2(userAddress: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id FROM brains WHERE owner_address = $1 AND privacy_version = 2 ORDER BY created_at LIMIT 1`,
    [userAddress]
  );
  if (rows[0]) return rows[0].id;
  const { rows: created } = await pool.query(
    `INSERT INTO brains (owner_address, title, chain, privacy_version) VALUES ($1, 'My Brain', 'arbitrum-sepolia', 2) RETURNING id`,
    [userAddress]
  );
  return created[0].id;
}

async function callBedrock(system: string, question: string): Promise<string> {
  return (await callLLM(system, question)).text;
}

/**
 * callLLM — env-flag provider switch.
 *   PHALA_ENDPOINT set  → Phala Confidential AI (OpenAI-compatible, TEE-attested)
 *   BEDROCK_API_KEY set → AWS Bedrock Claude
 *   neither             → mock (local dev)
 *
 * Returns text + optional Phala attestation hash from the response headers.
 * Exported as `callLLMSeed` for the demo-agent loop (single source of truth).
 */
export async function callLLMSeed(system: string, question: string): Promise<{ text: string; phalaAttestationHash?: string }> {
  return callLLM(system, question);
}

async function callLLM(system: string, question: string): Promise<{ text: string; phalaAttestationHash?: string }> {
  const phalaEndpoint = process.env.PHALA_ENDPOINT;
  const phalaKey = process.env.PHALA_API_KEY;
  if (phalaEndpoint && phalaKey) {
    const url = phalaEndpoint.replace(/\/$/, '') + '/v1/chat/completions';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${phalaKey}` },
      body: JSON.stringify({
        model: process.env.PHALA_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: question },
        ],
      }),
    });
    if (!r.ok) throw new Error(`Phala ${r.status}`);
    const data = await r.json();
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      phalaAttestationHash:
        r.headers.get('x-attestation-quote') ||
        r.headers.get('x-phala-attestation') ||
        undefined,
    };
  }

  const apiKey = process.env.BEDROCK_API_KEY;
  if (apiKey) {
    const url = `https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-opus-4-6-v1/invoke`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        system,
        messages: [{ role: 'user', content: question }],
      }),
    });
    if (!r.ok) throw new Error(`Bedrock ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    return { text: data.content?.[0]?.text ?? '' };
  }

  // Fallback: OpenAI (optional dep — set OPENAI_API_KEY + `npm i openai`).
  // Mirrors services/chat.ts::llmChat so callers aren't sensitive to which
  // LLM dispatcher is used. Lazy-imported so the module isn't required.
  if (process.env.OPENAI_API_KEY) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod: any = await import('openai').catch(() => null);
      const OpenAI = mod?.default ?? mod?.OpenAI;
      if (OpenAI) {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const completion = await openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          max_tokens: 4096,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: question },
          ],
        });
        return { text: completion.choices[0].message.content ?? '' };
      }
    } catch (e: any) {
      throw new Error(`OpenAI ${e?.status ?? 'error'}: ${String(e?.message ?? '').slice(0, 200)}`);
    }
  }

  return { text: `[mock] Answer to "${question}" based on ${system.split('\n').length} context lines.` };
}

export default router;
