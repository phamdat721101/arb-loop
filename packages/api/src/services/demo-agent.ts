/**
 * demo-agent.ts — seeded "first query" service for the publish-and-earn loop.
 *
 * Why this exists (per docs/USP_BRIEF.md):
 *   The seller's first dollar must arrive within ~60s of publishing, otherwise
 *   the magic moment is lost. In production, real ERC-8004 agents arrive
 *   organically; on testnet / cold launch, we seed the traffic.
 *
 * SOLID:
 *   - Single responsibility: poll for newly-published brains and emit one
 *     "agent query" event per brain. Does not handle pricing, payment rails,
 *     or LLM inference (those live in their own modules).
 *   - Closed for modification: turn it off by leaving DEMO_AGENT_ENABLED unset
 *     (or set to "false"); no other code path needs to know.
 *   - Idempotent: tracks the largest brain id it has visited, so a restart
 *     does not re-spam existing brains.
 */

import { pool } from '../db';
import { logger } from '../lib';

/** Pseudo-address for the seeded agent. Real ERC-8004 agents will use real addresses. */
const DEFAULT_DEMO_AGENT = '0xA1F2DEM00000000000000000000000000000A6E7';

/** A small bag of generic questions; chosen by tag overlap. Plain English so logs are readable. */
const TEMPLATE_QUESTIONS: Array<{ tag: string; q: string }> = [
  { tag: 'solidity', q: 'What is the most common reentrancy mitigation in Solidity?' },
  { tag: 'fhe', q: 'When is FHE faster than TEE for AI inference, if ever?' },
  { tag: 'security', q: 'Name one audit finding that would block a mainnet deploy.' },
  { tag: 'trading', q: 'What signal does this brain rely on most heavily?' },
  { tag: 'research', q: 'What is the most underrated finding in this brain?' },
];

const FALLBACK_Q = 'Give me the most important thing this brain knows.';

function pickQuestion(tags: string[] | null | undefined): string {
  if (!tags?.length) return FALLBACK_Q;
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  const match = TEMPLATE_QUESTIONS.find((t) => tagSet.has(t.tag));
  return match?.q ?? FALLBACK_Q;
}

interface DemoAgentConfig {
  enabled: boolean;
  intervalMs: number;
  agentAddress: string;
  /** Cap the per-tick scan so a backlog can't lock the DB. */
  perTickLimit: number;
}

function readConfig(): DemoAgentConfig {
  const enabled = (process.env.DEMO_AGENT_ENABLED ?? 'true').toLowerCase() === 'true';
  const intervalMs = Math.max(1_000, Number(process.env.DEMO_AGENT_INTERVAL_MS ?? 10_000));
  const agentAddress = (process.env.DEMO_AGENT_ADDRESS ?? DEFAULT_DEMO_AGENT).toLowerCase();
  const perTickLimit = Math.max(1, Number(process.env.DEMO_AGENT_PER_TICK ?? 5));
  return { enabled, intervalMs, agentAddress, perTickLimit };
}

let timer: NodeJS.Timeout | null = null;
let lastSeenBrainId = 0;

/** Find published brains that haven't yet received a demo-agent query. */
async function findUnvisitedBrains(agentAddress: string, limit: number) {
  const { rows } = await pool.query(
    `SELECT b.id, b.owner_address, b.title, b.tags
       FROM brains b
       LEFT JOIN chat_history h
              ON h.brain_id = b.id AND h.user_address = $1 AND h.role = 'user'
      WHERE b.published = TRUE
        AND b.id > $2
        AND h.id IS NULL
      ORDER BY b.id
      LIMIT $3`,
    [agentAddress, lastSeenBrainId, limit],
  );
  return rows as Array<{ id: number; owner_address: string; title: string; tags: string[] | null }>;
}

/** Record a (user, assistant) pair authored by the demo agent. The /v2/earnings
 *  endpoint counts these rows as billable queries. Calls the same LLM helper
 *  /v2/inference uses (Phala if configured → Bedrock → mock); marks the row
 *  with a "seed" prefix so /earnings UI can label these honestly. */
async function recordAgentQuery(brain: { id: number; title: string; tags: string[] | null }, agent: string) {
  const question = pickQuestion(brain.tags);
  let answer: string;
  try {
    // Lazy-import so the demo agent doesn't bloat /v2 hot path startup.
    const { callLLMSeed } = await import('../routes/v2');
    const llm = await callLLMSeed(
      `You are a Second Brain assistant. Brief seed answer for "${brain.title}".`,
      question,
    );
    const provider = llm.phalaAttestationHash ? 'phala-tee' : (process.env.BEDROCK_API_KEY ? 'bedrock' : 'mock');
    answer = `[seed · ${provider}] ${llm.text}`;
  } catch (err) {
    answer = `[seed · mock] Asked "${question}" against "${brain.title}". The owner earned 0.01 USDC (testnet seed).`;
    logger.warn({ err: (err as Error).message }, 'demo-agent:llm:fallback');
  }
  await pool.query(
    `INSERT INTO chat_history (user_address, brain_id, role, content)
     VALUES ($1, $2, 'user', $3), ($1, $2, 'assistant', $4)`,
    [agent, brain.id, question, answer],
  );
}

async function tick(cfg: DemoAgentConfig) {
  try {
    const brains = await findUnvisitedBrains(cfg.agentAddress, cfg.perTickLimit);
    for (const b of brains) {
      await recordAgentQuery(b, cfg.agentAddress);
      lastSeenBrainId = Math.max(lastSeenBrainId, b.id);
      logger.info(
        { brainId: b.id, owner: b.owner_address, agent: cfg.agentAddress },
        'demo-agent:queried',
      );
    }
  } catch (e: any) {
    logger.warn({ err: e.message }, 'demo-agent:tick:error');
  }
}

/** Start the demo-agent loop. Idempotent — calling start() twice is a no-op. */
export function startDemoAgent(): void {
  if (timer) return;
  const cfg = readConfig();
  if (!cfg.enabled) {
    logger.info('demo-agent:disabled (set DEMO_AGENT_ENABLED=true to enable)');
    return;
  }
  logger.info({ interval: cfg.intervalMs, agent: cfg.agentAddress }, 'demo-agent:starting');
  // Fire once immediately so newly-published brains in dev see traffic without a wait.
  void tick(cfg);
  timer = setInterval(() => void tick(cfg), cfg.intervalMs);
}

export function stopDemoAgent(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Exported for tests + the admin stats endpoint (so we can show "demo agent X queries"). */
export function getDemoAgentAddress(): string {
  return readConfig().agentAddress;
}
