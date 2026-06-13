'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { usePrivy } from '@privy-io/react-auth';
import { listMyAgents, type Agent } from '@/lib/agents';
import { usePermit } from '@/hooks/usePermit';
import { PermitManager } from '@/components/PermitManager';
import { AGENT_BACKEND_URL } from '@/lib/contracts';
import { useActiveWallet } from '@/hooks/useActiveWallet';
import { BuyerPortfolio, SellerHiresPanel } from '@/components/arbloop';

/**
 * Studio page — wraps the inner component in <Suspense> so Next.js can
 * statically generate the route. `useSearchParams()` requires a Suspense
 * boundary at the route level (next 14+ CSR bailout rule). Same convention
 * as /arbloop/compose and /arbloop/seller/onboard.
 *
 * SOLID: single-responsibility wrapper; all state + render lives in StudioInner.
 */
export default function StudioPage() {
  return (
    <Suspense fallback={<p className="py-12 text-center text-on-surface-variant">Loading…</p>}>
      <StudioInner />
    </Suspense>
  );
}

function StudioInner() {
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

  // ─── Role tabs ──────────────────────────────────────────────────────
  // URL is the source of truth (?role=buyer|seller). On first paint we
  // honour an explicit URL choice; otherwise we fall back to seller and,
  // once the agent list has loaded, switch to buyer for empty-list wallets.
  // The URL is kept in sync via router.replace (no scroll) so the tab is
  // bookmarkable and back-button-friendly.
  const search = useSearchParams();
  const router = useRouter();
  const urlRole = search.get('role');
  const [role, setRole] = useState<'buyer' | 'seller'>(
    urlRole === 'buyer' || urlRole === 'seller' ? urlRole : 'seller',
  );
  const decidedDefault = useRef(false);
  useEffect(() => {
    if (urlRole) return;
    if (decidedDefault.current || loading) return;
    decidedDefault.current = true;
    if (agents.length === 0 && userAddress) setRole('buyer');
  }, [loading, agents.length, urlRole, userAddress]);
  useEffect(() => {
    if (urlRole === role) return;
    const sp = new URLSearchParams(search.toString());
    sp.set('role', role);
    router.replace(`/studio?${sp.toString()}`, { scroll: false });
  }, [role, urlRole, router, search]);

  useEffect(() => {
    if (!userAddress) return;
    setLoading(true);
    // Defensive joined view (PRD-17 §1c): show every agent the connected
    // wallet owns — v1 brains (via listMyAgents → /brains/mine), v2
    // marketplace listings (via /v3/marketplace/seller/dashboard), AND
    // v0.0 loop agents (via /v3/arbloop/agents, filtered by seller_address).
    // Three keyspaces are unioned without schema migration.
    Promise.all([
      listMyAgents(userAddress),
      fetch(`${AGENT_BACKEND_URL}/v3/marketplace/seller/dashboard`, {
        headers: { 'x-wallet-address': userAddress },
      })
        .then((r) => (r.ok ? r.json() : { agents: [] }))
        .catch(() => ({ agents: [] })),
      fetch(`${AGENT_BACKEND_URL}/v3/arbloop/agents?limit=200`)
        .then((r) => (r.ok ? r.json() : { agents: [] }))
        .catch(() => ({ agents: [] })),
    ])
      .then(([brainAgents, dash, loop]) => {
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

        // Fold v0.0 loop agents into the same list. Filter by seller_address
        // (case-insensitive). Synthetic id keeps brain-id and loop-id separate
        // so React keys don't collide. _kind:'loop' drives row CTA selection.
        const loopRows = ((loop?.agents ?? []) as Array<{
          agent_id: number; agent_registry_address: string; agent_registry_version?: number;
          seller_address: string; title: string; short_description: string | null;
          tags: string[] | null; mode: string | null; revoked: boolean;
        }>)
          .filter((l) => !l.revoked && l.seller_address?.toLowerCase() === userAddress.toLowerCase())
          .map((l) => ({
            id: `loop-${l.agent_id}` as unknown as number,
            title: l.title,
            description: l.short_description ?? '',
            slug: null,
            published: true,
            tags: l.tags ?? [],
            ownerAddress: l.seller_address,
            _kind: 'loop',
            _loopAgentId: l.agent_id,
            _loopMode: l.mode ?? 'x402',
          }) as unknown as Agent);

        setAgents([...loopRows, ...merged]);
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
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <h1 className="font-headline text-3xl font-bold">Studio</h1>
          <p className="text-on-surface-variant">
            {role === 'buyer'
              ? 'Track every loop you have hired. Pause, resume, cancel, or send a change request.'
              : 'Train, manage, and publish your encrypted AI agents.'}
          </p>
        </div>
        {role === 'seller' && (
          <Link
            href="/arbloop/seller/onboard?return=/studio"
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-on-primary hover:opacity-90"
            style={{ minHeight: 44 }}
          >
            <span className="material-symbols-outlined text-[18px]">rocket_launch</span>
            + New agent
          </Link>
        )}
      </header>

      <nav
        role="tablist"
        aria-label="Studio role"
        data-test="studio-tabs"
        className="sticky top-0 z-10 flex gap-2 border-b border-outline-variant/20 bg-background/95 py-2 backdrop-blur"
      >
        {(['buyer', 'seller'] as const).map((r) => (
          <button
            key={r}
            role="tab"
            aria-selected={role === r}
            data-test={`studio-tab-${r}`}
            onClick={() => setRole(r)}
            className={`flex-1 rounded-full px-4 py-2 text-sm font-medium transition-colors sm:flex-initial ${
              role === r
                ? 'bg-primary/15 text-primary'
                : 'text-on-surface-variant hover:bg-surface-container-low'
            }`}
            style={{ minHeight: 44 }}
          >
            {r === 'buyer' ? 'My loops' : 'My agents'}
          </button>
        ))}
      </nav>

      {role === 'buyer' ? (
        <BuyerPortfolio buyerAddress={userAddress} />
      ) : (
        <>
      <EarningsTile userAddress={userAddress} agents={agents} />

      <SellerHiresPanel sellerAddress={userAddress} />

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
          {/* Create-new — unified entry to BOTH agent kinds. v0.0 primary
              path is the loop-agent wizard at /arbloop/seller/onboard
              (gasless EIP-712 publish to AgentRegistryV2, mode-A or mode-B).
              The legacy brain wizard at /seller/onboard remains for
              knowledge-Q&A use cases — same `?return=/studio` contract. */}
          <section className="rounded-xl border border-dashed border-outline-variant/30 bg-surface p-5">
            <div className="space-y-1">
              <h2 className="font-headline text-lg font-semibold">Create a new agent</h2>
              <p className="text-sm text-on-surface-variant">
                Pick the shape that matches what your agent does. You can upgrade a brain to a loop later.
              </p>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <Link
                href="/arbloop/seller/onboard?return=/studio"
                className="group rounded-xl border border-primary/30 bg-primary/5 p-4 transition-colors hover:border-primary/60"
              >
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary">all_inclusive</span>
                  <span className="font-headline text-base font-semibold">Loop agent</span>
                  <span className="ml-auto rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">v0.0</span>
                </div>
                <p className="mt-2 text-xs text-on-surface-variant">
                  Sells <strong>jobs</strong>: persona + iteration count + budget. Buyers hire and pay
                  USDC per task or per iter (70% to you). Sign once, $0 gas.
                </p>
              </Link>
              <Link
                href="/seller/onboard?return=/studio"
                className="group rounded-xl border border-outline-variant/30 bg-surface p-4 transition-colors hover:border-secondary/40"
              >
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-secondary">psychology</span>
                  <span className="font-headline text-base font-semibold">Knowledge brain</span>
                  <span className="ml-auto rounded-full border border-outline-variant/40 px-2 py-0.5 font-mono text-[10px] text-on-surface-variant">classic</span>
                </div>
                <p className="mt-2 text-xs text-on-surface-variant">
                  Sells <strong>answers</strong>: encrypted knowledge base, paid per query via x402.
                  Best for static reference data your agent should ground its replies in.
                </p>
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
            {agents.map((a) => {
              const aa = a as unknown as Agent & { _kind?: string; _loopAgentId?: number; _loopMode?: string };
              const isLoop = aa._kind === 'loop';
              const detailHref = isLoop ? `/arbloop/agent/${aa._loopAgentId}` : `/studio/${a.id}`;
              return (
              <div
                key={String(a.id)}
                className="encryption-glow flex items-center justify-between gap-3 rounded-xl border border-outline-variant/30 bg-surface p-4"
              >
                <Link href={detailHref} className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary">
                      {isLoop ? 'all_inclusive' : 'smart_toy'}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="truncate font-headline font-semibold">{a.title}</div>
                        {isLoop && (
                          <span className="rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary">
                            loop · {aa._loopMode}
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-[11px] text-on-surface-variant">
                        {a.published ? '✓ Published' : '🔒 Private draft'}
                      </div>
                    </div>
                  </div>
                </Link>
                {!isLoop && a.slug && (
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
                {!isLoop && (
                  <Link
                    href={`/arbloop/seller/onboard?return=/studio&from_brain=${a.id}&title=${encodeURIComponent(a.title ?? '')}&description=${encodeURIComponent(a.description ?? '')}`}
                    title="Re-publish this agent as a loop — sells jobs (with iterations + budget), not just answers"
                    className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-primary transition-colors hover:bg-primary/20"
                  >
                    ↻ upgrade to loop
                  </Link>
                )}
                {!isLoop && (
                  <label className="cursor-pointer rounded-full border border-outline-variant/40 px-3 py-1.5 text-xs text-on-surface-variant transition-colors hover:border-primary/40 hover:text-primary">
                    Upload
                    <input
                      type="file"
                      accept=".txt,.md,.csv"
                      onChange={(e) => handleUpload(e, a.id as unknown as number)}
                      className="hidden"
                    />
                  </label>
                )}
                {isLoop && (
                  <Link
                    href={`/arbloop/agent/${aa._loopAgentId}`}
                    className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-primary transition-colors hover:bg-primary/20"
                  >
                    open ↗
                  </Link>
                )}
              </div>
              );
            })}
          </div>
        )}
      </section>
        </>
      )}
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
