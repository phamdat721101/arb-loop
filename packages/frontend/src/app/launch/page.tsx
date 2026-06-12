'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AGENT_BACKEND_URL } from '@/lib/contracts';

/**
 * /launch — public kill-criteria scoreboard per docs/USP_BRIEF.md.
 * Reads /v2/admin/stats with a public-only subset; if the admin token is
 * unset we still surface what's countable client-side via /v2/brains.
 *
 * Honest by design: numbers refresh every 10s; thresholds come from the brief.
 */

interface Stats {
  distinctSellerWallets: number;
  brainsWithRevenue: number;
  distinctAgentWallets: number;
  totalQueriesInclDemo: number;
  totalUsdcInclDemo: number;
}

const CRITERIA = [
  { key: 'distinctSellerWallets', label: 'Sellers (distinct wallets)', pass: 100, mixed: 30 },
  { key: 'brainsWithRevenue', label: 'Brains earning from ≥3 buyers', pass: 5, mixed: 1 },
  { key: 'distinctAgentWallets', label: 'Buyer agents (distinct wallets)', pass: 20, mixed: 5 },
  { key: 'totalUsdcInclDemo', label: 'Settled USDC (incl. demo)', pass: 50, mixed: 5 },
] as const;

function verdict(value: number, c: { pass: number; mixed: number }): 'pass' | 'mixed' | 'fail' {
  if (value >= c.pass) return 'pass';
  if (value >= c.mixed) return 'mixed';
  return 'fail';
}

const COLOR: Record<'pass' | 'mixed' | 'fail', string> = {
  pass: 'text-secondary border-secondary/40 bg-secondary/10',
  mixed: 'text-tertiary border-tertiary/40 bg-tertiary/10',
  fail: 'text-error border-error/40 bg-error/10',
};

export default function LaunchPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const r = await fetch(`${AGENT_BACKEND_URL}/v2/admin/stats`, {
          headers: process.env.NEXT_PUBLIC_ADMIN_TOKEN
            ? { 'x-admin-token': process.env.NEXT_PUBLIC_ADMIN_TOKEN }
            : {},
        });
        if (r.ok) {
          const j = (await r.json()) as Stats;
          if (!cancelled) setStats(j);
        } else {
          if (!cancelled) setError(`stats unavailable (${r.status})`);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'fetch failed');
      }
    };
    run();
    const id = setInterval(run, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-8 py-12">
      <header className="space-y-2">
        <h1 className="font-headline text-3xl font-bold">Kill-criteria scoreboard</h1>
        <p className="text-on-surface-variant">
          Per <Link href="https://github.com/phamdat721701/privacy-context/blob/main/docs/USP_BRIEF.md" className="text-primary hover:underline">USP_BRIEF.md</Link>.
          Pass / mixed / fail thresholds are public; numbers refresh every 10s.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-4 text-sm text-on-surface-variant">
          {error}. Set <code className="font-mono">NEXT_PUBLIC_ADMIN_TOKEN</code> for full numbers.
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {CRITERIA.map((c) => {
          const value = stats ? (stats[c.key as keyof Stats] as number) : 0;
          const v = stats ? verdict(value, c) : 'fail';
          return (
            <div key={c.key} className={`rounded-xl border p-4 ${COLOR[v]}`}>
              <div className="text-xs uppercase tracking-wider opacity-80">{c.label}</div>
              <div className="mt-2 font-headline text-3xl font-bold">
                {c.key === 'totalUsdcInclDemo' ? `$${value.toFixed(2)}` : value}
              </div>
              <div className="mt-1 text-xs">
                pass ≥ {c.pass}{' '}· mixed ≥ {c.mixed}{' · '}
                <span className="font-semibold uppercase">{stats ? v : '—'}</span>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-center text-xs text-on-surface-variant">
        Live · {AGENT_BACKEND_URL.replace(/^https?:\/\//, '')}
      </p>
    </div>
  );
}
