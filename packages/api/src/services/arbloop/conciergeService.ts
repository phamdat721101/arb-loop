/**
 * services/arbloop/conciergeService.ts — chat-driven discovery wedge.
 *
 * Workflow:
 *   1. Buyer types free-text intent in the homepage chat box.
 *   2. We parse via existing services/chat.ts::llmChat (cleanliness fix C3
 *      — re-uses the shipped Bedrock Claude wrapper, no new client needed).
 *   3. Rank candidate agents from the shipped discoveryService.
 *   4. For each candidate, derive `mode: 'x402' | 'loop'` from manifest
 *      heuristics (PRD-C task C3).
 *   5. Persist to arbloop_concierge_history for the F6 reflexive loop.
 *
 * SOLID:
 *   - SRP: this service knows only intent → ranked candidates with mode.
 *     The actual execution dispatch lives in middleware/x402.ts (mode A)
 *     or routes/v3-arbloop.ts::/hire/prepare (mode B).
 *   - DIP: the discovery search function is injected (default: shipped
 *     discoveryService.search). Tests can stub.
 *   - LSP: returns a stable shape; gracefully degrades if LLM JSON is bad.
 */

import { pool } from '../../db';
import { llmChat } from '../chat';
import { discover as defaultSearch } from '../discoveryService';

export interface ConciergeIntent {
  capability: string;
  context_terms: string[];
  output_format?: 'pdf' | 'docx' | 'json' | 'text' | 'markdown' | string;
  word_limit?: number;
  language_pair?: { source: string; target: string };
  needs_memory: boolean;            // → forces mode='loop'
}

export interface ConciergeCandidate {
  agent_id: string;
  agent_registry_address: string;
  agent_registry_version: 1 | 2;
  title: string;
  short_description?: string | null;
  score: number;
  reason: string;
  mode: 'x402' | 'loop';
  pricing: { x402?: string | null; mpp?: string | null; fherc20?: string | null };
  persona_summary?: string;
  chain: string;
}

export interface ConciergeResult {
  intent: ConciergeIntent;
  candidates: ConciergeCandidate[];
  explain: string;
}

const SYSTEM_PROMPT = `
You are an AI agent concierge. Given a buyer's free-text demand, return STRICT JSON
matching this schema:

{
  "capability": "one of: translate, summarize, extract, audit, research, monitor, generate, classify, other",
  "context_terms": ["domain-specific keywords for ranking, lowercase"],
  "output_format": "pdf | docx | json | text | markdown",
  "word_limit": <int or null>,
  "language_pair": { "source": "en|vi|ja|zh|...", "target": "..." } | null,
  "needs_memory": <true if multi-step or persistent state required, else false>
}

Rules:
- Output ONLY the JSON. No prose, no code fences.
- needs_memory=true ONLY for multi-iteration tasks (research over time, monitor a feed,
  multi-step content workflows). One-shot tasks (translate, summarize, extract from one
  document) → needs_memory=false.
`.trim();

const FALLBACK_INTENT: ConciergeIntent = {
  capability: 'other',
  context_terms: [],
  needs_memory: false,
};

export async function parseIntent(message: string): Promise<ConciergeIntent> {
  if (!message || message.length > 1000) return { ...FALLBACK_INTENT, context_terms: [message?.slice(0, 100) ?? ''] };
  try {
    const raw = await llmChat(SYSTEM_PROMPT, [{ role: 'user', content: message }]);
    const trimmed = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const parsed = JSON.parse(trimmed) as Partial<ConciergeIntent>;
    return {
      capability: parsed.capability ?? 'other',
      context_terms: Array.isArray(parsed.context_terms) ? parsed.context_terms.slice(0, 10) : [],
      output_format: parsed.output_format,
      word_limit: typeof parsed.word_limit === 'number' ? parsed.word_limit : undefined,
      language_pair: parsed.language_pair,
      needs_memory: !!parsed.needs_memory,
    };
  } catch {
    // Fallback: TF-IDF on raw message via discoveryService (no parse needed).
    return { ...FALLBACK_INTENT, context_terms: message.toLowerCase().split(/\s+/).slice(0, 10) };
  }
}

/** Heuristic for mode hint per PRD-C task C3. */
export function deriveMode(args: {
  fallbackMaxIterations?: number;
  tags?: string[] | null;
  intentNeedsMemory: boolean;
}): 'x402' | 'loop' {
  const tags = (args.tags ?? []).map(t => t.toLowerCase());
  const requiresMemory = tags.includes('requires_memory') || args.intentNeedsMemory;
  const isOneShot = (args.fallbackMaxIterations ?? 1) === 1;
  if (isOneShot && !requiresMemory) return 'x402';
  return 'loop';
}

/**
 * Concierge search:
 *   1. Parse intent.
 *   2. Build a ranking query from intent.capability + context_terms.
 *   3. Call discoveryService.search() (existing, shipped).
 *   4. Decorate each candidate with `mode` + `agent_registry_version`.
 *   5. Persist for reflexive loop.
 */
export async function conciergeSearch(args: {
  message: string;
  buyerAddress?: string;
  sessionId?: string;
  baseUrl?: string;
  searchImpl?: typeof defaultSearch;
}): Promise<ConciergeResult> {
  const intent = await parseIntent(args.message);
  const query = [intent.capability, ...intent.context_terms].filter(Boolean).join(' ');
  const search = args.searchImpl ?? defaultSearch;
  const raw = await search({ message: query || args.message, max_steps: 5 }, args.baseUrl ?? '');

  // Hydrate manifest tags + iteration limits per candidate from the off-chain
  // index. The shipped discoveryService projects only 5–6 fields onto its
  // candidates; we re-query for the columns needed for mode derivation.
  const candidates: ConciergeCandidate[] = [];
  for (const c of raw.candidates ?? []) {
    // Cross-source filter: discoveryService searches both knowledge-brain
    // agents (UUID ids) and arb-loop agents (numeric on-chain ids). Only
    // arb-loop agents can be invoked at /v3/arbloop/agents/:agentId/invoke,
    // and the path param must parse as a non-negative integer. A UUID-shaped
    // id makes Number() return NaN, which then yields the on-chain
    // 'bad_agent_id' 400 the buyer sees in the chat. Skip anything that is
    // not a real arb-loop row.
    const numericId = Number(c.agent_id);
    if (!Number.isInteger(numericId) || numericId < 0) continue;
    const r = await pool.query(
      `SELECT agent_registry_address, agent_registry_version, max_iter_per_job,
              tags, title, short_description, agent_id
         FROM arbloop_agents_metadata
        WHERE agent_id = $1
        LIMIT 1`,
      [numericId],
    ).catch(() => ({ rows: [] }));
    const meta = r.rows[0] ?? {};
    if (meta.agent_id === undefined) continue;
    const mode = deriveMode({
      fallbackMaxIterations: meta.max_iter_per_job ?? 1,
      tags: meta.tags,
      intentNeedsMemory: intent.needs_memory,
    });
    candidates.push({
      agent_id: String(numericId),
      agent_registry_address: meta.agent_registry_address ?? '',
      agent_registry_version: (meta.agent_registry_version ?? 1) as 1 | 2,
      title: meta.title ?? c.persona_summary?.slice(0, 60) ?? `Agent ${c.agent_id}`,
      short_description: meta.short_description ?? null,
      score: c.score ?? 0,
      reason: c.reason ?? '',
      mode,
      pricing: c.pricing ?? {},
      persona_summary: c.persona_summary,
      chain: c.chain ?? '',
    });
  }

  // Direct arb-loop fallback. The legacy discoveryService indexes only the
  // brain `agents` table; many chat queries (e.g. "translate text") only
  // match brain rows, get filtered out above for not being arb-loop, and
  // the chat shows zero results. This fallback runs a Postgres full-text
  // match over title + short_description + tags so the chat surfaces real,
  // invokable arb-loop agents whenever the legacy path misses. We use the
  // raw user message (not intent.capability) because parseIntent falls back
  // to capability='other' when the LLM key is missing; 'other' would never
  // match a real agent's metadata.
  if (candidates.length === 0) {
    // Build an OR-join tsquery from the user's words. websearch_to_tsquery
    // uses AND, which fails on phrases like "translate text" when no agent
    // contains both words. Sanitize to alphanumerics + lowercase + min 3
    // chars; OR-join with ' | '. If nothing remains (e.g. emoji-only input),
    // skip the fallback.
    const words = (args.message ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .slice(0, 6);
    const tsQuery = words.join(' | ');
    const rs = tsQuery
      ? await pool.query(
          `SELECT agent_id, agent_registry_address, agent_registry_version,
                  max_iter_per_job, tags, title, short_description,
                  per_iter_default_micro_usdc
             FROM arbloop_agents_metadata
            WHERE revoked = FALSE
              AND to_tsvector(
                    'simple',
                    coalesce(title, '') || ' ' ||
                    coalesce(short_description, '') || ' ' ||
                    array_to_string(coalesce(tags, '{}'::text[]), ' ')
                  ) @@ to_tsquery('simple', $1)
            ORDER BY published_at DESC
            LIMIT 5`,
          [tsQuery],
        ).catch(() => ({ rows: [] }))
      : { rows: [] };
    for (const meta of rs.rows) {
      const mode = deriveMode({
        fallbackMaxIterations: meta.max_iter_per_job ?? 1,
        tags: meta.tags,
        intentNeedsMemory: intent.needs_memory,
      });
      candidates.push({
        agent_id: String(meta.agent_id),
        agent_registry_address: meta.agent_registry_address ?? '',
        agent_registry_version: (meta.agent_registry_version ?? 1) as 1 | 2,
        title: meta.title ?? `Agent ${meta.agent_id}`,
        short_description: meta.short_description ?? null,
        score: 0.5,
        reason: `arb-loop match: ${meta.title}`,
        mode,
        pricing: { x402: String(meta.per_iter_default_micro_usdc ?? ''), mpp: null, fherc20: null },
        persona_summary: meta.short_description ?? undefined,
        chain: 'arbitrum-sepolia',
      });
    }
  }

  // F6: persist for the reflexive loop.
  if (args.buyerAddress || args.sessionId) {
    pool.query(
      `INSERT INTO arbloop_concierge_history
         (buyer_address, session_id, query_text, intent_json, candidates_json)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [
        args.buyerAddress ?? null,
        args.sessionId ?? null,
        args.message,
        JSON.stringify(intent),
        JSON.stringify(candidates),
      ],
    ).catch(() => undefined); // best-effort
  }

  return {
    intent,
    candidates,
    explain: candidates.length > 0
      ? `Matched ${candidates.length} agent(s) for capability=${intent.capability}.`
      : `No agents matched. Try rephrasing.`,
  };
}
