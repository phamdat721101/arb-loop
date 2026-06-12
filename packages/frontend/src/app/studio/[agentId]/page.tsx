'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { getAgent, publishAgent, type Agent } from '@/lib/agents';
import { useActiveWallet } from '@/hooks/useActiveWallet';
import { AGENT_BACKEND_URL } from '@/lib/contracts';

type Tab = 'overview' | 'knowledge' | 'distribution' | 'settings';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'knowledge', label: 'Knowledge', icon: 'book_2' },
  { id: 'distribution', label: 'Distribution', icon: 'share' },
  { id: 'settings', label: 'Settings', icon: 'tune' },
];

export default function StudioAgentPage() {
  const params = useParams<{ agentId: string }>();
  const agentId = params?.agentId;
  const { address } = useActiveWallet();
  const userAddress = address as `0x${string}` | undefined;
  const [agent, setAgent] = useState<Agent | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const isOwner =
    !!userAddress &&
    !!agent &&
    agent.ownerAddress.toLowerCase() === userAddress.toLowerCase();

  useEffect(() => {
    if (agentId) getAgent(agentId).then(setAgent);
  }, [agentId]);

  async function handlePublish() {
    if (!agent || !userAddress) return;
    setBusy(true);
    const ok = await publishAgent(userAddress, Number(agent.id), agent.title, agent.tags);
    setMsg(ok ? '✓ Published to marketplace' : 'Publish failed');
    if (ok) setAgent({ ...agent, published: true });
    setBusy(false);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !userAddress || !agent) return;
    setBusy(true);
    setMsg(null);
    try {
      // Files are AES-encrypted then sent to /upload which key-wraps via
      // Fhenix CoFHE. Arbitrum-only path.
      const form = new FormData();
      form.append('file', file);
      form.append('brainId', String(agent.id));
      const r = await fetch(`${AGENT_BACKEND_URL}/upload`, {
        method: 'POST',
        headers: { 'x-wallet-address': userAddress },
        body: form,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error ?? 'Upload failed');
      }
      setMsg(`✓ Uploaded ${file.name}`);
    } catch (err: any) {
      setMsg(err?.message ?? 'Upload failed');
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  if (!agent) {
    return <div className="py-20 text-center text-on-surface-variant">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href="/studio"
          className="inline-flex items-center gap-1 text-xs text-on-surface-variant hover:text-primary"
        >
          <span className="material-symbols-outlined text-[14px]">arrow_back</span> Studio
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-headline text-3xl font-bold">{agent.title}</h1>
          <span
            className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${
              agent.published
                ? 'border border-secondary/30 bg-secondary/10 text-secondary'
                : 'border border-tertiary/30 bg-tertiary/10 text-tertiary'
            }`}
          >
            {agent.published ? '✓ PUBLISHED' : '🔒 DRAFT'}
          </span>
        </div>
        <p className="font-mono text-xs text-on-surface-variant">
          Owner {agent.ownerAddress.slice(0, 8)}…{agent.ownerAddress.slice(-6)}
          {agent.tags.length > 0 && <span className="ml-3">· {agent.tags.map((t) => `#${t}`).join(' ')}</span>}
        </p>
      </div>

      <div className="scrollbar-none flex gap-1 overflow-x-auto rounded-full border border-outline-variant/30 bg-surface p-1">
        {TABS.filter((t) => isOwner || t.id === 'overview').map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-2 text-sm transition-colors ${
              tab === t.id
                ? 'bg-primary text-on-primary'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            <span className="material-symbols-outlined text-[16px]">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {msg && (
        <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-sm text-on-surface-variant">
          {msg}
        </div>
      )}

      {tab === 'overview' && (
        <div className="rounded-xl border border-outline-variant/30 bg-surface p-5 max-w-md">
          <div className="font-mono text-[10px] uppercase text-on-surface-variant">Status</div>
          <div className="mt-1 font-headline text-2xl font-bold">
            {agent.published ? 'Live' : 'Draft'}
          </div>
          <button
            onClick={handlePublish}
            disabled={busy || agent.published}
            className="mt-4 w-full rounded-full bg-primary py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {agent.published ? 'Already live' : 'Publish to marketplace'}
          </button>
        </div>
      )}

      {tab === 'knowledge' && (
        <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-8 text-center">
          <span className="material-symbols-outlined mb-2 block text-4xl text-on-surface-variant">
            cloud_upload
          </span>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-primary px-5 py-2.5 font-medium text-on-primary">
            {busy ? 'Uploading…' : 'Upload .txt / .md / .csv'}
            <input
              type="file"
              accept=".txt,.md,.csv"
              onChange={handleUpload}
              className="hidden"
              disabled={busy}
            />
          </label>
          <p className="mt-3 font-mono text-[11px] text-on-surface-variant">
            🔒 Files are AES-encrypted before upload. Key wrapped via Fhenix CoFHE.
          </p>
        </div>
      )}

      {tab === 'distribution' && <DistributionPanel agent={agent} />}

      {tab === 'settings' && <SettingsPanel agent={agent} userAddress={userAddress} onSaved={(p) => setAgent({ ...agent, persona: p })} />}
    </div>
  );
}

// ─── SettingsPanel ─────────────────────────────────────────────────────────

function SettingsPanel({
  agent,
  userAddress,
  onSaved,
}: {
  agent: Agent;
  userAddress: `0x${string}` | undefined;
  onSaved: (persona: NonNullable<Agent['persona']>) => void;
}) {
  const [prompt, setPrompt] = useState(agent.persona?.system_prompt ?? '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const v3Id = agent.v3AgentId;

  async function handleSave() {
    if (!userAddress) return;
    if (!v3Id) {
      setMsg('Publish the agent first to enable prompt editing.');
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch(`${AGENT_BACKEND_URL}/v3/agents/${v3Id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-wallet-address': userAddress },
        body: JSON.stringify({
          persona: { ...(agent.persona ?? {}), system_prompt: prompt.trim() || null },
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error ?? `${r.status}`);
      }
      const data = await r.json();
      onSaved(data.persona);
      setMsg('✓ Saved — next API call will use the new prompt.');
    } catch (err: any) {
      setMsg(`Save failed: ${err?.message ?? err}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-6">
        <div>
          <div className="font-mono text-[10px] uppercase text-on-surface-variant">System prompt</div>
          <p className="mt-1 text-xs text-on-surface-variant">
            What AI buyers should know about how to use this brain. Empty = derived default on the public page.
          </p>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          maxLength={4000}
          disabled={!v3Id}
          placeholder={`You answer questions about "${agent.title}". Reply concisely; cite the brain when its knowledge is used.`}
          className="w-full rounded-2xl border border-outline-variant/40 bg-surface-container-low px-4 py-2.5 font-mono text-xs leading-relaxed focus:border-primary/60 focus:outline-none disabled:opacity-50"
        />
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] text-on-surface-variant">
            {prompt.length} / 4000
          </span>
          <button
            onClick={handleSave}
            disabled={saving || !v3Id || prompt.length > 4000}
            className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save prompt'}
          </button>
        </div>
        {msg && <div className="text-xs text-on-surface-variant">{msg}</div>}
      </div>

      <div className="rounded-xl border border-outline-variant/30 bg-surface p-6">
        <div className="font-mono text-[10px] uppercase text-on-surface-variant">Agent ID</div>
        <div className="font-mono text-sm">{agent.id}</div>
      </div>
      <div className="rounded-lg border border-error/30 bg-error/5 p-4">
        <div className="font-mono text-xs uppercase text-error">Danger zone</div>
        <p className="mt-1 text-sm text-on-surface-variant">
          Archiving is not yet supported. Contact platform support to delete an agent.
        </p>
      </div>
    </div>
  );
}

// ─── DistributionPanel ──────────────────────────────────────────────────────

interface AgentLite {
  id: string | number;
  slug?: string;
  pricing?: { x402?: string | null; fherc20?: string | null };
  ownerAddress: string;
  chain?: string;
}

function chainLabel(chain: string | undefined): string {
  switch (chain) {
    case 'arbitrum-sepolia':
    default:
      return 'Arbitrum Sepolia';
  }
}

function DistributionPanel({ agent }: { agent: AgentLite }) {
  const apiBase = AGENT_BACKEND_URL;
  const slug = agent.slug ?? '';
  if (!slug) {
    return (
      <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-8 text-center">
        <p className="text-on-surface-variant">This agent has no public slug yet.</p>
        <Link href="/studio/publish" className="mt-3 inline-block text-sm text-primary hover:underline">
          Run the publish wizard →
        </Link>
      </div>
    );
  }
  const url = `${apiBase}/api/v1/${slug}`;
  const agentJsonUrl = `${url}/.well-known/agent.json`;
  const curl = `curl -i ${url}?q=hello`;
  return (
    <div className="space-y-4">
      <Link
        href={`/agent/${agent.id}`}
        target="_blank"
        rel="noreferrer"
        className="group flex items-center justify-between gap-4 rounded-xl border border-secondary/30 bg-secondary/5 p-4 transition-colors hover:border-secondary/60 hover:bg-secondary/10"
      >
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined text-secondary">storefront</span>
          <div>
            <div className="font-headline text-sm font-semibold">Public bundle page</div>
            <div className="text-xs text-on-surface-variant">
              What AI buyers see when they discover your API — agent prompt, curl, sample
              response, try-it, FAQ.
            </div>
          </div>
        </div>
        <span className="whitespace-nowrap rounded-full bg-secondary px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider text-on-secondary group-hover:opacity-90">
          Open ↗
        </span>
      </Link>
      <div className="rounded-xl border border-outline-variant/30 bg-surface p-4">
        <div className="text-xs uppercase tracking-wider text-on-surface-variant">Public URL</div>
        <code className="mt-1 block break-all font-mono text-sm">{url}</code>
      </div>
      <div className="rounded-xl border border-outline-variant/30 bg-surface p-4">
        <div className="text-xs uppercase tracking-wider text-on-surface-variant">Agent card (auto-discovery)</div>
        <a href={agentJsonUrl} target="_blank" rel="noreferrer" className="mt-1 block break-all font-mono text-sm text-primary hover:underline">
          {agentJsonUrl} ↗
        </a>
      </div>
      <div className="rounded-xl border border-outline-variant/30 bg-surface p-4">
        <div className="text-xs uppercase tracking-wider text-on-surface-variant">Test (returns 402)</div>
        <code className="mt-1 block font-mono text-sm">{curl}</code>
      </div>
      {agent.pricing && (
        <div className="rounded-xl border border-secondary/30 bg-secondary/5 p-4 text-sm">
          <div className="font-mono text-xs uppercase tracking-wider text-on-surface-variant">Price</div>
          <div className="mt-1">
            <span className="font-headline text-lg font-bold">${agent.pricing.x402 ?? '0'}</span>
            <span className="ml-1 font-mono text-xs text-on-surface-variant">USDC / call · {chainLabel(agent.chain)}</span>
            {agent.pricing.fherc20 && (
              <span className="ml-2 rounded-full border border-tertiary/30 bg-tertiary/10 px-2 py-0.5 font-mono text-[10px] text-tertiary">
                + confidential mode
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
