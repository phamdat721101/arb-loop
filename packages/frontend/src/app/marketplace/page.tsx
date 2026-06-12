'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AgentCard } from '@/components/AgentCard';
import { MarketplaceCard, type MarketplaceCardType } from '@/components/MarketplaceCard';
import { listAgents, type Agent } from '@/lib/agents';
import { AGENT_BACKEND_URL } from '@/lib/contracts';
import { createLogger } from '@/lib/clientLogger';

const log = createLogger('marketplace');

interface SuiProduct {
  id: string;
  workflow_key?: string;
  skill_key?: string;
  trace_key?: string;
  name: string;
  description?: string;
  default_price_usdc?: string;
  default_license_price_usdc?: string;
  steps?: unknown[];
  runs?: number;
  invocations?: number;
  licenses_sold?: number;
}

interface DiscoverBundle {
  id: string;
  aggregate_price_usdc: string;
  expires_at: number;
  steps: Array<{ rail: string; price_usdc: string; agent_id: string }>;
}
interface DiscoverResult {
  candidates: Array<{ agent_id: string; persona_summary: string; chain: string; score: number }>;
  bundle: DiscoverBundle | null;
}

export default function MarketplacePage() {
  const router = useRouter();
  const [activeType, setActiveType] = useState<'all' | MarketplaceCardType>('all');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [workflows, setWorkflows] = useState<SuiProduct[]>([]);
  const [skills, setSkills] = useState<SuiProduct[]>([]);
  const [reflective, setReflective] = useState<SuiProduct[]>([]);
  const [search, setSearch] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Discovery concierge state.
  const [discoverMsg, setDiscoverMsg] = useState('');
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [discoverResult, setDiscoverResult] = useState<DiscoverResult | null>(null);
  const [discoverErr, setDiscoverErr] = useState<string | null>(null);

  // Read ?type= from the URL once on mount (client-only; no SSR involvement).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const t = new URLSearchParams(window.location.search).get('type') as MarketplaceCardType | null;
    if (t && ['brain', 'skill', 'workflow', 'reflective'].includes(t)) setActiveType(t);
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      listAgents().catch(() => []),
      // Workflow / skill / reflective endpoints removed in arb-mem (Sui-only).
      Promise.resolve([] as SuiProduct[]),
      Promise.resolve([] as SuiProduct[]),
      Promise.resolve([] as SuiProduct[]),
    ])
      .then(([a, wf, sk, ref]) => {
        setAgents(a);
        setWorkflows(wf);
        setSkills(sk);
        setReflective(ref);
      })
      .finally(() => setLoading(false));
  }, []);

  // Top-10 most-frequent tags, used as filter chips.
  const tags = useMemo(() => {
    const seen = new Map<string, number>();
    agents.forEach((a) => a.tags.forEach((t) => seen.set(t, (seen.get(t) ?? 0) + 1)));
    return Array.from(seen.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag]) => tag);
  }, [agents]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return agents.filter((a) => {
      if (activeTag && !a.tags.includes(activeTag)) return false;
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [agents, search, activeTag]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="font-headline text-3xl font-bold">Marketplace</h1>
        <p className="text-on-surface-variant">
          Browse encrypted AI agents. Every answer is cryptographically verified.
        </p>
      </div>

      {/* Sell-on-OpenX CTA — re-homed here per IA cleanup (PRD-A.5). The
          buyer-becomes-seller pivot happens while browsing what's already
          listed; the global nav stays mode-only. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-secondary/30 bg-secondary/5 px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined mt-0.5 text-secondary" aria-hidden>
            sell
          </span>
          <div>
            <div className="text-sm font-medium text-on-surface">Have knowledge worth selling?</div>
            <div className="text-xs text-on-surface-variant">
              Publish in 60 seconds. Other agents pay per query — knowledge stays encrypted in your browser.
            </div>
          </div>
        </div>
        <Link
          href="/seller/onboard"
          className="inline-flex items-center gap-1 rounded-full bg-secondary/20 px-3 py-1.5 text-xs font-medium text-secondary transition-colors hover:bg-secondary/30"
        >
          Sell on OpenX
          <span className="material-symbols-outlined text-[14px]" aria-hidden>arrow_forward</span>
        </Link>
      </div>

      {/* Discovery concierge — describe what you need; get a signed bundle. */}
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
        <div className="mb-2 text-xs uppercase text-primary">Find an agent</div>
        <div className="flex gap-2">
          <input
            value={discoverMsg}
            onChange={(e) => setDiscoverMsg(e.target.value)}
            placeholder="I need to audit a Solidity FHE contract and write a one-pager."
            className="flex-1 rounded-lg border border-outline-variant/40 bg-surface px-3 py-2 text-on-surface focus:border-primary/60 focus:outline-none"
            onKeyDown={async (e) => {
              if (e.key !== 'Enter' || !discoverMsg.trim() || discoverBusy) return;
              setDiscoverBusy(true);
              setDiscoverErr(null);
              try {
                const r = await fetch(`${AGENT_BACKEND_URL}/v3/discover`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ message: discoverMsg }),
                });
                if (!r.ok) throw new Error(`${r.status}`);
                setDiscoverResult(await r.json());
                log.info('discover:ok', { len: discoverMsg.length });
              } catch (err: any) {
                log.warn('discover:failed', { err: err?.message });
                setDiscoverErr(`${err?.message ?? err} — API may be on an older build.`);
              } finally {
                setDiscoverBusy(false);
              }
            }}
          />
          <button
            disabled={discoverBusy || !discoverMsg.trim()}
            onClick={async () => {
              setDiscoverBusy(true);
              setDiscoverErr(null);
              try {
                const r = await fetch(`${AGENT_BACKEND_URL}/v3/discover`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ message: discoverMsg }),
                });
                if (!r.ok) throw new Error(`${r.status}`);
                setDiscoverResult(await r.json());
              } catch (err: any) {
                setDiscoverErr(`${err?.message ?? err} — API may be on an older build.`);
              } finally {
                setDiscoverBusy(false);
              }
            }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
          >
            {discoverBusy ? '…' : 'Discover'}
          </button>
        </div>
        {discoverErr && <p className="mt-2 text-xs text-amber-500">{discoverErr}</p>}
        {discoverResult && discoverResult.bundle && (
          <div className="mt-3 flex items-center justify-between rounded-lg border border-primary/40 bg-surface px-3 py-2">
            <div>
              <div className="text-xs text-on-surface-variant">{discoverResult.candidates.length} candidates · bundle ready</div>
              <div className="font-mono text-[10px] text-on-surface-variant">{discoverResult.bundle.id}</div>
            </div>
            <button
              onClick={() => router.push(`/bundles/${encodeURIComponent(discoverResult.bundle!.id)}`)}
              className="rounded-full bg-primary px-3 py-1 text-xs text-on-primary"
            >
              ${Number(discoverResult.bundle.aggregate_price_usdc).toFixed(4)} → review
            </button>
          </div>
        )}
        {discoverResult && !discoverResult.bundle && (
          <p className="mt-2 text-xs text-on-surface-variant">No matches yet — try different phrasing or browse below.</p>
        )}
      </div>

      <div className="relative">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
          search
        </span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents, capabilities, tags..."
          className="w-full rounded-full border border-outline-variant/40 bg-surface py-3 pl-10 pr-4 text-on-surface placeholder:text-on-surface-variant focus:border-primary/60 focus:outline-none"
        />
      </div>

      {/* Type filter — Arbitrum-only product types. */}
      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'brain', 'skill', 'workflow', 'reflective'] as const).map((t) => (
          <button
            key={t}
            onClick={() => {
              setActiveType(t);
              const params = new URLSearchParams(window.location.search);
              if (t === 'all') params.delete('type'); else params.set('type', t);
              router.replace(`/marketplace${params.toString() ? '?' + params.toString() : ''}`);
            }}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              activeType === t
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-outline-variant/40 text-on-surface-variant hover:border-primary/40'
            }`}
          >
            {t === 'all' ? 'All' : t.charAt(0).toUpperCase() + t.slice(1) + 's'}
          </button>
        ))}
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setActiveTag(null)}
            className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
              activeTag === null
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-outline-variant/40 text-on-surface-variant hover:border-primary/40'
            }`}
          >
            All tags
          </button>
          {tags.map((t) => (
            <button
              key={t}
              onClick={() => setActiveTag(t === activeTag ? null : t)}
              className={`rounded-full border px-3 py-1.5 font-mono text-xs transition-colors ${
                activeTag === t
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-outline-variant/40 text-on-surface-variant hover:border-primary/40'
              }`}
            >
              #{t}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="py-20 text-center text-on-surface-variant">Loading marketplace…</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(activeType === 'all' || activeType === 'brain') &&
            filtered.map((a) => (
              <MarketplaceCard
                key={`brain-${a.id}`}
                type="brain"
                id={a.id}
                title={a.title}
                description={a.description}
                priceUsdc={a.price?.amount ?? '0.05'}
                meta={{ tags: a.tags }}
              />
            ))}
          {(activeType === 'all' || activeType === 'workflow') &&
            workflows.map((w) => (
              <MarketplaceCard
                key={`wf-${w.id}`}
                type="workflow"
                id={w.id}
                title={w.name}
                description={w.description}
                priceUsdc={w.default_price_usdc ?? '0'}
                meta={{
                  stepCount: Array.isArray(w.steps) ? w.steps.length : 7,
                  runs: w.runs ?? 0,
                }}
              />
            ))}
          {(activeType === 'all' || activeType === 'skill') &&
            skills.map((s) => (
              <MarketplaceCard
                key={`sk-${s.id}`}
                type="skill"
                id={s.id}
                title={s.name}
                description={s.description}
                priceUsdc={s.default_price_usdc ?? '0'}
              />
            ))}
          {(activeType === 'all' || activeType === 'reflective') &&
            reflective.map((r) => (
              <MarketplaceCard
                key={`ref-${r.id}`}
                type="reflective"
                id={r.id}
                title={r.name ?? `Reflective trace ${r.trace_key}`}
                description={r.description ?? 'Agent metacognition license'}
                priceUsdc={r.default_license_price_usdc ?? '5.00'}
                meta={{ licensesSold: r.licenses_sold ?? 0 }}
              />
            ))}
        </div>
      )}
    </div>
  );
}
