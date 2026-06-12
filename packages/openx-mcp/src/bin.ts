#!/usr/bin/env node
/**
 * `@openx/mcp` — stdio bin for Claude Desktop / Cursor / Bedrock AgentCore.
 *
 * Spawns a JSON-RPC 2.0 reader/writer over stdin/stdout, dispatching to the
 * existing `OpenXMcpServer` shipped from `@fhe-ai-context/sdk`. The HTTP
 * transport at `api.openx.so/mcp` is the canonical path; this shim is
 * a convenience for hosts that prefer subprocess semantics.
 *
 * Config via env (matches the HTTP server's env so config is portable):
 *   OPENX_API_URL          — Express API base (default http://localhost:3001)
 *   OPENX_API_KEY          — buyer-side API key (forwarded as caller identity)
 *   OPENX_BRAIN_ID         — default brain (single-brain client setups)
 *   OPENX_PRICE_PER_QUERY  — USDC per paid call (default '0.01')
 *   OPENX_PLATFORM_PAYTO   — wallet that receives payments
 *   OPENX_MCP_PUBLIC_URL   — URL the buyer retries against (default api.openx.so/mcp)
 *
 * Usage in Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "openx": {
 *         "command": "npx",
 *         "args": ["-y", "@openx/mcp"],
 *         "env": { "OPENX_API_URL": "https://api.openx.so", "OPENX_BRAIN_ID": "0x…" }
 *       }
 *     }
 *   }
 */

import { OpenXClient, OpenXMcpServer } from '@fhe-ai-context/sdk';

const openx = new OpenXClient({
  tier: 'trustless',
  apiUrl: process.env.OPENX_API_URL ?? 'http://localhost:3001',
  walletAddress: process.env.OPENX_API_KEY ?? '0xanon',
  brainId: process.env.OPENX_BRAIN_ID,
  defaultNamespace: process.env.OPENX_NAMESPACE ?? 'public',
});

const server = new OpenXMcpServer(openx, {
  payTo: process.env.OPENX_PLATFORM_PAYTO ?? '',
  pricePerCall: process.env.OPENX_PRICE_PER_QUERY ?? '0.01',
  publicUrl: process.env.OPENX_MCP_PUBLIC_URL ?? 'https://api.openx.so/mcp',
  authMode: parseAuthMode(process.env.OPENX_MCP_AUTH_MODE),
});

function parseAuthMode(v: string | undefined): 'openx-bound' | 'memwal-direct' | 'hybrid' {
  return v === 'memwal-direct' || v === 'hybrid' ? v : 'openx-bound';
}

// JSON-RPC over stdio: each newline-delimited JSON line is one message.
// Notifications (no id) are written as no-ops to satisfy the protocol.
const stdin = process.stdin;
const stdout = process.stdout;
let buffer = '';

stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    void handleLine(line);
  }
});

stdin.on('end', () => {
  process.exit(0);
});

async function handleLine(line: string): Promise<void> {
  let req: unknown;
  try {
    req = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  try {
    const out = await server.dispatch(req as never);
    if (out !== null) write(out);
  } catch (err) {
    write({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: (err as Error).message ?? 'Internal error' },
    });
  }
}

function write(obj: unknown): void {
  stdout.write(JSON.stringify(obj) + '\n');
}

// Graceful shutdown.
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
