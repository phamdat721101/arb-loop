'use client';
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
    return Array.from(set);
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
        <h1 className="font-headline text-3xl font-bold">Loop marketplace</h1>
        <p className="text-on-surface-variant">
          Browse loops by category. Each loop is a published manifest + persona + pricing.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search loops, capabilities, tags…"
          className="flex-1 min-w-[260px] rounded-full border border-outline-variant/40 bg-surface px-4 py-2 text-sm"
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
        <p className="py-12 text-center text-on-surface-variant">No agents match your filter.</p>
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
