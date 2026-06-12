'use client';
/**
 * /marketplace — unified marketplace.
 *
 * Single source of truth for browsing all OpenX agents (loops). The legacy
 * /arbloop/marketplace route redirects here so there's only one URL + one
 * nav entry. Per the v0.0 simple ship: agents are arb-loop loops; legacy
 * openx brain listings are deprecated and not surfaced here.
 *
 * SOLID:
 *  - SRP: one page, one fetch (useAgentList), three render blocks
 *    (search + filters + grid).
 *  - DIP: data layer = useAgentList hook; AgentCard owns rendering.
 *  - No new files: replaces the legacy openx brain marketplace verbatim.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useAgentList } from '@/hooks/useArbLoop';
import { AgentCard } from '@/components/arbloop';

export default function MarketplacePage() {
  const { agents, loading, error } = useAgentList();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  const categories = useMemo(() => {
    const set = new Set<string>();
    agents.forEach((a) => a.category && set.add(a.category));
    return Array.from(set).sort();
  }, [agents]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return agents.filter((a) => {
      if (a.revoked) return false;
      if (category && a.category !== category) return false;
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        (a.short_description ?? '').toLowerCase().includes(q) ||
        (a.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [agents, search, category]);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-headline text-3xl font-bold">Marketplace</h1>
        <p className="text-on-surface-variant">
          Hire <strong>loops, not prompts</strong>. Each agent is a published persona + price + iteration count
          — sign once, pay USDC, your input stays FHE-encrypted on Fhenix CoFHE.
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link
            href="/arbloop/seller/onboard"
            className="inline-flex items-center gap-1 rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-on-primary"
          >
            Publish a loop
          </Link>
          <Link
            href="/arbloop"
            className="inline-flex items-center gap-1 rounded-full border border-outline-variant/40 px-4 py-1.5 text-sm hover:border-primary/40"
          >
            How it works →
          </Link>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents, capabilities, tags…"
          className="flex-1 min-w-[260px] rounded-full border border-outline-variant/40 bg-surface px-4 py-2 text-sm focus:border-primary/60 focus:outline-none"
        />
        <button
          onClick={() => setCategory(null)}
          className={`rounded-full border px-3 py-1.5 text-xs ${
            category === null ? 'border-primary bg-primary/10 text-primary' : 'border-outline-variant/40'
          }`}
        >
          All
        </button>
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c === category ? null : c)}
            className={`rounded-full border px-3 py-1.5 text-xs ${
              category === c ? 'border-primary bg-primary/10 text-primary' : 'border-outline-variant/40'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="py-12 text-center text-on-surface-variant">Loading…</p>
      ) : error ? (
        <p className="py-12 text-center text-amber-500">{error}</p>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center space-y-2">
          <p className="text-on-surface-variant">No agents match your filter.</p>
          <Link href="/arbloop/seller/onboard" className="text-sm text-primary hover:underline">
            Be the first to publish →
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((a) => (
            <AgentCard key={`${a.agent_registry_address}-${a.agent_id}`} a={a} />
          ))}
        </div>
      )}
    </div>
  );
}
