import { Request, Response, NextFunction } from 'express';
import type { PermitReason } from '../fhe/permits';

export interface AuthRequest extends Request {
  user?: {
    address: string;
    hasPermit: boolean;
    permitReason?: PermitReason;
    /** PRD-18 — single-use jti carried inside the onboard permit's `name`.
     *  Forwarded to sellerPublishService.publish() for atomic consumption. */
    permitJti?: string;
    /** PRD-18 — issuance ceiling (epoch seconds) recorded in
     *  onboard_permits_spent.expires_at. */
    permitExpSec?: number;
  };
}

/**
 * Auth middleware — wallet-address based.
 *
 * Per docs/USP_BRIEF.md: sellers don't subscribe. Buyers pay per-call x402 on
 * /v2/inference (enforced inside the route, not here). This middleware only
 * proves wallet identity + caches the FHE permit status.
 *
 * Public-by-design routes mounted under an authed router declare themselves
 * here. Adding a route to PUBLIC_PATHS is the canonical way to opt out — keeps
 * the public surface visible at one place rather than scattered across the
 * routers it lives inside.
 */
type PublicPath = RegExp | { method: 'GET' | 'POST'; path: RegExp };

const PUBLIC_PATHS: PublicPath[] = [
  // /v3/version — diagnostic ping; route comment marks it as public.
  /^\/version$/,
  // GET /v3/agents — public catalog list (published agents only). Called by
  // the /marketplace page before any wallet connects. POST/PATCH on the
  // same path KEEP requiring auth via the per-route guards inside v3.ts.
  { method: 'GET', path: /^\/agents$/ },
  // /v3/agents/slug-available — slug presence is public information.
  /^\/agents\/slug-available$/,
  // /v3/agents/top — public top-N ranked agents (home highlights).
  // Read-only aggregation over `paid_calls`; called before any wallet has
  // connected, so it cannot require an x-wallet-address header.
  /^\/agents\/top$/,
  // /v3/agents/search — keyword fast-path search (PRD-17). Public; reads
  // MemWal openx-agent-index, falls back to Postgres TF-IDF.
  /^\/agents\/search$/,
  // /v3/marketplace/listings — public catalog read; called from
  // /marketplace and the /seller/onboard success card before any wallet
  // has connected. Single indexed SELECT, no wallet context needed.
  //
  // The /marketplace prefix is optional here because Express runs the
  // /v3 mount's auth pass BEFORE the /v3/marketplace mount's auth pass:
  // first pass sees req.path = /marketplace/listings, second pass sees
  // /listings. One regex covers both, same shape as the /memory rules
  // a few lines below.
  /^(?:\/marketplace)?\/listings$/,
  // /v3/marketplace/seller/agent/:id/onchain-status (PRD-19) — read-only
  // status of the gasless on-chain registration. The frontend dashboard
  // polls this every 5s; both the tx hash and the brain id are already
  // public on Arbitrum Sepolia, so no auth context is required.
  /^(?:\/marketplace)?\/seller\/agent\/[^/]+\/onchain-status$/,
  // /v3/marketplace/workflows — public workflow listing catalog (PRD-15).
  /^(?:\/marketplace)?\/workflows$/,
  // /v3/marketplace/workflows/:slug — public workflow detail page.
  /^(?:\/marketplace)?\/workflows\/[^/]+$/,
  // /v3/marketplace/workflows/:slug/recent — anonymized last-N runs.
  /^(?:\/marketplace)?\/workflows\/[^/]+\/recent$/,
  // /v3/agents/:id/try — PRD-2 free, rate-limited demo invocation. The
  // rate limiter (in v3.ts) is the abuse defense here.
  /^\/agents\/[^/]+\/try$/,
  // /v3/discover — concierge marketplace search; the route uses neither
  // req.user nor wallet-scoped data and is invoked from /marketplace
  // before any wallet has connected.
  /^\/discover$/,
  // /v3/brains/:id/sovereignty-proof — institutional-grade audit endpoint
  // (Walrus + Sui only). Per route comment, must remain answerable even if
  // Postgres is down; gating it on a wallet defeats the trust model since
  // anyone can verify a published brain without going through OpenX.
  /^\/brains\/[^/]+\/sovereignty-proof$/,
  // /v3/brains/:id/cost — public Walrus pricing telemetry; same trustless
  // surface as sovereignty-proof, no wallet context required.
  /^\/brains\/[^/]+\/cost$/,
  // /v3/workflows/:id/sovereignty-proof — same audit-grade primitive as
  // brains: rebuilds from Walrus + Sui alone with OpenX DB disabled.
  // NB: this router is mounted at /v3/workflows, so auth sees the path
  // RELATIVE to the mount point (no /workflows prefix).
  /^\/[^/]+\/sovereignty-proof$/,
  // /v3/dashboard/stats — public cash-flow proof (Frame F1). Read-only
  // aggregations from public tables; safe to expose without wallet header.
  /^\/dashboard\/stats$/,
  // /v3/memory/marketplace — public catalog of MemWal-tier brains. Browsable
  // before any wallet connects; the brain detail + sovereignty endpoints
  // below match the same trustless-by-design surface.
  //
  // Note: the optional `/memory` prefix is intentional. Express runs the
  // `/v3` mount's auth BEFORE the `/v3/memory` mount, so `req.path` here is
  // `/memory/marketplace` for the first auth pass and `/marketplace` for
  // the second. One regex, both passes.
  /^(?:\/memory)?\/marketplace$/,
  // /v3/memory/brain/:id — public brain detail (no decryption).
  /^(?:\/memory)?\/brain\/[^/]+\/?$/,
  // /v3/memory/brain/:id/sovereignty-proof — must answer even with Postgres
  // down. Edge-cached 1h via Caddy in production.
  /^(?:\/memory)?\/brain\/[^/]+\/sovereignty-proof$/,
];

/**
 * PRD-18 — routes that REQUIRE x-fhenix-permit when FEATURE_PERMIT_AUTH=true.
 *
 * Mirror of PUBLIC_PATHS for the inverse direction. Mounted under
 * /v3/marketplace, so the middleware sees relative paths (with or without
 * the /marketplace prefix depending on which mount runs first — same shape
 * as the listing/workflow whitelist regexes above).
 *
 * When FEATURE_PERMIT_AUTH=false (default), this list has no effect:
 * x-wallet-address keeps working byte-identically and rollback is free.
 */
const PERMIT_AUTH_REQUIRED: RegExp[] = [
  /^(?:\/marketplace)?\/seller\/publish$/,
];

export const auth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const matchesPublic = PUBLIC_PATHS.some((p) =>
    p instanceof RegExp
      ? p.test(req.path)
      : p.method === req.method && p.path.test(req.path),
  );
  if (matchesPublic) return next();

  // ─── Permit-auth path (preferred when header present) ──────────────────
  // The permit IS the proof of identity: verifyPermit() (without an
  // expectedIssuer) cryptographically derives the wallet address from the
  // signed blob. No need for x-wallet-address; spoofing is impossible.
  const permitHeader = req.headers['x-fhenix-permit'];
  const serialized = typeof permitHeader === 'string' ? permitHeader : null;
  if (serialized && serialized.length > 100) {
    try {
      const mod = await import('../fhe/permits');
      const result = await mod.verifyPermit(serialized);
      if (result.valid === false) {
        return res.status(401).json({ error: 'invalid permit', reason: result.reason });
      }
      const { issuer, jti, name, expiration } = result.permit;
      // Scope is enforced here: only `openx-onboard:*` permits may auth via
      // this header. Full-scope permits (legacy /v2/inference) keep using the
      // x-wallet-address path with a server-side hasPermit() lookup.
      if (!jti || !name?.startsWith(mod.ONBOARD_SCOPE_PREFIX)) {
        return res.status(401).json({ error: 'permit scope mismatch', reason: 'scope_mismatch' });
      }
      req.user = {
        address: issuer,
        hasPermit: true,
        permitReason: 'onchain_authorized',
        permitJti: jti,
        permitExpSec: expiration === Infinity ? undefined : expiration,
      };
      return next();
    } catch {
      return res.status(401).json({ error: 'permit verification failed' });
    }
  }

  // ─── Permit-auth gate (PRD-18 §6) ──────────────────────────────────────
  // When the feature flag is on, the routes in PERMIT_AUTH_REQUIRED MUST
  // carry an onboard permit; the legacy x-wallet-address path is rejected.
  if (
    process.env.FEATURE_PERMIT_AUTH === 'true' &&
    PERMIT_AUTH_REQUIRED.some((re) => re.test(req.path))
  ) {
    return res.status(401).json({ error: 'x-fhenix-permit required', reason: 'permit_required' });
  }

  // ─── Legacy x-wallet-address path (byte-identical default) ─────────────
  const address = req.headers['x-wallet-address'] as string;
  if (!address) return res.status(401).json({ error: 'Missing wallet address' });

  let hasPermit = false;
  let permitReason: PermitReason | undefined;
  try {
    const mod = await import('../fhe/permits');
    const status = await mod.hasPermit(address);
    hasPermit = status.authorized;
    permitReason = status.reason;
  } catch {
    /* permit module load failure is non-fatal here */
  }

  req.user = { address, hasPermit, permitReason };
  next();
};
