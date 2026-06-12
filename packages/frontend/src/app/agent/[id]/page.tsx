'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AGENT_BACKEND_URL } from '@/lib/contracts';
import {
  getAgent,
  getAgentCognitiveSnapshot,
  type Agent,
  type AgentCognitiveSnapshot,
} from '@/lib/agents';

/**
 * /agent/[id] — public brain detail page.
 *
 * When the agent is published as a paid x402 API (`agent.slug` set), the page
 * leads with a buyer-first integration hero (Make a Call · Agent Prompt ·
 * agent.json · Try-it · Quickstart sidebar · FAQ). Cognitive snapshot,
 * skills, attestations, and the encryption-verify block move below the hero.
 *
 * When the agent is a draft brain (no slug), the page falls back to the
 * pre-publish view: header + cognitive snapshot + verify, with a chat-only
 * sidebar. This preserves the existing UX for non-published brains.
 *
 * Per PRD-0, PRD-1 (T7), PRD-2 (T4), PRD-3 (T2). One file, four inline
 * subcomponents — kept here because they're page-local and SRP doesn't
 * demand extraction (matches the project's "single file by deliberate
 * choice" pattern from PublishWizard).
 */

// ─── shape of /.well-known/agent.json (subset we render) ───────────────────
interface AgentJson {
  name: string;
  description: string;
  url: string;
  payTo: string;
  chain: string;
  asset: string;
  tools: Array<{ name: string; price: number; currency: string }>;
  system_prompt?: string | null;
}

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [agent, setAgent] = useState<Agent | null>(null);
  const [snap, setSnap] = useState<AgentCognitiveSnapshot | null>(null);
  const [agentJson, setAgentJson] = useState<AgentJson | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([getAgent(id), getAgentCognitiveSnapshot(id)])
      .then(([a, s]) => {
        setAgent(a);
        setSnap(s);
      })
      .finally(() => setLoading(false));
  }, [id]);

  // Fetch the canonical agent.json once we know the slug. Server caches it
  // for 60s (Cache-Control: public, max-age=60), so no in-page caching needed.
  useEffect(() => {
    if (!agent?.slug) return;
    fetch(`${AGENT_BACKEND_URL}/api/v1/${agent.slug}/.well-known/agent.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setAgentJson)
      .catch(() => setAgentJson(null));
  }, [agent?.slug]);

  if (loading) {
    return <div className="py-20 text-center text-on-surface-variant">Loading agent…</div>;
  }
  if (!agent) {
    return (
      <div className="py-20 text-center">
        <p className="text-on-surface-variant">Agent not found.</p>
        <Link href="/marketplace" className="mt-3 inline-block text-sm text-primary hover:underline">
          ← Back to marketplace
        </Link>
      </div>
    );
  }

  const isPublished = !!agent.slug;
  const hasCognition = !!snap && (snap.episodes > 0 || snap.facts > 0 || snap.skills > 0);
  const lastSeen = snap?.lastQueryAt ? relativeTime(snap.lastQueryAt) : null;

  return (
    <div className="grid gap-6 md:grid-cols-3">
      {/* Main column */}
      <div className="min-w-0 space-y-6 md:col-span-2">
        {/* Slim header — kept for both states; published gets the "Live API" badge */}
        <div className="rounded-xl border border-outline-variant/30 bg-surface p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <span className="material-symbols-outlined text-[28px]">smart_toy</span>
            </div>
            <div className="flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-headline text-2xl font-bold">{agent.title}</h1>
                {isPublished && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-secondary/30 bg-secondary/10 px-2 py-0.5 font-mono text-[10px] text-secondary">
                    <span className="material-symbols-outlined text-[12px]">public</span>
                    LIVE API
                  </span>
                )}
                {hasCognition && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-secondary/30 bg-secondary/10 px-2 py-0.5 font-mono text-[10px] text-secondary">
                    <span className="relative flex h-1.5 w-1.5 rounded-full bg-secondary">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-secondary opacity-75" />
                    </span>
                    active{lastSeen ? ` · ${lastSeen}` : ''}
                  </span>
                )}
              </div>
              <p className="font-mono text-xs text-on-surface-variant">
                Owner {agent.ownerAddress.slice(0, 8)}…{agent.ownerAddress.slice(-4)}
              </p>
              {snap?.fhenixVaultAddress && (
                <p className="font-mono text-[10px] text-on-surface-variant">
                  Fhenix vault{' '}
                  <code className="rounded bg-surface-container px-1.5 py-0.5 text-on-surface">
                    {snap.fhenixVaultAddress.slice(0, 10)}…{snap.fhenixVaultAddress.slice(-6)}
                  </code>
                </p>
              )}
            </div>
          </div>
          <p className="mt-6 text-on-surface-variant">{agent.description}</p>
          {agent.tags.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {agent.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-outline-variant/40 px-2 py-0.5 font-mono text-xs text-on-surface-variant"
                >
                  #{t}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* PRD-0 hero: visible for both published and draft agents.
            For drafts the slug is a placeholder, the curl-copy CTA swaps to
            "Run the publish wizard", and the agent.json viewer is hidden.
            See PaidApiHero({isDraft}) for the draft-aware rendering. */}
        <PaidApiHero agent={agent} agentJson={agentJson} isDraft={!isPublished} />

        {/* PRD-2: free, rate-limited try-it — only when the API is live */}
        {isPublished && <TryIt agent={agent} />}

        {/* Knowledge Snapshot — appears only when there's data */}
        {hasCognition && snap && (
          <div className="space-y-4 rounded-xl border border-outline-variant/30 bg-surface p-6">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-secondary">psychology</span>
              <h2 className="font-headline text-lg font-semibold">Knowledge snapshot</h2>
            </div>
            <dl className="grid grid-cols-3 gap-3">
              <SnapStat label="episodes" value={snap.episodes} />
              <SnapStat label="facts" value={snap.facts} />
              <SnapStat label="skills" value={snap.skills} />
            </dl>
            {snap.topics.length > 0 && (
              <div className="space-y-2">
                <div className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                  top topics
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {snap.topics.map((t) => (
                    <span
                      key={t.key}
                      className="inline-flex items-center gap-1 rounded-full border border-outline-variant/40 px-2 py-0.5 font-mono text-[11px]"
                    >
                      <span className="text-on-surface">{t.key}</span>
                      <span className="text-on-surface-variant">×{t.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <ActivitySparkline data={snap.activity14d} />
          </div>
        )}

        {/* Skills — only if any are minted */}
        {snap && snap.recentSkills.length > 0 && (
          <div className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-6">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">bolt</span>
              <h2 className="font-headline text-lg font-semibold">Skills available</h2>
            </div>
            {snap.recentSkills.map((s) => (
              <div
                key={s.id}
                className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <code className="font-mono text-sm text-on-surface">{s.procedureKey}</code>
                  <span className="font-mono text-[10px] text-on-surface-variant">
                    {s.runCount} runs
                  </span>
                </div>
                <div className="mt-1 inline-flex items-center gap-1 rounded-full border border-outline-variant/40 bg-surface px-2 py-1 text-[10px]">
                  <span className="text-on-surface-variant">now:</span>
                  <span className="font-mono text-secondary">free</span>
                  <span className="text-on-surface-variant">·</span>
                  <span className="text-on-surface-variant">target:</span>
                  <span className="font-mono text-primary">{s.defaultPriceUsdc} USDC/run</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Attestation Feed — only if any runs happened */}
        {snap && snap.recentAttestations.length > 0 && (
          <div className="space-y-2 rounded-xl border border-outline-variant/30 bg-surface p-6">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-secondary">shield</span>
              <h2 className="font-headline text-lg font-semibold">Recent attestations</h2>
            </div>
            <ul className="grid gap-1 font-mono text-[11px]">
              {snap.recentAttestations.map((a) => (
                <li
                  key={a.runId}
                  className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-surface-container-low"
                >
                  <span>▶ run #{a.runId}</span>
                  <code className="text-on-surface-variant">{a.attestation.slice(0, 16)}…</code>
                  <span className="text-on-surface-variant">{relativeTime(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* PRD-3: FAQ — only when the API is live */}
        {isPublished && <AgentFAQ agent={agent} agentJson={agentJson} />}

        {/* Independent Verify — always renders, gives skeptics a copy-button */}
        <div className="space-y-2 rounded-xl border border-outline-variant/30 bg-surface-container-low p-6">
          <div className="flex items-center gap-2 text-on-surface-variant">
            <span className="material-symbols-outlined text-[18px] text-primary">lock</span>
            <span className="font-mono text-xs uppercase tracking-wider">independent verify</span>
          </div>
          <p className="text-sm text-on-surface-variant">
            This brain&apos;s knowledge is AES-256-GCM encrypted at rest; per-(owner, layer) keys
            are derived independently. No OpenX server can read raw L1 episodes, L2 facts, or L3
            skill manifests for any user other than the wallet that owns them.
          </p>
          <details className="text-xs">
            <summary className="cursor-pointer font-mono text-on-surface-variant hover:text-on-surface">
              Verify counts via SQL (no OpenX server in trust path)
            </summary>
            <pre className="mt-2 overflow-auto rounded bg-surface px-3 py-2 text-[10px]">
              {`SELECT
  (SELECT COUNT(*) FROM cognitive_episodes WHERE owner_addr = '${agent.ownerAddress.toLowerCase()}') AS episodes,
  (SELECT COUNT(*) FROM cognitive_facts    WHERE owner_addr = '${agent.ownerAddress.toLowerCase()}') AS facts,
  (SELECT COUNT(*) FROM cognitive_skills   WHERE owner_addr = '${agent.ownerAddress.toLowerCase()}') AS skills;`}
            </pre>
          </details>
        </div>

        {!hasCognition && (
          <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-6 text-center">
            <span className="mb-2 block text-3xl">🌱</span>
            <p className="font-headline font-semibold">New brain — no cognitive activity yet.</p>
            <p className="mt-1 text-xs text-on-surface-variant">
              When agents start querying this brain, episodes appear here automatically.
            </p>
          </div>
        )}
      </div>

      {/* Sidebar — Quickstart when published, original pricing card when draft */}
      <aside className="min-w-0">
        <div className="sticky top-24 space-y-4">
          {isPublished ? (
            <Quickstart agent={agent} agentJson={agentJson} />
          ) : (
            <DraftSidebar agent={agent} snap={snap} />
          )}
        </div>
      </aside>
    </div>
  );
}

// ─── PRD-0: PaidApiHero ────────────────────────────────────────────────────
//
// Four stacked cards that resolve "how do I use this API" in one screen:
//   1. Make a Call — copy-pasteable curl + sample response (publish CTA in draft)
//   2. Agent Prompt — pasteable system prompt for the buyer's LLM (PRD-1 T7)
//   3. Bundle snippet — JSON another agent can drop into its bundle manifest
//   4. agent.json viewer — full discovery JSON (collapsible; published only)
//
// `isDraft` adapts every block: slug becomes a placeholder, the curl-copy
// button swaps for a "Run the publish wizard" link, the live agent.json
// viewer is hidden (it would 404 without a real slug). Same component for
// both states — no duplicate "DraftPreview" sibling (I1 + I3).

function PaidApiHero({
  agent,
  agentJson,
  isDraft = false,
}: {
  agent: Agent;
  agentJson: AgentJson | null;
  isDraft?: boolean;
}) {
  const apiBase = AGENT_BACKEND_URL;
  const slug = agent.slug ?? 'your-slug';
  const url = `${apiBase}/api/v1/${slug}`;
  const curl = `curl '${url}?q=YOUR_QUESTION_HERE'`;
  const sampleResp = JSON.stringify(
    { answer: 'string', citations: [0, 1, 2], settled: { method: 'exact' } },
    null,
    2,
  );

  // PRD-1 T7: prefer the seller's saved prompt; fall back to an auto-generated
  // default derived from the agent's metadata. Works without a slug.
  const promptBody =
    agent.persona?.system_prompt?.trim() ||
    autoGeneratePrompt(agent, url);

  // Bundle-manifest snippet — copy-paste-able JSON another agent can drop into
  // its own bundle to invoke this agent as one step. Shape mirrors
  // packages/api/src/services/bundleService.ts manifest.steps[i].
  const bundleSnippet = JSON.stringify(
    {
      tool: 'ask',
      agent_url: url,
      price_usdc: agent.price?.amount ?? '0.01',
      args: { question: '{{user_input}}' },
      ...(agent.acceptsPrivate ? { confidential: true } : {}),
    },
    null,
    2,
  );

  return (
    <div className="space-y-4">
      {/* 1. Make a call — curl + 402 explainer + sample response */}
      <div className="space-y-3 rounded-xl border border-primary/30 bg-surface p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="font-headline text-base font-semibold">Make a call</h2>
            {isDraft && (
              <span className="rounded-full border border-tertiary/30 bg-tertiary/10 px-2 py-0.5 font-mono text-[9px] uppercase text-tertiary">
                draft — publish to activate
              </span>
            )}
          </div>
          {isDraft ? (
            <Link
              href="/studio/publish"
              className="rounded-full bg-primary px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-on-primary hover:opacity-90"
            >
              Run publish wizard
            </Link>
          ) : (
            <CopyButton value={curl} label="Copy curl" />
          )}
        </div>
        <pre className="overflow-x-auto rounded-lg bg-surface-container-low p-3 font-mono text-[12px] leading-relaxed">
          <code>{curl}</code>
        </pre>
        <div className="text-xs text-on-surface-variant">
          {isDraft ? (
            <>
              Once published, this URL serves <code>402 Payment Required</code> on the first call —
              the n-payment SDK settles via x402 and retries with the receipt. After 200, response
              shape:
            </>
          ) : (
            <>
              Returns <code>402 Payment Required</code> on the first call — the n-payment SDK settles
              via x402 and retries with the receipt. After 200, response shape:
            </>
          )}
        </div>
        <pre className="overflow-x-auto rounded-lg bg-surface-container-low p-3 font-mono text-[11px] text-on-surface-variant">
          <code>{sampleResp}</code>
        </pre>
      </div>

      {/* 2. Agent prompt — works for both states */}
      <div className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-headline text-base font-semibold">Agent prompt</h2>
          <CopyButton value={promptBody} label="Copy" />
        </div>
        <p className="text-xs text-on-surface-variant">
          Paste this into Claude / ChatGPT to give the agent the context it needs to call your API.
        </p>
        <pre className="overflow-auto whitespace-pre-wrap rounded-lg bg-surface-container-low p-3 font-mono text-[12px] leading-relaxed">
          {promptBody}
        </pre>
      </div>

      {/* 3. Bundle snippet — for use inside another agent's bundle manifest */}
      <div className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="font-headline text-base font-semibold">Bundle snippet</h2>
            <span className="rounded-full border border-secondary/30 bg-secondary/10 px-2 py-0.5 font-mono text-[9px] uppercase text-secondary">
              for your agent
            </span>
          </div>
          <CopyButton value={bundleSnippet} label="Copy JSON" />
        </div>
        <p className="text-xs text-on-surface-variant">
          Drop this step into your own bundle manifest to invoke this agent as part of an
          autonomous workflow. The buyer&apos;s runner pays per call automatically.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-surface-container-low p-3 font-mono text-[12px] leading-relaxed">
          <code>{bundleSnippet}</code>
        </pre>
      </div>

      {/* 4. agent.json viewer — published only (draft would 404) */}
      {!isDraft && (
        <details className="group rounded-xl border border-outline-variant/30 bg-surface p-5">
          <summary className="flex cursor-pointer items-center justify-between font-headline text-base font-semibold">
            <span>agent.json (auto-discovery)</span>
            <span className="font-mono text-[10px] text-on-surface-variant group-open:hidden">expand →</span>
            <span className="hidden font-mono text-[10px] text-on-surface-variant group-open:inline">collapse ↓</span>
          </summary>
          <p className="mt-2 text-xs text-on-surface-variant">
            AI agents auto-fetch this URL to learn what the API does, how to pay, and where to send funds.
          </p>
          <a
            href={`${url}/.well-known/agent.json`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block break-all font-mono text-[11px] text-primary hover:underline"
          >
            {url}/.well-known/agent.json ↗
          </a>
          <pre className="mt-3 overflow-auto rounded-lg bg-surface-container-low p-3 font-mono text-[11px]">
            <code>{agentJson ? JSON.stringify(agentJson, null, 2) : 'Loading…'}</code>
          </pre>
        </details>
      )}
    </div>
  );
}

// ─── PRD-2: TryIt widget ───────────────────────────────────────────────────
//
// Free, rate-limited demo invocation. Posts to /v3/agents/:id/try; renders
// the answer + citations + a "DEMO" chip. On 429, shows a countdown.

function TryIt({ agent }: { agent: Agent }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<{ answer: string; citations: number[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retryAfterSec, setRetryAfterSec] = useState<number | null>(null);

  if (!agent.v3AgentId) return null;

  async function send() {
    if (!q.trim() || busy) return;
    setBusy(true);
    setErr(null);
    setResp(null);
    setRetryAfterSec(null);
    try {
      const r = await fetch(`${AGENT_BACKEND_URL}/v3/agents/${agent.v3AgentId}/try`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: q.trim() }),
      });
      if (r.status === 429) {
        const body = await r.json().catch(() => ({}));
        setRetryAfterSec(Number(body.retryAfterSec ?? 0));
        setErr(body.error ?? 'rate limited — try again later');
        return;
      }
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `${r.status}`);
      }
      const data = await r.json();
      setResp({ answer: data.answer, citations: data.citations ?? [] });
    } catch (e: any) {
      setErr(e?.message ?? 'request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-tertiary/30 bg-tertiary/5 p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-headline text-base font-semibold">Try it</h2>
        <span className="rounded-full border border-tertiary/30 bg-tertiary/10 px-2 py-0.5 font-mono text-[9px] uppercase text-tertiary">
          free demo · rate limited
        </span>
      </div>
      <textarea
        value={q}
        onChange={(e) => setQ(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Ask anything this brain might know…"
        className="w-full rounded-2xl border border-outline-variant/40 bg-surface px-4 py-2.5 text-sm focus:border-primary/60 focus:outline-none"
      />
      <div className="flex items-center justify-end gap-2">
        <span className="font-mono text-[10px] text-on-surface-variant">{q.length} / 2000</span>
        <button
          onClick={send}
          disabled={busy || !q.trim()}
          className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
        >
          {busy ? 'Asking…' : 'Try'}
        </button>
      </div>
      {err && (
        <div className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
          {err}
          {retryAfterSec && retryAfterSec > 0 && (
            <span className="ml-2 font-mono">retry in ~{formatRetry(retryAfterSec)}</span>
          )}
        </div>
      )}
      {resp && (
        <div className="space-y-2 rounded-lg border border-secondary/30 bg-surface p-3">
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-tertiary/30 bg-tertiary/10 px-2 py-0.5 font-mono text-[9px] uppercase text-tertiary">
              demo
            </span>
            <span className="font-mono text-[10px] text-on-surface-variant">
              cited chunks: [{resp.citations.join(', ')}]
            </span>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap font-sans text-sm">{resp.answer}</pre>
        </div>
      )}
    </div>
  );
}

// ─── PRD-3: AgentFAQ ───────────────────────────────────────────────────────
//
// Six standard buyer questions, parameterized from live agent data. Pure
// HTML/CSS via <details>; keyboard- and screen-reader-accessible without
// any ARIA library.

function AgentFAQ({ agent, agentJson }: { agent: Agent; agentJson: AgentJson | null }) {
  const FAQ: Array<{ q: string; a: ReactNode }> = useMemo(() => {
    const chain = agentJson?.chain ?? 'arbitrum-sepolia';
    const asset = agentJson?.asset;
    const price = agent.price?.amount ?? '0.01';
    const currency = agent.price?.currency ?? 'USDC';
    return [
      {
        q: 'Does this brain require an API key?',
        a: (
          <>
            No. Authentication is the payment receipt: send{' '}
            <code className="font-mono text-on-surface">X-Payment: &lt;x402 receipt&gt;</code>.
          </>
        ),
      },
      {
        q: 'How does payment work?',
        a: (
          <>
            x402 on <code className="font-mono">{chain}</code>, asset{' '}
            {asset ? <code className="font-mono">{asset.slice(0, 10)}…</code> : 'USDC'}. The first
            request returns 402 with a <code className="font-mono">WWW-Authenticate</code> header.
            Pay via any x402 facilitator (default <code className="font-mono">facilitator.x402.rs</code>) and
            retry with the receipt — the n-payment SDK does this for you.
          </>
        ),
      },
      {
        q: 'What if my wallet is unfunded?',
        a: (
          <>
            The facilitator returns 402 again with{' '}
            <code className="font-mono">error="insufficient_balance"</code>. Top up USDC (Circle
            faucet on testnet) and retry — no state change on our side.
          </>
        ),
      },
      {
        q: 'What if the brain returns an error?',
        a: (
          <>
            Non-2xx, non-402 responses do <strong>not</strong> consume payment. Receipts settle
            only on 2xx so retries are safe.
          </>
        ),
      },
      {
        q: 'How deterministic is the answer?',
        a: (
          <>
            Inference runs in a Phala TEE; an attestation hash is returned in{' '}
            <code className="font-mono">settled.attestation</code>. Responses are not deterministic
            across calls; citations index a stable ranked-chunk set per (brain, query) pair.
          </>
        ),
      },
      {
        q: 'What if the price changes?',
        a: (
          <>
            Always trust the live 402 response. Prices in{' '}
            <code className="font-mono">.well-known/agent.json</code> may be ≤60s stale (the
            response sets <code className="font-mono">Cache-Control: max-age=60</code>). Today:{' '}
            <strong>
              ${price} {currency}
            </strong>
            /call.
          </>
        ),
      },
    ];
  }, [agent.price, agentJson]);

  return (
    <div className="space-y-2 rounded-xl border border-outline-variant/30 bg-surface p-5">
      <h2 className="font-headline text-base font-semibold">Questions agents ask</h2>
      <div className="divide-y divide-outline-variant/20">
        {FAQ.map((entry, i) => (
          <details key={i} className="group py-2">
            <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm hover:text-primary">
              <span>{entry.q}</span>
              <span className="font-mono text-[10px] text-on-surface-variant group-open:hidden">+</span>
              <span className="hidden font-mono text-[10px] text-on-surface-variant group-open:inline">−</span>
            </summary>
            <div className="mt-2 text-sm leading-relaxed text-on-surface-variant">{entry.a}</div>
          </details>
        ))}
      </div>
    </div>
  );
}

// ─── Quickstart sidebar (published) ────────────────────────────────────────

function Quickstart({ agent, agentJson }: { agent: Agent; agentJson: AgentJson | null }) {
  const price = agent.price?.amount ?? '0.01';
  const currency = agent.price?.currency ?? 'USDC';
  const chain = agentJson?.chain ?? 'arbitrum-sepolia';
  const payTo = agent.ownerAddress;
  const url = `${AGENT_BACKEND_URL}/api/v1/${agent.slug}`;
  const curl = `curl '${url}?q=hello'`;
  return (
    <div className="space-y-4 rounded-xl border border-primary/30 bg-surface p-6">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          price per call
        </div>
        <div className="mt-1 font-headline text-2xl font-bold">
          ${price}
          <span className="ml-1 font-mono text-xs font-normal text-on-surface-variant">
            {currency}
          </span>
        </div>
        {agent.acceptsPrivate && (
          <span className="mt-1 inline-block rounded-full border border-tertiary/30 bg-tertiary/10 px-2 py-0.5 font-mono text-[9px] text-tertiary">
            CONFIDENTIAL OK
          </span>
        )}
      </div>
      <div className="space-y-2 border-t border-outline-variant/20 pt-3 text-xs">
        <Row label="network" value={chain} mono />
        {agentJson?.asset && <Row label="asset" value={`${agentJson.asset.slice(0, 8)}…`} mono />}
        <Row label="pay to" value={`${payTo.slice(0, 6)}…${payTo.slice(-4)}`} mono />
      </div>
      <div className="space-y-2 border-t border-outline-variant/20 pt-3">
        <Link
          href={`/chat/${agent.id}`}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-primary py-2 text-sm font-medium text-on-primary"
        >
          <span className="material-symbols-outlined text-[16px]">chat</span>
          Ask or run a task
        </Link>
        <p className="text-center font-mono text-[10px] text-on-surface-variant">
          Attach a file in chat to give the agent task context
        </p>
        <CopyButton value={curl} label="Copy curl" full />
      </div>
    </div>
  );
}

function DraftSidebar({ agent, snap }: { agent: Agent; snap: AgentCognitiveSnapshot | null }) {
  return (
    <div className="space-y-4 rounded-xl border border-primary/30 bg-surface p-6">
      <div className="space-y-1">
        <div className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
          query pricing
        </div>
        <div className="flex items-center gap-2 text-2xl font-headline font-bold">
          <span className="text-secondary">free</span>
          <span className="font-mono text-xs font-normal text-on-surface-variant">draft</span>
        </div>
        <div className="text-xs text-on-surface-variant">
          Ask the agent a question or run a task with a file. Run the publish wizard to mint a paid x402 endpoint.
        </div>
      </div>
      <Link
        href={`/chat/${agent.id}`}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-primary py-3 font-medium text-on-primary transition-colors hover:bg-primary/90"
      >
        <span className="material-symbols-outlined text-[18px]">chat</span>
        Ask or run a task
      </Link>
      <p className="-mt-2 text-center font-mono text-[10px] text-on-surface-variant">
        Attach a file in chat for task context
      </p>
      <div className="space-y-2 border-t border-outline-variant/20 pt-4 text-xs text-on-surface-variant">
        <div className="flex items-center justify-between">
          <span>Episodes recorded</span>
          <span className="font-mono text-on-surface">{snap?.episodes ?? 0}</span>
        </div>
        <div className="flex items-center justify-between">
          <span>Facts derived</span>
          <span className="font-mono text-on-surface">{snap?.facts ?? 0}</span>
        </div>
        <div className="flex items-center justify-between">
          <span>Skills minted</span>
          <span className="font-mono text-on-surface">{snap?.skills ?? 0}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Tiny helpers ───────────────────────────────────────────────────────────

function CopyButton({ value, label, full }: { value: string; label: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {/* clipboard blocked */}
      }}
      className={`rounded-full border border-outline-variant/40 px-3 py-1 font-mono text-[10px] uppercase tracking-wider hover:border-primary/40 hover:text-primary ${
        full ? 'flex w-full items-center justify-center' : ''
      }`}
    >
      {copied ? '✓ copied' : label}
    </button>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-on-surface-variant">{label}</span>
      <span className={mono ? 'font-mono text-on-surface' : 'text-on-surface'}>{value}</span>
    </div>
  );
}

function SnapStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-3 text-center">
      <div className="font-headline text-2xl font-bold">{value}</div>
      <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        {label}
      </div>
    </div>
  );
}

function ActivitySparkline({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <div className="space-y-1">
      <div className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        14-day activity
      </div>
      <div className="flex h-8 items-end gap-0.5">
        {data.map((v, i) => (
          <div
            key={i}
            className="flex-1 rounded-sm bg-secondary/40 transition-all"
            style={{ height: `${(v / max) * 100}%`, minHeight: '2px' }}
            title={`${v} episode${v === 1 ? '' : 's'}, ${13 - i}d ago`}
          />
        ))}
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function formatRetry(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.ceil(sec / 60)}m`;
  return `${Math.ceil(sec / 3600)}h`;
}

function autoGeneratePrompt(agent: Agent, url: string): string {
  const tagsLine =
    agent.tags.length > 0
      ? `When the user asks about ${agent.tags.map((t) => `#${t}`).join(', ')}, call:\n`
      : `To use it, call:\n`;
  const priceLine = agent.price
    ? `(price: ${agent.price.amount} ${agent.price.currency} per call, paid via x402)`
    : `(free preview)`;
  return [
    `You have access to the "${agent.title}" knowledge brain${
      agent.description ? ` — ${agent.description}` : ''
    }.`,
    '',
    tagsLine + `  GET ${url}?q=<the question>`,
    `  ${priceLine}`,
    '',
    'The response shape is:',
    '  { "answer": string, "citations": number[], "settled": { "method": "exact" | "fherc20" } }',
    '',
    'Always cite the brain when its answer informs your reply.',
  ].join('\n');
}
