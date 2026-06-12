'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePrivy } from '@privy-io/react-auth';
import { listMyAgents, type Agent } from '@/lib/agents';
import { usePermit } from '@/hooks/usePermit';
import { PermitManager } from '@/components/PermitManager';
import { AGENT_BACKEND_URL } from '@/lib/contracts';
import { useActiveWallet } from '@/hooks/useActiveWallet';

export default function StudioPage() {
  const { authenticated, ready, login } = usePrivy();
  const { address } = useActiveWallet();
  const userAddress = address as `0x${string}` | undefined;
  const {
    permitState,
    reason,
    authorize,
    revoke,
    loading: permitLoading,
    error: permitError,
  } = usePermit(userAddress);
  // Permit gate is EVM-only (Arbitrum-only build) — Fhenix CoFHE authorizes
  // brain-key decryption.
  const hasPermit = !!permitState.serializedPermit;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!userAddress) return;
    setLoading(true);
    // Defensive joined view (PRD-17 §1c): show every agent the connected
    // wallet owns — both v1 brains (via listMyAgents → /brains/mine) and
    // v2 marketplace listings (via /v3/marketplace/seller/dashboard). The
    // dashboard endpoint joins on `agents.seller_id`; the brain list joins
    // on `brains.owner_address`. Together they catch every ownership path
    // without an extra schema migration.
    Promise.all([
      listMyAgents(userAddress),
      fetch(`${AGENT_BACKEND_URL}/v3/marketplace/seller/dashboard`, {
        headers: { 'x-wallet-address': userAddress },
      })
        .then((r) => (r.ok ? r.json() : { agents: [] }))
        .catch(() => ({ agents: [] })),
    ])
      .then(([brainAgents, dash]) => {
        // Dedupe: brain ids (number) vs agent uuids (string) live in
        // different keyspaces, so we union directly with no collision.
        // A v2-published listing exposes both a brain row and an agents
        // row — listMyAgents already returns the brain side; we fold the
        // v2-only fields (slug, kind, earnings) onto it where present.
        const dashAgents = (dash?.agents ?? []) as Array<{
          slug?: string;
          kind?: string;
          earned_total?: string;
          calls_total?: number;
        }>;
        const dashBySlug = new Map(dashAgents.filter((a) => a.slug).map((a) => [a.slug as string, a]));
        const merged = brainAgents.map((a) => {
          const m = a.slug ? dashBySlug.get(a.slug) : undefined;
          return m ? Object.assign({}, a, { _kind: m.kind, _earned: m.earned_total, _calls: m.calls_total }) : a;
        });
        setAgents(merged);
      })
      .finally(() => setLoading(false));
  }, [userAddress]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>, agentId: number) {
    const file = e.target.files?.[0];
    if (!file || !userAddress) return;
    setStatus(`Uploading ${file.name}…`);
    const form = new FormData();
    form.append('file', file);
    form.append('brainId', String(agentId));
    try {
      const r = await fetch(`${AGENT_BACKEND_URL}/upload`, {
        method: 'POST',
        headers: { 'x-wallet-address': userAddress },
        body: form,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error ?? `Upload failed (${r.status})`);
      }
      setStatus(`✓ Uploaded to agent #${agentId}`);
    } catch (err: any) {
      setStatus(err?.message ?? 'Upload failed');
    } finally {
      e.target.value = '';
    }
  }

  if (!ready) return null;
  if (!authenticated) {
    return (
      <div className="space-y-3 py-20 text-center">
        <h1 className="font-headline text-2xl font-bold">Connect to open Studio</h1>
        <p className="text-on-surface-variant">Studio is for agent owners.</p>
        <button onClick={login} className="rounded-full bg-primary px-5 py-3 text-on-primary">
          Connect wallet
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <h1 className="font-headline text-3xl font-bold">Studio</h1>
          <p className="text-on-surface-variant">
            Train, manage, and publish your encrypted AI agents.
          </p>
        </div>
        <Link
          href="/seller/onboard?return=/studio"
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-on-primary hover:opacity-90"
        >
          <span className="material-symbols-outlined text-[18px]">rocket_launch</span>
          + New agent
        </Link>
      </div>
      <EarningsTile userAddress={userAddress} agents={agents} />

      {!hasPermit ? (
        // Onboarding gate: login → permit → create. The PermitManager is the
        // only deliberate step between authenticated wallet and creator UI.
        // After authorize() succeeds, usePermit refreshes and this branch flips
        // to the creator UI on the next render.
        <PermitManager
          permitState={permitState}
          authorize={authorize}
          revoke={revoke}
          loading={permitLoading}
          error={permitError}
          reason={reason}
        />
      ) : (
        <>
          {/* Create-new — unified with /seller/onboard (PRD-17 §1). The studio
              listing below shows every agent the connected wallet owns, fed
              by both `listMyAgents` (v1 brains) and the seller dashboard
              (v2 marketplace listings). */}
          <section className="rounded-xl border border-dashed border-outline-variant/30 bg-surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-headline text-lg font-semibold">Create a new agent</h2>
                <p className="text-sm text-on-surface-variant">
                  One human, many agents. Privacy auto-detects from your connected wallet.
                </p>
              </div>
              <Link
                href="/seller/onboard?return=/studio"
                className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-on-primary hover:opacity-90"
              >
                Open the publish wizard →
              </Link>
            </div>
          </section>

      {/* Agent list */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-headline text-lg font-semibold">My agents ({agents.length})</h2>
          {status && <span className="text-xs text-on-surface-variant">{status}</span>}
        </div>

        {loading ? (
          <div className="py-12 text-center text-on-surface-variant">Loading…</div>
        ) : agents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-10 text-center">
            <p className="text-on-surface-variant">You haven&apos;t created an agent yet.</p>
            <p className="mt-2 text-xs text-on-surface-variant">
              Use the form above to create your first one.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {agents.map((a) => (
              <div
                key={a.id}
                className="encryption-glow flex items-center justify-between gap-3 rounded-xl border border-outline-variant/30 bg-surface p-4"
              >
                <Link href={`/studio/${a.id}`} className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary">smart_toy</span>
                    <div className="min-w-0">
                      <div className="truncate font-headline font-semibold">{a.title}</div>
                      <div className="font-mono text-[11px] text-on-surface-variant">
                        {a.published ? '✓ Published' : '🔒 Private draft'}
                      </div>
                    </div>
                  </div>
                </Link>
                {a.slug && (
                  <Link
                    href={`/agent/${a.id}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Open public bundle page (what AI buyers see)"
                    className="rounded-full border border-secondary/30 bg-secondary/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-secondary transition-colors hover:bg-secondary/20"
                  >
                    public ↗
                  </Link>
                )}
                <label className="cursor-pointer rounded-full border border-outline-variant/40 px-3 py-1.5 text-xs text-on-surface-variant transition-colors hover:border-primary/40 hover:text-primary">
                  Upload
                  <input
                    type="file"
                    accept=".txt,.md,.csv"
                    onChange={(e) => handleUpload(e, a.id)}
                    className="hidden"
                  />
                </label>
              </div>
            ))}
          </div>
        )}
      </section>
        </>
      )}
    </div>
  );
}

// ─── EarningsTile ──────────────────────────────────────────────────────────
//
// SRP: surfaces real settled USDC + paid_calls totals from /brains/earnings/.
// Co-located here because it's the only page that uses it; promote to its
// own file if a second consumer appears.

interface EarningsData {
  settledTotalUsdc?: number;
  settledCallCount?: number;
  paidCalls?: Array<{
    slug: string;
    amountUsdc: string;
    txHash: string;
    explorerUrl: string;
    method: string;
    at: string;
  }>;
}

function EarningsTile({ userAddress, agents }: { userAddress: `0x${string}` | undefined; agents: Agent[] }) {
  const [data, setData] = useState<EarningsData | null>(null);
  useEffect(() => {
    if (!userAddress) return;
    let cancelled = false;
    const load = () =>
      fetch(`${AGENT_BACKEND_URL}/brains/earnings/${userAddress}`, {
        headers: { 'x-wallet-address': userAddress },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => !cancelled && setData(d))
        .catch(() => {/* silent */});
    load();
    const t = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [userAddress]);

  if (!data || (data.settledCallCount ?? 0) === 0) return null;

  // Map slug → brainId so receipt rows can deep-link into /agent/[id] (the
  // canonical bundle page). Falls back to a non-link span when no match.
  const slugToBrainId = new Map<string, number>();
  for (const a of agents) if (a.slug) slugToBrainId.set(a.slug, a.id);

  return (
    <section className="grid gap-3 md:grid-cols-2">
      <div className="rounded-xl border border-secondary/30 bg-secondary/5 p-5">
        <div className="text-xs uppercase tracking-wider text-on-surface-variant">Settled (24 h)</div>
        <div className="mt-1 font-headline text-3xl font-bold">
          ${(data.settledTotalUsdc ?? 0).toFixed(4)}
          <span className="ml-2 font-mono text-xs text-on-surface-variant">USDC</span>
        </div>
        <div className="mt-1 text-xs text-on-surface-variant">{data.settledCallCount} paid calls</div>
      </div>
      <div className="rounded-xl border border-outline-variant/30 bg-surface p-5">
        <div className="text-xs uppercase tracking-wider text-on-surface-variant">Latest receipts</div>
        <ul className="mt-2 space-y-1.5">
          {(data.paidCalls ?? []).slice(0, 3).map((p) => {
            const brainId = slugToBrainId.get(p.slug);
            return (
              <li key={p.txHash} className="flex items-center justify-between text-xs">
                {brainId !== undefined ? (
                  <Link href={`/agent/${brainId}`} className="font-mono hover:text-primary">
                    /{p.slug}
                  </Link>
                ) : (
                  <span className="font-mono">/{p.slug}</span>
                )}
                <span className="font-mono">${p.amountUsdc}</span>
                <a href={p.explorerUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  tx ↗
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
