/**
 * MCP tool registry — declarative list (Arbitrum-only).
 *
 * Schema follows the MCP `tools/list` contract (name, description, inputSchema).
 * `paid` triggers the `-32402 Payment Required` envelope in the dispatch layer
 * (see `server.ts`). `_meta` annotations are echoed verbatim to the client so
 * agent hosts can introspect price + KYA-tier requirements without calling.
 *
 * SOLID:
 *   - SRP: each tool is one ToolDef with one handler.
 *   - OCP: adding a tool = appending one entry; no other file changes.
 */

import type { OpenXClient } from '../openx';

export interface PaymentEnvelope {
  rail: 'x402';
  amount_usdc: string;
  pay_to: string;
  endpoint: string;
  tool: string;
}

export interface ToolHandlerCtx {
  openx: OpenXClient;
  args: Record<string, unknown>;
  callerAddress?: string;
}

export type ToolHandler = (ctx: ToolHandlerCtx) => Promise<unknown>;

export interface ToolMeta {
  name: string;
  description: string;
  paid: boolean;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  _meta?: Record<string, unknown>;
}

export interface ToolDef extends ToolMeta {
  handler: ToolHandler;
}

const tStr = { type: 'string' };
const tInt = { type: 'integer' };

export const TOOLS: ToolDef[] = [
  {
    name: 'openx_brain_search',
    description: 'Semantic search across published OpenX brains. Free.',
    paid: false,
    inputSchema: { type: 'object', properties: { query: tStr, topK: tInt }, required: ['query'] },
    handler: async ({ openx, args }) =>
      openx.recall(args.query as string, { topK: args.topK as number }),
  },
  {
    name: 'openx_brain_remember',
    description: 'Store text into the caller-owned brain (requires owner key).',
    paid: false,
    inputSchema: { type: 'object', properties: { text: tStr, namespace: tStr }, required: ['text'] },
    handler: async ({ openx, args }) => ({
      memoryId: await openx.remember(args.text as string, { namespace: args.namespace as string }),
    }),
  },
  {
    name: 'openx_brain_recall',
    description: 'Paid retrieval of memories from a target brain (semantic search + decryption).',
    paid: true,
    inputSchema: { type: 'object', properties: { query: tStr, topK: tInt }, required: ['query'] },
    _meta: { 'x-x402': { method: 'exact', currency: 'USDC' } },
    handler: async ({ openx, args }) =>
      openx.recall(args.query as string, { topK: args.topK as number }),
  },
  {
    name: 'openx_brain_ask',
    description: 'Paid LLM-answered query with cited memories + TEE attestation.',
    paid: true,
    inputSchema: { type: 'object', properties: { query: tStr, topK: tInt }, required: ['query'] },
    _meta: { 'x-x402': { method: 'exact', currency: 'USDC' } },
    handler: async ({ openx, args }) =>
      openx.ask(args.query as string, { topK: args.topK as number }),
  },

  // ─── arb-loop tools (FEATURE_ARBLOOP-gated server-side) ────────────────

  {
    name: 'arbloop_browse_agents',
    description: 'List published arb-loop Agents (loops, not single calls). Free.',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: { category: tStr, limit: tInt },
    },
    handler: async ({ args }) => {
      const base = arbloopApiBase();
      const url = new URL(`${base}/v3/arbloop/agents`);
      if (args.category) url.searchParams.set('category', String(args.category));
      if (args.limit) url.searchParams.set('limit', String(args.limit));
      const r = await fetch(url.toString());
      if (!r.ok) throw new Error(`arbloop:browse_agents:http_${r.status}`);
      return await r.json();
    },
  },
  {
    name: 'arbloop_hire_agent',
    description:
      'Prepare a multicall transaction to hire an Agent for an N-iter loop on Arbitrum Sepolia. Returns the tx for the MCP host wallet to sign.',
    paid: false, // The hire itself is free; the loop iterations are paid via on-chain USDC settlement.
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: tInt,
        max_iterations: tInt,
        budget_usdc: tStr, // decimal string
        buyer_address: tStr,
      },
      required: ['agent_id', 'max_iterations', 'budget_usdc', 'buyer_address'],
    },
    handler: async ({ args }) => {
      const base = arbloopApiBase();
      const r = await fetch(`${base}/v3/arbloop/hire/prepare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
      if (!r.ok) throw new Error(`arbloop:hire:http_${r.status}`);
      return await r.json();
    },
  },
  {
    name: 'arbloop_get_job_status',
    description: 'Live status of a LoopJob (status, iterations, EAS attestation UIDs).',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: { job_address: tStr },
      required: ['job_address'],
    },
    handler: async ({ args }) => {
      const base = arbloopApiBase();
      const r = await fetch(`${base}/v3/arbloop/jobs/${args.job_address}`);
      if (!r.ok) throw new Error(`arbloop:job_status:http_${r.status}`);
      return await r.json();
    },
  },
  {
    name: 'arbloop_approve_checkpoint',
    description:
      'Prepare a CheckpointApproval.approve() transaction for the MCP host wallet to sign.',
    paid: false,
    inputSchema: {
      type: 'object',
      properties: { job_address: tStr, iter_n: tInt },
      required: ['job_address', 'iter_n'],
    },
    handler: async ({ args }) => {
      const base = arbloopApiBase();
      const r = await fetch(`${base}/v3/arbloop/checkpoints/prepare-approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
      if (!r.ok) throw new Error(`arbloop:approve_checkpoint:http_${r.status}`);
      return await r.json();
    },
  },
];

function arbloopApiBase(): string {
  return process.env.ARBLOOP_API_URL ?? process.env.OPENX_API_URL ?? 'http://localhost:3001';
}
