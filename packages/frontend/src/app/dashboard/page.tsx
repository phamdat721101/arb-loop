'use client';

import { useEffect, useState } from 'react';
import { AGENT_BACKEND_URL } from '@/lib/contracts';
import { useActiveWallet } from '@/hooks/useActiveWallet';

/**
 * /dashboard — Frame F1 cash-flow proof.
 *
 * Renders live counts from /v3/dashboard/stats. SWR-style polling (30s).
 * Receipts link to Arbiscan / Basescan via `explorerUrl(network, txHash)`.
 *
 * SOLID:
 *   - SRP: one page, one fetch, three render blocks. No cross-component state.
 */

interface Stats {
  counts: {
    brains_published: number;
    workflows_published: number;
    skills_published: number;
    reflective_published: number;
    workflow_runs_total: number;
    workflow_runs_24h: number;
    total_usdc_routed: string;
    usdc_routed_24h: string;
  };
  topSellers: Array<{ seller: string; earned: string; calls: number }>;
  recentReceipts: Array<{
    /** New in arb-loop merge: 'paid_call' | 'arbloop_x402' | 'arbloop_iter' */
    kind?: string;
    slug: string | null;
    buyer: string | null;
    amount_usdc: string | null;
    tx_hash: string | null;
    network: string | null;
    method: string | null;
    created_at: string;
  }>;
  walUsdRate?: { usdPerWal: number; cached: boolean; updatedAt: number };
  generatedAt: string;
}

function explorerUrl(network: string, txHash: string): string | null {
  if (!txHash || txHash.startsWith('mock-') || txHash.startsWith('free-')) return null;
  if (network === 'arbitrum-sepolia') return `https://sepolia.arbiscan.io/tx/${txHash}`;
  if (network === 'arbitrum-one') return `https://arbiscan.io/tx/${txHash}`;
  if (network === 'base-sepolia') return `https://sepolia.basescan.org/tx/${txHash}`;
  return null;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { address } = useActiveWallet();

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      // Endpoint is public-by-design (whitelisted in auth.ts), but we
      // pass the wallet header opportunistically so the dashboard works
      // even on older API builds where the public-path regex hasn't
      // shipped yet (defensive against stale deploys).
      const headers: Record<string, string> = {};
      if (address) headers['x-wallet-address'] = address;
      fetch(`${AGENT_BACKEND_URL}/v3/dashboard/stats`, { headers })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
        .then((j) => !cancelled && setStats(j))
        .catch((e) => !cancelled && setErr(String(e?.message ?? e)));
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [address]);

  if (err && !stats) {
    return (
      <div className="space-y-4 p-6">
        <h1 className="font-headline text-3xl font-bold">Dashboard</h1>
        <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-500">
          Cash-flow stats unavailable: {err}. The /v3/dashboard/stats endpoint may be on an older build.
        </p>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="p-6 text-on-surface-variant">Loading cash-flow proof…</div>
    );
  }

  const c = stats.counts;
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="font-headline text-3xl font-bold">Cash-flow dashboard</h1>
        <p className="text-sm text-on-surface-variant">
          Live counts from <code className="rounded bg-surface-container-low px-1">paid_calls</code> · refresh every 30s · last fetch{' '}
          {new Date(stats.generatedAt).toLocaleTimeString()}
        </p>
      </div>

      {/* Seller rollup — only renders when the connected wallet has a sellers row. */}
      {address ? <SellerSection walletAddress={address} /> : null}

      {/* Top counts — the headline numbers Frame F1 cares about. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Brains" value={c.brains_published} hint="published" />
        <StatCard label="Workflows" value={c.workflows_published} hint="published" />
        <StatCard label="Skills" value={c.skills_published} hint="published" />
        <StatCard label="Reflective traces" value={c.reflective_published} hint="published" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="USDC routed (total)"
          value={`$${Number(c.total_usdc_routed).toFixed(2)}`}
          hint="all-time, all rails"
          accent
        />
        <StatCard
          label="USDC routed (24h)"
          value={`$${Number(c.usdc_routed_24h).toFixed(2)}`}
          hint="last 24 hours"
          accent
        />
        <StatCard
          label="Workflow runs"
          value={`${c.workflow_runs_total} (${c.workflow_runs_24h} in 24h)`}
          hint="executions persisted"
        />
      </div>

      {/* Tatum infrastructure section — surfaces the 3 Tatum products live in OpenX. */}
      {/* Section removed: Sui-specific Walrus pricing + Sui RPC status —
          unrelated to the Arbitrum + Fhenix v0.0 ship. */}

      <section>
        <h2 className="mb-3 font-headline text-xl font-semibold">Top earners</h2>
        {stats.topSellers.length === 0 ? (
          <p className="text-sm text-on-surface-variant">No earnings yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-outline-variant/30">
            <table className="min-w-full text-sm">
              <thead className="bg-surface-container-low text-xs uppercase text-on-surface-variant">
                <tr>
                  <th className="px-4 py-2 text-left">Seller</th>
                  <th className="px-4 py-2 text-right">Earned (USDC)</th>
                  <th className="px-4 py-2 text-right">Calls</th>
                </tr>
              </thead>
              <tbody>
                {stats.topSellers.map((s, i) => (
                  <tr key={s.seller} className="border-t border-outline-variant/20">
                    <td className="px-4 py-2 font-mono text-xs">
                      {i + 1}. {s.seller.slice(0, 6)}…{s.seller.slice(-4)}
                    </td>
                    <td className="px-4 py-2 text-right">${Number(s.earned).toFixed(2)}</td>
                    <td className="px-4 py-2 text-right">{s.calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-headline text-xl font-semibold">Recent receipts</h2>
        {stats.recentReceipts.length === 0 ? (
          <p className="text-sm text-on-surface-variant">No receipts yet.</p>
        ) : (
          <ul className="space-y-2">
            {stats.recentReceipts.map((r, i) => {
              // Defensive coercion: server-side UNION across paid_calls,
              // arbloop_x402_settlements, and arbloop_iteration_log can
              // include rows where tx_hash / buyer are NULL (e.g. an iter
              // row whose x402_settlement_tx wasn't persisted by the
              // chain listener). Treat these as the source of truth, not
              // a render-time crash.
              const buyer = String(r.buyer ?? '');
              const txHash = String(r.tx_hash ?? '');
              const network = String(r.network ?? '');
              const method = String(r.method ?? '');
              const slug = String(r.slug ?? '—');
              const url = txHash ? explorerUrl(network, txHash) : null;
              return (
                <li
                  key={`${txHash || 'no-tx'}-${i}`}
                  className="flex items-center justify-between gap-4 rounded-lg border border-outline-variant/30 bg-surface px-4 py-2 text-xs"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono">{slug}</span>
                    <span className="text-on-surface-variant">
                      {buyer ? `${buyer.slice(0, 6)}…${buyer.slice(-4)}` : '—'}
                      {network ? ` · ${network}` : ''}
                      {method ? ` · ${method}` : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-primary">
                      ${Number(r.amount_usdc ?? 0).toFixed(4)}
                    </span>
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        explorer ↗
                      </a>
                    ) : txHash ? (
                      <span className="text-on-surface-variant">{txHash.slice(0, 10)}…</span>
                    ) : (
                      <span className="text-on-surface-variant">pending</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: number | string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        accent
          ? 'border-primary/30 bg-primary/5'
          : 'border-outline-variant/30 bg-surface'
      }`}
    >
      <div className="text-xs uppercase text-on-surface-variant">{label}</div>
      <div className="mt-1 font-headline text-2xl font-bold text-on-surface">{value}</div>
      {hint ? <div className="text-xs text-on-surface-variant">{hint}</div> : null}
    </div>
  );
}


// ─── Seller rollup section (PRD-14 §7) ──────────────────────────────────
// Renders only when the connected wallet has a `sellers` row. Hits
// `/v3/marketplace/seller/dashboard` for rolled-up earnings + per-agent
// table; CSV export downloads from `/v3/marketplace/seller/dashboard.csv`.

interface SellerAgent {
  id: string;
  slug: string;
  kind: 'api' | 'workflow' | 'skill' | 'brain';
  domain: string;
  verification_tier: 'basic' | 'verified' | 'tee_attested';
  privacy_mode: 'fhe' | 'metadata-only' | 'off';
  created_at: string;
  earned_total: string;
  calls_total: number;
}
interface SellerEarnings {
  last_7d: string;
  last_30d: string;
  all_time: string;
  calls_7d: number;
}
interface SellerData {
  seller_id?: number | null;
  agents: SellerAgent[];
  earnings: SellerEarnings | null;
}

function SellerSection({ walletAddress }: { walletAddress: string }) {
  const [data, setData] = useState<SellerData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${AGENT_BACKEND_URL}/v3/marketplace/seller/dashboard`, {
      headers: { 'x-wallet-address': walletAddress },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((j) => !cancelled && setData(j as SellerData))
      .catch((e) => !cancelled && setErr(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  if (err) return null;
  if (!data || !data.seller_id || data.agents.length === 0) return null;

  const e = data.earnings ?? { last_7d: '0', last_30d: '0', all_time: '0', calls_7d: 0 };
  const csvUrl = `${AGENT_BACKEND_URL}/v3/marketplace/seller/dashboard.csv`;

  return (
    <section className="rounded-xl border border-[#00dbe9]/40 bg-[color-mix(in_oklab,_#00dbe9_4%,_transparent)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="material-symbols-outlined text-[18px] text-[#00dbe9]">storefront</span>
        <h2 className="font-headline text-base font-semibold">Your seller dashboard</h2>
        <span className="ml-auto rounded border border-[#00dbe9]/40 px-2 py-0.5 font-mono text-[10px] uppercase text-[#00dbe9]">
          {data.agents.length} agents
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Last 7 days" value={`$${Number(e.last_7d).toFixed(2)}`} hint={`${e.calls_7d} calls`} accent />
        <StatCard label="Last 30 days" value={`$${Number(e.last_30d).toFixed(2)}`} hint="USDC earned" />
        <StatCard label="All-time" value={`$${Number(e.all_time).toFixed(2)}`} hint="all rails" />
      </div>

      <div className="mt-4 overflow-x-auto rounded border border-outline-variant/30">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-container-low font-mono uppercase tracking-wider text-on-surface-variant">
            <tr>
              <th className="px-3 py-1.5">Agent</th>
              <th className="px-3 py-1.5">Kind</th>
              <th className="px-3 py-1.5">Privacy</th>
              <th className="px-3 py-1.5 text-right">Calls</th>
              <th className="px-3 py-1.5 text-right">Earned</th>
            </tr>
          </thead>
          <tbody>
            {data.agents.map((a) => (
              <tr key={a.id} className="border-t border-outline-variant/20 text-on-surface">
                <td className="px-3 py-1.5 font-mono">{a.slug}</td>
                <td className="px-3 py-1.5">{a.kind}</td>
                <td className="px-3 py-1.5 font-mono text-[10px] text-on-surface-variant">{a.privacy_mode}</td>
                <td className="px-3 py-1.5 text-right font-mono">{a.calls_total}</td>
                <td className="px-3 py-1.5 text-right font-mono text-[#13ff43]">${Number(a.earned_total).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={async () => {
            try {
              const r = await fetch(csvUrl, { headers: { 'x-wallet-address': walletAddress } });
              if (!r.ok) throw new Error(`${r.status}`);
              const blob = await r.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `seller-${data.seller_id}-audit.csv`;
              a.click();
              URL.revokeObjectURL(url);
            } catch (downloadErr) {
              setErr(String((downloadErr as Error)?.message ?? downloadErr));
            }
          }}
          className="rounded border border-outline-variant/40 px-3 py-1.5 text-xs text-on-surface-variant"
        >
          Download CSV audit trail
        </button>
        <a
          href="/seller/onboard"
          className="rounded border border-[#00dbe9] px-3 py-1.5 text-xs text-[#00dbe9]"
        >
          + Spawn new agent
        </a>
      </div>
    </section>
  );
}
