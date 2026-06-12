import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '../db';
import * as ledger from '../services/paidCallLedger';
import type { AuthRequest } from './auth';
import { logger } from '../lib';

// Local subset of @fhe-brain/shared types — kept here to avoid a workspace
// cross-package dep just for three type aliases. Source of truth: packages/shared/src/types.ts.
type Rail = 'x402' | 'mpp' | 'sui_usdc';
interface AgentPricing { x402: string | null; mpp: string | null; sui_usdc: string | null }
interface AgentRecord {
  id: string;
  brain_id: number;
  owner_address: string;
  chain: 'fhenix' | 'sui';
  persona: { system_prompt: string; tools: string[]; model: string };
  pricing: AgentPricing;
  kya_required: boolean;
  min_reputation: number;
  published: boolean;
  created_at: Date;
}

/**
 * paymentGate — single middleware, three rails.
 *
 * Emits HTTP 402 with one `WWW-Authenticate: Payment …` header per rail the
 * agent has enabled. Spec source: docs.stripe.com/payments/machine/mpp +
 * x402 spec. The 402 envelope is identical for all rails — only the `method`
 * + per-rail metadata differ.
 *
 * Verification (mock-first):
 *   - Each emitted challenge_id is HMAC-signed with PAYMENT_SECRET.
 *   - The buyer retries with `Authorization: Payment <method> <challenge_id> <receipt>`.
 *   - We verify the HMAC + record an `agent_receipts` row.
 *   - Real rails are deferred — see docs/V3_PROPOSAL.md mock-first table.
 */

export interface PriceableRequest extends AuthRequest {
  pricedAgent?: AgentRecord;
  receipt?: { rail: Rail; tx_or_receipt: string; amount_usdc: string };
}

const PAYMENT_SECRET =
  process.env.PAYMENT_SECRET ?? 'dev-only-payment-secret-please-rotate';

interface ChallengeBody {
  rail: Rail;
  amount_usdc: string;
  endpoint: string;
  expires_at: number;
}

function signChallenge(body: ChallengeBody): string {
  const canonical = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', PAYMENT_SECRET).update(canonical).digest('base64url');
  return `${Buffer.from(canonical).toString('base64url')}.${sig}`;
}

function verifyChallenge(token: string): ChallengeBody | null {
  try {
    const [bodyB64, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', PAYMENT_SECRET).update(Buffer.from(bodyB64, 'base64url')).digest('base64url');
    if (sig !== expected) return null;
    const body: ChallengeBody = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
    if (body.expires_at < Date.now()) return null;
    return body;
  } catch {
    return null;
  }
}

const RAIL_TO_METHOD: Record<Rail, string> = {
  x402: 'exact',          // x402 "exact" scheme name
  mpp: 'tempo',           // MPP method name (Tempo USDC variant)
  sui_usdc: 'sui-usdc',
};

function emit402(res: Response, agent: AgentRecord, endpoint: string): void {
  const headers: string[] = [];
  const expires_at = Date.now() + 5 * 60 * 1000;
  const offers: { rail: Rail; amount: string }[] = [];

  for (const rail of ['x402', 'mpp', 'sui_usdc'] as Rail[]) {
    const amount = (agent.pricing as AgentPricing)[rail];
    if (!amount || amount === '0') continue;
    const id = signChallenge({ rail, amount_usdc: amount, endpoint, expires_at });
    headers.push(
      `Payment id="${id}", method="${RAIL_TO_METHOD[rail]}", currency="USDC", amount="${amount}"`,
    );
    offers.push({ rail, amount });
  }

  if (headers.length === 0) {
    // Agent has no rails enabled — treat as free.
    return;
  }

  for (const h of headers) res.append('WWW-Authenticate', h);
  res.status(402).type('application/problem+json').json({
    type: 'https://paymentauth.org/problems/payment-required',
    title: 'Payment Required',
    status: 402,
    detail: 'Payment required to invoke this agent.',
    rails: offers,
  });
}

/**
 * Express middleware. Loads the agent (req.params.id), checks for an
 * `Authorization: Payment <method> <challenge_id> <receipt>` header; on
 * success records the receipt and continues; on missing/invalid emits 402.
 */
export async function paymentGate(req: PriceableRequest, res: Response, next: NextFunction) {
  const agentId = req.params.id ?? req.params.agentId;
  if (!agentId) return res.status(400).json({ error: 'agent id required' });

  const r = await pool.query(
    `SELECT id, brain_id, owner_address, chain, persona, pricing, kya_required, min_reputation, published, created_at
     FROM agents WHERE id = $1 AND published = true`,
    [agentId],
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'agent not found' });
  const agent: AgentRecord = r.rows[0];
  req.pricedAgent = agent;

  // Freemium gate (T5/PRD-B): 5 free per (buyer × agent) before paywall.
  // Flag-gated so /v3 behavior is byte-identical with FEATURE_FHE_PAY=false.
  if (process.env.FEATURE_FHE_PAY === 'true') {
    const buyer = req.user?.address;
    if (buyer) {
      const freeLeft = await ledger.checkFreePreview(buyer, agent.id);
      if (freeLeft > 0) {
        await ledger.recordFree(buyer, agent.id, (agent as any).slug ?? '');
        res.setHeader('X-Free-Preview-Remaining', String(freeLeft - 1));
        req.receipt = { rail: 'x402', tx_or_receipt: 'free-preview', amount_usdc: '0' };
        logger.info({ agentId: agent.id, buyer, freeLeft: freeLeft - 1 }, 'paymentGate:freemium-pass');
        return next();
      }
    }
  }

  const authHeader = req.headers.authorization ?? '';
  if (!authHeader.startsWith('Payment ')) {
    return emit402(res, agent, req.originalUrl);
  }

  // Format: "Payment <method> <challenge_id> <receipt>"
  const [, method, challengeId, receipt] = authHeader.split(/\s+/);
  const body = verifyChallenge(challengeId ?? '');
  if (!body) return emit402(res, agent, req.originalUrl);

  // Method must match the rail in the verified body.
  const expectedMethod = RAIL_TO_METHOD[body.rail];
  if (method !== expectedMethod) return emit402(res, agent, req.originalUrl);

  // Mock receipt validation — accept any non-empty; production rails verify
  // tx receipts on-chain via the appropriate adapter.
  if (!receipt || receipt.length < 4) return emit402(res, agent, req.originalUrl);

  await pool.query(
    `INSERT INTO agent_receipts (agent_id, buyer, rail, amount_usdc, tx_or_receipt, bundle_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      agent.id,
      req.user?.address ?? 'anonymous',
      body.rail,
      body.amount_usdc,
      receipt,
      (req.headers['x-bundle-id'] as string | undefined) ?? null,
    ],
  );
  req.receipt = { rail: body.rail, tx_or_receipt: receipt, amount_usdc: body.amount_usdc };
  logger.info({ agentId: agent.id, rail: body.rail, amount: body.amount_usdc }, 'paymentGate:receipt');
  // Observability: increment per-rail counter (v3 metrics).
  try {
    const obs = await import('../lib/observability');
    obs.v3RailReceiptsTotal.inc({ rail: body.rail });
  } catch {/* never block the hot path */}
  next();
}
