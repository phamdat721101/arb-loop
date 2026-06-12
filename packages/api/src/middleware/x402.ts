/**
 * middleware/x402.ts — x402 fast-lane gating for arb-loop.
 *
 * Single file owns the entire wire-format dance:
 *   1. No X-PAYMENT header → return HTTP 402 + challenge envelope.
 *   2. Header present:
 *      a. Parse + verify EIP-3009 sig (off-chain).
 *      b. Settle on-chain: USDC.transferWithAuthorization() → X402Router.
 *      c. Call X402Router.distribute() (3 inline transfers).
 *      d. Persist row in arbloop_x402_settlements.
 *      e. Attach req.x402Settlement; route handler runs the agent.
 *
 * Per essential-files mandate, the facilitator helpers live inline rather
 * than in a separate x402Facilitator.ts. ~200 LOC total stays readable.
 *
 * SOLID:
 *   - SRP: payment gating only. The route handler runs the agent.
 *   - DIP: ethers Provider + Wallet are constructed once via env at module
 *     load (no per-request reconstruction).
 *   - Resiliency: each error path returns a structured 402 with a code
 *     the buyer client can react to (bad_sig, expired, insufficient,
 *     nonce_used, rate_limit).
 */

import type { Request, Response, NextFunction } from 'express';
import { JsonRpcProvider, Wallet, Contract, Interface, getAddress } from 'ethers';
import { pool } from '../db';
import {
  buildChallenge,
  buildPaymentResponseHeader,
  parsePaymentHeader,
  verifyAuthorization,
  settleAuthorization,
  USDC_DOMAINS,
  type Eip3009Domain,
} from '@fhe-ai-context/sdk';

// ─── Module config (env, instantiated once) ──────────────────────────────

const NETWORK = (process.env.ARBLOOP_NETWORK ?? 'arbitrum-sepolia') as 'arbitrum-sepolia' | 'arbitrum';
const CHAIN_ID = NETWORK === 'arbitrum' ? 42161 : 421614;
const USDC_ADDRESS = (process.env.ARBLOOP_USDC_ADDRESS
  ?? (NETWORK === 'arbitrum' ? '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' : '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d')) as `0x${string}`;
const X402_ROUTER_ADDRESS = (process.env.ARBLOOP_X402_ROUTER_ADDRESS ?? '') as `0x${string}`;
const RPC_URL = process.env.RPC_URL_ARBITRUM_SEPOLIA ?? process.env.ARBITRUM_SEPOLIA_RPC ?? 'https://sepolia-rollup.arbitrum.io/rpc';
const FACILITATOR_KEY = process.env.ARBLOOP_FACILITATOR_PRIVATE_KEY ?? process.env.RELAYER_PRIVATE_KEY ?? '';

const usdcDomain: Eip3009Domain = NETWORK === 'arbitrum' ? USDC_DOMAINS.arbitrum : USDC_DOMAINS.arbitrumSepolia;

// Rate-limit cache (in-process; production should switch to Redis).
const rateBucket = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_PER_HOUR = Number(process.env.ARBLOOP_X402_RATE_LIMIT_PER_HOUR ?? 100);

// ─── Types attached to req for downstream handlers ───────────────────────

declare module 'express-serve-static-core' {
  interface Request {
    x402Settlement?: {
      txHash: `0x${string}`;
      amountMicroUsdc: bigint;
      payer: `0x${string}`;
      seller: `0x${string}`;
      agentId: number;
    };
  }
}

// ─── Facilitator helpers (inline) ────────────────────────────────────────

const X402_ROUTER_ABI = [
  'function distribute(uint256 agentId, uint256 amount, address payer, address seller)',
  'function distributeWithSplits(uint256 agentId, uint256 amount, address payer, address seller, uint16 sellerBps, uint16 computeBps, uint16 platformBps)',
] as const;

let cachedFacilitator: Wallet | null = null;
function facilitatorWallet(): Wallet {
  if (!cachedFacilitator) {
    if (!FACILITATOR_KEY) throw new Error('x402:env:facilitator_key_missing');
    cachedFacilitator = new Wallet(FACILITATOR_KEY, new JsonRpcProvider(RPC_URL));
  }
  return cachedFacilitator;
}

async function checkRateLimit(payer: string): Promise<{ ok: boolean; remaining: number }> {
  const now = Date.now();
  const hourMs = 3600_000;
  const entry = rateBucket.get(payer);
  if (!entry || now - entry.windowStart > hourMs) {
    rateBucket.set(payer, { count: 1, windowStart: now });
    return { ok: true, remaining: RATE_LIMIT_PER_HOUR - 1 };
  }
  if (entry.count >= RATE_LIMIT_PER_HOUR) return { ok: false, remaining: 0 };
  entry.count += 1;
  return { ok: true, remaining: RATE_LIMIT_PER_HOUR - entry.count };
}

async function lookupAgent(agentId: number): Promise<{ seller: `0x${string}`; perIterMicro: bigint } | null> {
  const r = await pool.query(
    `SELECT seller_address, per_iter_default_micro_usdc
       FROM arbloop_agents_metadata
      WHERE agent_id = $1 AND revoked = FALSE
      LIMIT 1`,
    [agentId],
  );
  if (r.rowCount === 0) return null;
  return {
    seller: getAddress(r.rows[0].seller_address) as `0x${string}`,
    perIterMicro: BigInt(r.rows[0].per_iter_default_micro_usdc),
  };
}

// ─── Public middleware factory ───────────────────────────────────────────

export function x402Middleware() {
  return async function x402Mw(req: Request, res: Response, next: NextFunction) {
    if (process.env.FEATURE_ARBLOOP_X402 !== 'true') return res.status(404).json({ error: 'x402_disabled' });

    const agentId = Number(req.params.agentId ?? req.params.id);
    if (!Number.isFinite(agentId)) return res.status(400).json({ error: 'bad_agent_id' });

    const agent = await lookupAgent(agentId);
    if (!agent) return res.status(404).json({ error: 'agent_not_found' });

    const resourceUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const xPayment = req.header('X-PAYMENT');

    if (!xPayment) {
      const challenge = buildChallenge({
        network: NETWORK,
        usdc: USDC_ADDRESS,
        payTo: X402_ROUTER_ADDRESS,
        maxAmountMicroUsdc: agent.perIterMicro,
        resource: resourceUrl,
        agentId,
      });
      return res.status(402).json(challenge);
    }

    let parsed;
    try { parsed = parsePaymentHeader(xPayment); }
    catch { return res.status(402).json({ error: 'bad_x_payment_header', code: 'parse_error' }); }

    const auth = parsed.authorization;
    const payer = (auth.from as string).toLowerCase();

    // Rate limit per payer.
    const rl = await checkRateLimit(payer);
    if (!rl.ok) return res.status(429).json({ error: 'rate_limit', remaining: rl.remaining });

    // Validity window.
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const validBefore = BigInt(auth.validBefore as string);
    const validAfter = BigInt(auth.validAfter as string);
    if (nowSec >= validBefore) return res.status(402).json({ error: 'authorization_expired', code: 'expired' });
    if (nowSec < validAfter) return res.status(402).json({ error: 'authorization_not_yet_valid', code: 'too_early' });

    // Amount must >= per-iter cost.
    const amount = BigInt(auth.value as string);
    if (amount < agent.perIterMicro) {
      return res.status(402).json({ error: 'insufficient_amount', code: 'insufficient', required: agent.perIterMicro.toString() });
    }

    // pay_to must be the X402Router (server-trusted).
    if ((auth.to as string).toLowerCase() !== X402_ROUTER_ADDRESS.toLowerCase()) {
      return res.status(402).json({ error: 'bad_pay_to', code: 'wrong_recipient' });
    }

    // 1. Verify EIP-3009 sig off-chain.
    const ok = await verifyAuthorization({ domain: usdcDomain, authorization: auth, signature: parsed.signature })
      .catch(() => false);
    if (!ok) return res.status(402).json({ error: 'bad_signature', code: 'bad_sig' });

    // 2. Idempotency: nonce already used in last 24h?
    const dup = await pool.query(
      `SELECT 1 FROM arbloop_x402_settlements
        WHERE payer_address = $1 AND request_correlation_id = $2
        LIMIT 1`,
      [payer, auth.nonce],
    );
    if ((dup.rowCount ?? 0) > 0) {
      return res.status(402).json({ error: 'nonce_used', code: 'replay' });
    }

    // 3. Settle on-chain.
    let settleTx: `0x${string}`;
    try {
      const r = await settleAuthorization({
        rpcUrl: RPC_URL,
        facilitatorPrivateKey: FACILITATOR_KEY,
        usdcAddress: USDC_ADDRESS,
        authorization: auth,
        signature: parsed.signature,
      });
      settleTx = r.txHash;
    } catch (e) {
      return res.status(402).json({ error: 'settle_failed', code: 'on_chain', detail: String(e) });
    }

    // 4. Distribute via X402Router.
    let distributeTx: `0x${string}`;
    try {
      const router = new Contract(X402_ROUTER_ADDRESS, X402_ROUTER_ABI, facilitatorWallet());
      const tx = await router.distribute(agentId, amount, payer, agent.seller);
      const rc = await tx.wait();
      if (!rc) throw new Error('no_receipt');
      distributeTx = rc.hash as `0x${string}`;
    } catch (e) {
      return res.status(402).json({ error: 'distribute_failed', code: 'on_chain', detail: String(e), settle_tx: settleTx });
    }

    // 5. Persist settlement (idempotency record + audit log).
    await pool.query(
      `INSERT INTO arbloop_x402_settlements
         (tx_hash, agent_id, agent_registry_addr, payer_address, seller_address,
          amount_micro_usdc, seller_cut_micro, compute_cut_micro, platform_cut_micro,
          splits_json, request_correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [
        distributeTx, agentId,
        process.env.ARBLOOP_AGENT_REGISTRY_V2_ADDRESS ?? '',
        payer, agent.seller.toLowerCase(),
        amount.toString(),
        ((amount * 7000n) / 10000n).toString(),
        ((amount * 2500n) / 10000n).toString(),
        (amount - (amount * 7000n) / 10000n - (amount * 2500n) / 10000n).toString(),
        JSON.stringify({ sellerBps: 7000, computeBps: 2500, platformBps: 500 }),
        auth.nonce,
      ],
    ).catch(() => undefined);

    // 6. Attach to req for the route handler.
    req.x402Settlement = {
      txHash: distributeTx,
      amountMicroUsdc: amount,
      payer: payer as `0x${string}`,
      seller: agent.seller,
      agentId,
    };

    // 7. Set the response header so the buyer client can record the tx.
    res.setHeader('X-PAYMENT-RESPONSE', buildPaymentResponseHeader({
      txHash: distributeTx,
      network: NETWORK,
      amountMicroUsdc: amount,
    }));

    next();
  };
}
