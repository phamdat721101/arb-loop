'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { usePrivyEvmAddress } from '@/hooks/useActiveWallet';
import { usePermit } from '@/hooks/usePermit';
import { usePrivacyDisclosure } from '@/hooks/useEncryptedBalance';
import { PermitManager } from '@/components/PermitManager';
import {
  AGENT_BACKEND_URL,
  BRAIN_KEY_VAULT_ADDRESS,
  KNOWLEDGE_REGISTRY_ADDRESS,
  SUBSCRIPTION_CONTROLLER_ADDRESS,
} from '@/lib/contracts';

const CONTRACTS = [
  { name: 'BrainKeyVault', address: BRAIN_KEY_VAULT_ADDRESS },
  { name: 'KnowledgeBaseRegistry', address: KNOWLEDGE_REGISTRY_ADDRESS },
  { name: 'SubscriptionController', address: SUBSCRIPTION_CONTROLLER_ADDRESS },
];

/**
 * Settings — wallet, encryption, contracts (Arbitrum-only).
 */
export default function SettingsPage() {
  const { authenticated, ready, login, logout } = usePrivy();
  const userAddress = usePrivyEvmAddress();
  const { permitState, reason, authorize, revoke, loading, error } = usePermit(userAddress);
  const disclosure = usePrivacyDisclosure();

  if (!ready) return null;
  if (!authenticated) {
    return (
      <div className="space-y-3 py-20 text-center">
        <h1 className="font-headline text-2xl font-bold">Sign in to manage settings</h1>
        <button onClick={login} className="rounded-full bg-primary px-5 py-3 text-on-primary">
          Sign in
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="font-headline text-3xl font-bold">Settings</h1>
        <p className="text-on-surface-variant">Encryption and contract addresses.</p>
      </div>

      <section className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-6">
        <h2 className="font-headline text-lg font-semibold">Wallet</h2>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-xs text-on-surface-variant">EVM address</div>
            <div className="truncate font-mono text-sm">{userAddress}</div>
          </div>
          <button
            onClick={logout}
            className="rounded-full border border-outline-variant/40 px-4 py-2 text-sm text-error transition-colors hover:border-error/40"
          >
            Sign out
          </button>
        </div>
      </section>

      <MyActivitySection wallet={userAddress} />

      <section className="space-y-3">
        <h2 className="font-headline text-lg font-semibold">Encryption</h2>
        <PermitManager
          permitState={permitState}
          authorize={authorize}
          revoke={revoke}
          loading={loading}
          error={error}
          reason={reason}
        />
      </section>

      <section className="space-y-3">
        <h2 className="font-headline text-lg font-semibold">Privacy disclosure</h2>
        <label className="flex items-center justify-between gap-4 rounded-xl border border-outline-variant/30 bg-surface p-4">
          <div className="min-w-0">
            <div className="font-medium">Show encrypted receipts (advanced)</div>
            <div className="text-xs text-on-surface-variant">
              Reveals settlement IDs and FHE handles next to each chat message. Off by default.
            </div>
          </div>
          <input
            type="checkbox"
            checked={disclosure.enabled}
            onChange={(e) => disclosure.toggle(e.target.checked)}
            className="h-5 w-5 cursor-pointer accent-primary"
          />
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="font-headline text-lg font-semibold">Contracts (Arbitrum Sepolia)</h2>
        <div className="overflow-hidden rounded-xl border border-outline-variant/30 bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-container-high text-left font-mono text-[10px] uppercase text-on-surface-variant">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Address</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {CONTRACTS.map((c) => (
                <tr key={c.name} className="border-t border-outline-variant/20">
                  <td className="px-4 py-3 font-medium">{c.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-on-surface-variant">
                    {c.address || '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {c.address && (
                      <Link
                        href={`https://sepolia.arbiscan.io/address/${c.address}`}
                        target="_blank"
                        rel="noopener"
                        className="text-xs text-primary hover:underline"
                      >
                        View ↗
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ─── My activity — re-homed dashboard widget ────────────────────────────

interface EarningsResponse {
  wallet: string;
  pricePerQueryUsdc: number;
  totalQueries: number;
  totalUsdc: number;
  settledTotalUsdc: number;
  settledCallCount: number;
  brains: Array<{ id: number; title: string; queryCount: number; earnedUsdc: number; lastAt: string | null }>;
  receipts: Array<{ brainId: number; brainTitle: string; agentAddress: string; amount: string; currency: string; at: string }>;
  paidCalls: Array<{ slug: string; buyer: string; amountUsdc: string; txHash: string; network: string; method: string; explorerUrl: string; at: string }>;
}

function MyActivitySection({ wallet }: { wallet: string | undefined }) {
  const [data, setData] = useState<EarningsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!wallet) return;
    setLoading(true);
    fetch(`${AGENT_BACKEND_URL}/brains/earnings/${wallet}`, {
      headers: { 'x-wallet-address': wallet },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as EarningsResponse;
      })
      .then(setData)
      .catch((e) => setErr(e?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, [wallet]);

  if (!wallet) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h2 className="font-headline text-lg font-semibold">My activity</h2>
          <p className="text-sm text-on-surface-variant">
            Cash-flow from your published brains. Live counts from <code className="font-mono text-xs">paid_calls</code>.
          </p>
        </div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 font-mono text-[11px] uppercase text-primary hover:underline"
        >
          View full dashboard
          <span className="material-symbols-outlined text-[14px]" aria-hidden>arrow_forward</span>
        </Link>
      </div>

      {loading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} aria-hidden className="h-24 animate-pulse rounded-xl border border-outline-variant/20 bg-surface-container-low" />
          ))}
        </div>
      )}

      {err && !loading && (
        <p role="alert" className="text-sm text-amber-500">Couldn&apos;t load activity ({err}).</p>
      )}

      {data && !loading && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard label="Total earned (settled)" value={`$${data.settledTotalUsdc.toFixed(4)}`} hint={`${data.settledCallCount} on-chain calls`} />
            <KpiCard label="Lifetime queries" value={String(data.totalQueries)} hint={`@ $${data.pricePerQueryUsdc} avg`} />
            <KpiCard label="Brains published" value={String(data.brains.length)} hint={data.brains.length ? 'live in catalog' : 'none yet'} />
            <KpiCard label="Recent receipts" value={String(data.receipts.length + data.paidCalls.length)} hint="last 50 each" />
          </div>

          {data.brains.length === 0 ? (
            <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-6 text-center">
              <p className="text-on-surface-variant">No brains published yet.</p>
              <Link href="/seller/onboard" className="mt-2 inline-block text-sm text-primary hover:underline">
                Publish your first agent →
              </Link>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-outline-variant/30 bg-surface">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-surface-variant/40">
                  <tr>
                    <th className="px-4 py-2 font-medium">Brain</th>
                    <th className="px-4 py-2 text-right font-medium">Queries</th>
                    <th className="px-4 py-2 text-right font-medium">Earned (USDC)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.brains.slice(0, 5).map((b) => (
                    <tr key={b.id} className="border-t border-outline-variant/20">
                      <td className="px-4 py-2">
                        <Link href={`/agent/${b.id}`} className="text-primary hover:underline">
                          {b.title || `Brain #${b.id}`}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs">{b.queryCount}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs">${b.earnedUsdc.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-outline-variant/30 bg-surface p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">{label}</div>
      <div className="mt-1 font-headline text-2xl font-semibold text-on-surface">{value}</div>
      {hint && <div className="mt-1 text-xs text-on-surface-variant">{hint}</div>}
    </div>
  );
}
