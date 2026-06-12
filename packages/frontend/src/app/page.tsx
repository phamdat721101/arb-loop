'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AGENT_BACKEND_URL } from '@/lib/contracts';
import { createLogger } from '@/lib/clientLogger';
import { ConciergeChat } from '@/components/arbloop/ConciergeChat';

/**
 * Home — AI-Discovery layout.
 *
 *   1. Summary hero (chip + headline + tagline) — what OpenX is, in 3 lines.
 *   2. Glass chat box — buyer types a free-text demand; on submit hits
 *      POST /v3/discover (LLM-ranked behind a TF-IDF floor — see
 *      packages/api/src/services/discoveryService.ts).
 *   3. Below the chat box:
 *      - while results exist → ranked AgentCard list with score + reason.
 *      - otherwise           → top-5 "highlights" grid from /v3/agents/top
 *                              (paid-call count over last 30 days).
 *
 * SOLID:
 *   - One file owns home rendering + local state. Sub-components are inline
 *     to satisfy SRP without inflating the file count.
 *   - Reuses AppShell (header, mobile nav, wallet controls). No header
 *     rewrite here.
 *   - Both API endpoints are public (whitelisted in middleware/auth.ts), so
 *     this page works before any wallet has connected.
 */
const log = createLogger('home');

interface TopAgent {
  id: string;
  brain_id: number;
  title: string | null;
  description: string | null;
  tags: string[] | null;
  chain: string;
  pricing: Record<string, string | null>;
  persona: { system_prompt?: string | null } | null;
  calls_30d: number;
}

interface Candidate {
  agent_id: string;
  score: number;
  reason: string;
  persona_summary: string;
  pricing: Record<string, string | null>;
  chain: string;
}

interface DiscoverResult {
  candidates: Candidate[];
  bundle: { id: string; aggregate_price_usdc: string } | null;
}

const RAIL_LABEL: Record<string, string> = {
  x402: 'USDC',
  mpp: 'MPP',
  fherc20: 'FHERC20',
};

function priceFromPricing(p: Record<string, string | null> | undefined) {
  if (!p) return null;
  const order = ['x402', 'mpp', 'fherc20'] as const;
  for (const k of order) if (p[k]) return { rail: k, amount: p[k]! };
  return null;
}

function shortId(id: string) {
  return id.length <= 9 ? id : `${id.slice(0, 4)}…${id.slice(-3)}`;
}

export default function HomePage() {
  // v0.0 simple ship: ConciergeChat is the default homepage experience.
  // Set NEXT_PUBLIC_FEATURE_ARBLOOP_CHAT_EXECUTION=false to fall back to the
  // legacy discovery-only ChatBox (back-compat rollback knob).
  if (process.env.NEXT_PUBLIC_FEATURE_ARBLOOP_CHAT_EXECUTION !== 'false') {
    return (
      <div className="space-y-12 md:space-y-16">
        <SummarySection />
        <ConciergeChat />
        <p className="text-center text-xs text-on-surface-variant">
          Documents stay encrypted client-side · demand intent powers concierge ranking
        </p>
      </div>
    );
  }

  const [top, setTop] = useState<TopAgent[] | null>(null);
  const [topErr, setTopErr] = useState<string | null>(null);

  const [demand, setDemand] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Prefer the ranked endpoint; fall back to the unauthenticated /brains
    // listing when the API is on an older build that hasn't deployed
    // /v3/agents/top yet (returns 401 because the auth-gate route wins).
    (async () => {
      try {
        const r = await fetch(`${AGENT_BACKEND_URL}/v3/agents/top?n=5`);
        if (r.ok) {
          const j = await r.json();
          setTop((j.agents ?? []) as TopAgent[]);
          return;
        }
        const fb = await fetch(`${AGENT_BACKEND_URL}/brains`);
        if (!fb.ok) throw new Error(String(r.status));
        const brains = (await fb.json()) as Array<{
          id: number;
          title: string;
          description: string | null;
          tags: string[] | null;
          chain?: string;
        }>;
        setTop(
          brains.slice(0, 5).map((b) => ({
            id: String(b.id),
            brain_id: b.id,
            title: b.title,
            description: b.description,
            tags: b.tags,
            chain: b.chain ?? '',
            pricing: {},
            persona: null,
            calls_30d: 0,
          })),
        );
      } catch (e: any) {
        setTopErr(String(e?.message ?? e));
        setTop([]);
      }
    })();
  }, []);

  const byId = useMemo(
    () => Object.fromEntries((top ?? []).map((a) => [a.id, a])),
    [top],
  );

  async function submit() {
    const message = demand.trim();
    if (!message || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${AGENT_BACKEND_URL}/v3/discover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, max_steps: 5 }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      const j = (await r.json()) as DiscoverResult;
      setResult(j);
      log.info('discover:ok', { len: message.length, hits: j.candidates.length });
    } catch (e: any) {
      setErr(`${e?.message ?? e} — try a more specific demand or browse the marketplace.`);
      log.warn('discover:failed', { err: e?.message });
    } finally {
      setBusy(false);
    }
  }

  function clearResult() {
    setResult(null);
    setErr(null);
  }

  return (
    <div className="space-y-12 md:space-y-16">
      <SummarySection />
      <ChatBox
        demand={demand}
        setDemand={setDemand}
        busy={busy}
        onSubmit={submit}
        hasResult={!!result}
        onClear={clearResult}
      />
      {err && (
        <p role="alert" className="-mt-8 text-center text-sm text-amber-500">
          {err}
        </p>
      )}
      {result ? (
        <ResultsSection result={result} byId={byId} />
      ) : (
        <HighlightsSection top={top} topErr={topErr} />
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function SummarySection() {
  return (
    <section className="mx-auto mt-4 flex max-w-4xl flex-col items-center gap-7 text-center md:mt-8 md:gap-9">
      <span className="matrix-chip rounded border border-secondary/20 px-2 py-1 font-mono text-[11px] uppercase tracking-wider">
        Marketplace live · Cognitive memory · Encrypted
      </span>
      <h1 className="font-headline text-4xl font-bold leading-tight tracking-tight md:text-6xl">
        The AI agent marketplace with{' '}
        <span className="text-primary">cognitive memory</span>
      </h1>
      <FlowDiagram />
      <p className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
        The platform stays cryptographically blind · sellers earn the moment an agent asks
      </p>
    </section>
  );
}

/**
 * FlowDiagram — 3-step visual narrative replacing the old marketing
 * paragraph. Renders as a horizontal flow on ≥md and as a vertical stack on
 * mobile (the arrows rotate 90° via Tailwind so we keep one icon, not two).
 *
 * Each step is an inline sub-component in this file to satisfy SRP without
 * adding new files. Reuses the encryption-glow + agent-card-border tokens
 * already shipped in globals.css.
 */
function FlowDiagram() {
  return (
    <div
      role="list"
      aria-label="How OpenX works"
      className="grid w-full grid-cols-1 items-stretch gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]"
    >
      <FlowStep
        icon="upload_file"
        title="Publish"
        body="One click. Knowledge is encrypted in the seller’s browser."
      />
      <FlowArrow />
      <FlowStep
        icon="memory"
        title="Cognitive memory"
        body="Shared, encrypted, gets sharper every time an agent calls."
        highlight
      />
      <FlowArrow />
      <FlowStep
        icon="paid"
        title="Earn per query"
        body="Autonomous agents pay USDC the moment they ask."
      />
    </div>
  );
}

function FlowStep({
  icon,
  title,
  body,
  highlight,
}: {
  icon: string;
  title: string;
  body: string;
  highlight?: boolean;
}) {
  return (
    <div
      role="listitem"
      className={`encryption-glow flex h-full flex-col gap-2 rounded-xl border bg-surface p-4 text-left transition-colors ${
        highlight
          ? 'border-primary/60 bg-primary/5'
          : 'border-outline-variant/30 hover:border-primary/40'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            highlight ? 'bg-primary text-on-primary' : 'bg-primary/10 text-primary'
          }`}
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden>
            {icon}
          </span>
        </span>
        <h3 className="font-headline text-sm font-semibold text-on-surface">{title}</h3>
      </div>
      <p className="text-xs leading-relaxed text-on-surface-variant">{body}</p>
    </div>
  );
}

function FlowArrow() {
  return (
    <div className="flex items-center justify-center text-primary" aria-hidden>
      <span className="material-symbols-outlined rotate-90 text-[20px] md:rotate-0 md:text-[24px]">
        arrow_forward
      </span>
    </div>
  );
}

function ChatBox({
  demand,
  setDemand,
  busy,
  onSubmit,
  hasResult,
  onClear,
}: {
  demand: string;
  setDemand: (v: string) => void;
  busy: boolean;
  onSubmit: () => void;
  hasResult: boolean;
  onClear: () => void;
}) {
  return (
    <section className="mx-auto w-full max-w-3xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="glass-panel rounded-xl p-4 transition-shadow focus-within:x-blue-glow"
      >
        <div className="mb-3 flex items-center gap-2 border-b border-white/5 pb-2">
          <span className="material-symbols-outlined text-[18px] text-primary" aria-hidden>
            terminal
          </span>
          <span className="font-mono text-xs uppercase tracking-wider text-on-surface-variant">
            Demand input stream
          </span>
          {hasResult && (
            <button
              type="button"
              onClick={onClear}
              className="ml-auto rounded border border-outline-variant/40 px-2 py-1 font-mono text-[10px] uppercase text-on-surface-variant transition-colors hover:border-primary/40 hover:text-on-surface"
            >
              Clear
            </button>
          )}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <textarea
            value={demand}
            onChange={(e) => setDemand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSubmit();
              }
            }}
            placeholder="Describe the agent or skill you need… (e.g. 'audit a smart contract for reentrancy')"
            rows={3}
            aria-label="Describe the agent or skill you need"
            className="min-h-[72px] w-full resize-none rounded bg-transparent text-base text-on-surface placeholder:text-outline focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !demand.trim()}
            className="inline-flex items-center justify-center gap-2 rounded bg-primary px-4 py-2 font-medium text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:self-end"
          >
            <span
              className={`material-symbols-outlined text-[18px] ${busy ? 'animate-spin' : ''}`}
              aria-hidden
            >
              {busy ? 'progress_activity' : 'send'}
            </span>
            {busy ? 'Matching…' : 'Match'}
          </button>
        </div>
        <p className="mt-2 hidden text-[11px] text-outline sm:block">
          Tip: ⌘/Ctrl + Enter to submit.
        </p>
      </form>
    </section>
  );
}

function HighlightsSection({ top, topErr }: { top: TopAgent[] | null; topErr: string | null }) {
  return (
    <section aria-labelledby="top-agents-h" className="space-y-4">
      <div className="flex items-end justify-between gap-2 border-b border-white/5 pb-3">
        <div>
          <h2 id="top-agents-h" className="font-headline text-2xl font-bold">
            Top performing agents
          </h2>
          <p className="text-sm text-on-surface-variant">
            Ranked by paid calls in the last 30 days.
          </p>
        </div>
        <Link
          href="/marketplace"
          className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] uppercase text-primary hover:underline"
        >
          View all
          <span className="material-symbols-outlined text-[14px]" aria-hidden>
            arrow_forward
          </span>
        </Link>
      </div>

      {top === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              aria-hidden
              className="h-44 animate-pulse rounded-xl border border-outline-variant/20 bg-surface-container-low"
            />
          ))}
        </div>
      ) : top.length === 0 ? (
        <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-10 text-center">
          <p className="text-on-surface-variant">
            {topErr
              ? `Couldn't load top agents (${topErr}).`
              : 'No paid traffic yet. Sellers publish in under a minute — be the first.'}
          </p>
          <Link href="/brain" className="mt-3 inline-block text-sm text-primary hover:underline">
            Publish your knowledge →
          </Link>
        </div>
      ) : (
        <ul role="list" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {top.map((a) => (
            <li key={a.id}>
              <HighlightCard a={a} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HighlightCard({ a }: { a: TopAgent }) {
  const price = priceFromPricing(a.pricing);
  const description =
    a.description?.trim() ||
    a.persona?.system_prompt?.slice(0, 140) ||
    'Encrypted AI agent powered by Fhenix CoFHE.';
  return (
    <Link
      href={`/agent/${a.brain_id}`}
      className="agent-card-border encryption-glow group flex h-full flex-col gap-3 rounded-xl bg-surface p-5"
    >
      <div className="flex items-start justify-between gap-3 border-b border-white/5 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <span className="material-symbols-outlined text-[20px]" aria-hidden>
              smart_toy
            </span>
          </div>
          <div className="min-w-0">
            <h3 className="truncate font-headline text-base font-semibold leading-snug text-on-surface group-hover:text-primary">
              {a.title || `Agent #${a.brain_id}`}
            </h3>
            <span className="font-mono text-[11px] text-on-surface-variant">
              ID: {shortId(a.id)}
            </span>
          </div>
        </div>
        <span className="matrix-chip rounded px-2 py-0.5 font-mono text-[10px] uppercase">
          Active
        </span>
      </div>
      <p className="line-clamp-3 text-sm text-on-surface-variant">{description}</p>
      <div className="mt-auto flex items-end justify-between gap-2 border-t border-white/5 pt-3">
        <div className="flex flex-col">
          <span className="font-mono text-[10px] uppercase text-outline">Cost / query</span>
          <span className="font-mono text-sm text-on-surface">
            {price
              ? `$${Number(price.amount).toFixed(2)} ${RAIL_LABEL[price.rail] ?? price.rail}`
              : 'Free preview'}
          </span>
        </div>
        <span className="font-mono text-[10px] text-on-surface-variant">
          {a.calls_30d} calls · 30d
        </span>
      </div>
    </Link>
  );
}

function ResultsSection({
  result,
  byId,
}: {
  result: DiscoverResult;
  byId: Record<string, TopAgent>;
}) {
  if (result.candidates.length === 0) {
    return (
      <section
        aria-live="polite"
        className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-10 text-center"
      >
        <p className="text-on-surface-variant">
          No exact match yet. Try different phrasing — or be the first to publish on this topic.
        </p>
        <div className="mt-3 flex flex-wrap justify-center gap-3">
          <Link href="/marketplace" className="text-sm text-primary hover:underline">
            Browse marketplace →
          </Link>
          <Link href="/brain" className="text-sm text-primary hover:underline">
            Publish your knowledge →
          </Link>
        </div>
      </section>
    );
  }
  return (
    <section aria-live="polite" aria-labelledby="result-h" className="space-y-4">
      <div className="flex items-end justify-between gap-2 border-b border-white/5 pb-3">
        <div>
          <h2 id="result-h" className="font-headline text-2xl font-bold">
            {result.candidates.length} matching agent
            {result.candidates.length === 1 ? '' : 's'}
          </h2>
          <p className="text-sm text-on-surface-variant">Ranked by relevance to your demand.</p>
        </div>
        {result.bundle && (
          <Link
            href={`/bundles/${encodeURIComponent(result.bundle.id)}`}
            className="shrink-0 rounded-full bg-primary px-3 py-1.5 text-sm text-on-primary hover:opacity-90"
          >
            ${Number(result.bundle.aggregate_price_usdc).toFixed(4)} · review bundle
          </Link>
        )}
      </div>
      <ul role="list" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {result.candidates.map((c, i) => (
          <li key={c.agent_id}>
            <ResultCard c={c} a={byId[c.agent_id]} rank={i + 1} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ResultCard({ c, a, rank }: { c: Candidate; a?: TopAgent; rank: number }) {
  const price = priceFromPricing(c.pricing);
  const title = a?.title || `Agent ${shortId(c.agent_id)}`;
  const description =
    a?.description?.trim() ||
    c.persona_summary?.trim() ||
    'Encrypted AI agent matching your demand.';
  const href = a?.brain_id ? `/agent/${a.brain_id}` : `/marketplace?agent=${c.agent_id}`;
  return (
    <Link
      href={href}
      className="agent-card-border encryption-glow group flex h-full flex-col gap-3 rounded-xl bg-surface p-5"
    >
      <div className="flex items-start justify-between gap-3 border-b border-white/5 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 min-w-7 items-center justify-center rounded bg-primary px-1 font-mono text-xs text-on-primary">
            #{rank}
          </span>
          <h3 className="truncate font-headline text-base font-semibold leading-snug text-on-surface group-hover:text-primary">
            {title}
          </h3>
        </div>
        <span
          className="rounded bg-primary/10 px-2 py-0.5 font-mono text-[11px] text-primary"
          title="Match score"
        >
          {(c.score * 100).toFixed(0)}%
        </span>
      </div>
      {c.reason && (
        <p className="line-clamp-2 text-xs italic text-on-surface-variant">“{c.reason}”</p>
      )}
      <p className="line-clamp-3 text-sm text-on-surface-variant">{description}</p>
      <div className="mt-auto flex items-end justify-between gap-2 border-t border-white/5 pt-3">
        <span className="font-mono text-xs text-on-surface">
          {price
            ? `$${Number(price.amount).toFixed(2)} ${RAIL_LABEL[price.rail] ?? price.rail}`
            : 'Free preview'}
        </span>
        <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase text-primary">
          Open
          <span className="material-symbols-outlined text-[14px]" aria-hidden>
            arrow_forward
          </span>
        </span>
      </div>
    </Link>
  );
}
