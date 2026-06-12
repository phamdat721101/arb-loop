/**
 * HTTP transport for the OpenX MCP server.
 *
 * Single Express POST /mcp accepts a JSON-RPC 2.0 request (or batch).
 * Mounted from server.ts. The dispatch layer is in `@fhe-ai-context/sdk/mcp/server`
 * — this file is the thin adapter only.
 *
 * Auth: optional. The MCP spec allows unauthenticated tool listing (which the
 * paid tools' 402 envelope handles via the JSON-RPC -32402 response).
 *
 * Configuration via env (all optional in dev — defaults work):
 *   OPENX_MCP_PUBLIC_URL    — public-facing URL the buyer retries against (default api.openx.so/mcp)
 *   OPENX_PLATFORM_PAYTO    — wallet address that receives payments (default = PLATFORM_WALLET)
 *   OPENX_PRICE_PER_QUERY   — USDC per paid call (default '0.01')
 */

import { Router, type Request, type Response } from 'express';
// Pull the MCP dispatcher + OpenXClient via deep imports — keeps the API
// package's compile time small (sdk index re-export of `mcp/server` would
// drag the OpenXClient surface into every consumer).
import { OpenXMcpServer } from '@fhe-ai-context/sdk';
import { OpenXClient } from '@fhe-ai-context/sdk';
import { logger } from '../lib';

const router = Router();

// One MCP server per process. The OpenXClient inside is configured for the
// platform wallet; per-call buyer identity flows in via _meta.callerAddress.
//
// Tier selection (Dependency Inversion):
//   Default 'standard' — the shipping Fhenix/Arbitrum tier (always registered).
//   Set OPENX_MCP_TIER=trustless only when @fhe-ai-context/sui-sdk is installed
//   AND its side-effect import has run, which registers the 'sui' provider.
//   The mcp route never hard-couples to a parked package.
const tier: 'standard' | 'trustless' =
  process.env.OPENX_MCP_TIER === 'trustless' ? 'trustless' : 'standard';

const openx = new OpenXClient({
  tier,
  apiUrl: process.env.OPENX_API_URL ?? 'http://localhost:3001',
  walletAddress: process.env.PLATFORM_WALLET ?? '0xplatform',
  defaultNamespace: 'public',
});

const server = new OpenXMcpServer(openx, {
  payTo: process.env.OPENX_PLATFORM_PAYTO ?? process.env.PLATFORM_WALLET ?? '',
  pricePerCall: process.env.OPENX_PRICE_PER_QUERY ?? '0.01',
  publicUrl: process.env.OPENX_MCP_PUBLIC_URL ?? 'https://api.openx.so/mcp',
  // OPENX_MCP_AUTH_MODE controls how MemWal calls are routed (PRD-09 §5).
  // Hosted gateway defaults to openx-bound — the operator pattern.
  authMode:
    process.env.OPENX_MCP_AUTH_MODE === 'memwal-direct' ||
    process.env.OPENX_MCP_AUTH_MODE === 'hybrid'
      ? process.env.OPENX_MCP_AUTH_MODE
      : 'openx-bound',
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const out = await server.dispatch(req.body);
    if (out === null) {
      // Notifications get an empty 204.
      return res.status(204).end();
    }
    res.json(out);
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'mcp:dispatch:error');
    res.status(500).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal error' },
    });
  }
});

// Diagnostic ping — non-MCP, used for smoke tests.
router.get('/healthz', (_req, res) => res.json({ ok: true, server: 'openx-mcp' }));

export default router;
