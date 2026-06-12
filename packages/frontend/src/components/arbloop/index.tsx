'use client';
/**
 * components/arbloop/index.tsx — consolidated UI components for arb-loop.
 *
 * SOLID: each component owns one render concern. State and writes come from
 * hooks/useArbLoop.ts (DI-style: hooks are the data layer).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatUnits, parseUnits } from 'viem';
import {
  ARBLOOP_API_URL,
  type AgentMetadataDto,
  type IterationLogDto,
  type LoopJobStatusName,
} from '@/lib/arbloop';
import { useApproveCheckpoint, useHireLoop } from '@/hooks/useArbLoop';

// ─── AgentCard ─────────────────────────────────────────────────────────

export function AgentCard({ a }: { a: AgentMetadataDto }) {
  const price = (Number(a.per_iter_default_micro_usdc) / 1e6).toFixed(2);
  return (
    <Link
      href={`/arbloop/agent/${a.agent_id}`}
      className="encryption-glow group flex h-full flex-col gap-3 rounded-xl border border-outline-variant/30 bg-surface p-5 hover:border-primary/40"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <span className="material-symbols-outlined text-[20px]">smart_toy</span>
        </div>
        {a.category && (
          <span className="matrix-chip rounded px-1.5 py-0.5 font-mono text-[10px] uppercase">
            {a.category}
          </span>
        )}
      </div>
      <div className="space-y-1">
        <h3 className="font-headline text-base font-semibold leading-snug text-on-surface group-hover:text-primary">
          {a.title}
        </h3>
        {a.short_description && (
          <p className="line-clamp-2 text-sm text-on-surface-variant">{a.short_description}</p>
        )}
      </div>
      <div className="mt-auto flex items-center justify-between text-xs text-on-surface-variant">
        <div className="flex items-center gap-2">
          <span>↻ {a.completed_jobs} loops</span>
          <span>· {a.max_iter_per_job} max iters</span>
        </div>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-primary">
          ${price}/iter · Hire
        </span>
      </div>
    </Link>
  );
}

// ─── AgentPersonaCard ──────────────────────────────────────────────────

export function AgentPersonaCard({ a }: { a: AgentMetadataDto }) {
  const price = (Number(a.per_iter_default_micro_usdc) / 1e6).toFixed(2);
  return (
    <div className="rounded-xl border border-outline-variant/30 bg-surface p-6 space-y-4">
      <div>
        <h2 className="font-headline text-2xl font-bold">{a.title}</h2>
        <p className="mt-1 text-sm text-on-surface-variant">{a.short_description}</p>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <Stat k="Backend" v={a.default_inference_backend} />
        <Stat k="Model" v={a.default_model_id} />
        <Stat k="Per-iter" v={`$${price} USDC`} />
        <Stat k="Max iters" v={String(a.max_iter_per_job)} />
        <Stat k="Reputation" v={`${a.reputation_score / 100}/100`} />
        <Stat k="Loops completed" v={String(a.completed_jobs)} />
      </dl>
      <p className="font-mono text-[11px] text-on-surface-variant break-all">
        seller: {a.seller_address}
      </p>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase text-on-surface-variant">{k}</dt>
      <dd className="font-mono text-sm">{v}</dd>
    </div>
  );
}

// ─── LoopComposer (form) ───────────────────────────────────────────────

export function LoopComposer({ agent }: { agent: AgentMetadataDto }) {
  const router = useRouter();
  const [maxIter, setMaxIter] = useState(Math.min(5, agent.max_iter_per_job));
  const defaultBudget = (Number(agent.per_iter_default_micro_usdc) * maxIter) / 1e6;
  const [budgetUsdc, setBudgetUsdc] = useState(defaultBudget.toFixed(2));
  const [task, setTask] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const { hire, isPending, error, txHash } = useHireLoop();

  // After the hire tx is mined, ask the API to parse the receipt + run iter 1
  // synchronously, then redirect to the job tracking page.
  useEffect(() => {
    if (!txHash) return;
    setConfirming(true); setConfirmErr(null);
    fetch(`${ARBLOOP_API_URL}/v3/arbloop/jobs/from-tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tx_hash: txHash, task: task.trim() || undefined }),
    })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok || !j.job_address) throw new Error(j.error ?? `HTTP ${r.status}`);
        router.push(`/arbloop/job/${j.job_address}`);
      })
      .catch((e) => setConfirmErr(String(e?.message ?? e)))
      .finally(() => setConfirming(false));
  }, [txHash, router, task]);

  async function onHire() {
    const budgetMicro = parseUnits(budgetUsdc, 6);
    await hire({
      agentId: BigInt(agent.agent_id),
      maxIterations: BigInt(maxIter),
      budgetMicroUsdc: budgetMicro,
    });
  }

  return (
    <div className="space-y-4 rounded-xl border border-outline-variant/30 bg-surface p-6">
      <h3 className="font-headline text-lg font-semibold">Hire this loop</h3>
      <label className="block">
        <span className="font-mono text-[10px] uppercase text-on-surface-variant">Task description</span>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={3}
          placeholder="Describe what the agent should do (optional — agent uses its persona prompt by default)."
          className="mt-1 w-full resize-y rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="font-mono text-[10px] uppercase text-on-surface-variant">Max iterations</span>
        <input
          type="number"
          value={maxIter}
          min={1}
          max={agent.max_iter_per_job}
          onChange={(e) => setMaxIter(Math.max(1, Math.min(agent.max_iter_per_job, Number(e.target.value))))}
          className="mt-1 w-full rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 font-mono text-sm"
        />
      </label>
      <label className="block">
        <span className="font-mono text-[10px] uppercase text-on-surface-variant">Budget (USDC)</span>
        <input
          type="number"
          step="0.01"
          value={budgetUsdc}
          onChange={(e) => setBudgetUsdc(e.target.value)}
          className="mt-1 w-full rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 font-mono text-sm"
        />
      </label>
      <p className="text-xs text-on-surface-variant">
        Default ${(Number(agent.per_iter_default_micro_usdc) / 1e6).toFixed(2)}/iter ×{' '}
        {maxIter} = ${defaultBudget.toFixed(2)}. You can over-fund; refund on cancel.
      </p>
      <button
        disabled={isPending || confirming || !budgetUsdc}
        onClick={onHire}
        className="w-full rounded-full bg-primary px-5 py-3 text-sm font-medium text-on-primary disabled:opacity-50"
      >
        {isPending ? 'Approving + creating…' : confirming ? 'Running iter 1…' : `Sign + hire — $${budgetUsdc}`}
      </button>
      {error && <p className="text-xs text-amber-500">{error}</p>}
      {confirmErr && <p className="text-xs text-amber-500">post-hire: {confirmErr}</p>}
      {txHash && (
        <p className="font-mono text-[11px] text-on-surface-variant break-all">
          tx: {txHash}{confirming ? ' · running task…' : ''}
        </p>
      )}
    </div>
  );
}

// ─── JobDashboard ──────────────────────────────────────────────────────

export interface JobDashboardProps {
  jobAddress: string;
  statusName: LoopJobStatusName | null;
  iterationsDone: number;
  maxIterations: number;
  spentMicroUsdc: bigint;
  budgetMicroUsdc: bigint;
}

export function JobDashboard(p: JobDashboardProps) {
  const spent = formatUnits(p.spentMicroUsdc, 6);
  const budget = formatUnits(p.budgetMicroUsdc, 6);
  const pct = p.budgetMicroUsdc > 0n
    ? Number((p.spentMicroUsdc * 100n) / p.budgetMicroUsdc)
    : 0;
  return (
    <div className="space-y-4 rounded-xl border border-outline-variant/30 bg-surface p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase text-on-surface-variant">Status</p>
          <p className="font-headline text-2xl font-bold">{p.statusName ?? '…'}</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-[10px] uppercase text-on-surface-variant">Iterations</p>
          <p className="font-mono text-2xl">{p.iterationsDone}/{p.maxIterations}</p>
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between text-xs">
          <span>Budget</span>
          <span className="font-mono">${spent} / ${budget}</span>
        </div>
        <div className="mt-1 h-2 rounded-full bg-surface-container-low overflow-hidden">
          <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      </div>
      <p className="font-mono text-[11px] text-on-surface-variant break-all">
        job: {p.jobAddress}
      </p>
    </div>
  );
}

// ─── IterationReceiptList ──────────────────────────────────────────────

export function IterationReceiptList({ log }: { log: IterationLogDto[] }) {
  if (log.length === 0) {
    return <p className="text-sm text-on-surface-variant">Running iter 1… result will appear here in ~10–30s.</p>;
  }
  function downloadAnswer(iterN: number, answer: string) {
    const blob = new Blob([answer], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `arbloop-iter-${iterN}.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  return (
    <ul className="space-y-3">
      {log.map((it) => (
        <li
          key={it.iter_n}
          className="space-y-2 rounded border border-outline-variant/30 bg-surface-container-low px-3 py-2"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="font-mono text-sm">iter #{it.iter_n}</span>{' '}
              <span className="text-xs text-on-surface-variant">
                · {it.inference_backend} · {it.inference_model_id}
              </span>
            </div>
            {it.attestation_uid && it.attestation_uid !== '00'.repeat(32) && (
              <a
                href={`https://arbitrum.easscan.org/attestation/view/${it.attestation_uid}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs text-primary hover:underline"
              >
                EAS ↗
              </a>
            )}
          </div>
          {it.answer && (
            <>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-surface px-3 py-2 text-sm">
                {it.answer}
              </pre>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => downloadAnswer(it.iter_n, it.answer ?? '')}
                  className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20"
                >
                  ↓ Download
                </button>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(it.answer ?? '')}
                  className="rounded-full border border-outline-variant/40 px-3 py-1 text-xs hover:border-primary/40 hover:text-primary"
                >
                  Copy
                </button>
              </div>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

// ─── CheckpointGate ────────────────────────────────────────────────────

export function CheckpointGate({ jobAddress, iterN }: { jobAddress: `0x${string}`; iterN: number }) {
  const { approve, isPending } = useApproveCheckpoint();
  const [done, setDone] = useState(false);
  if (done) return <p className="text-sm text-secondary">✓ Checkpoint approved — runner will resume within ~5s.</p>;
  return (
    <div className="rounded-xl border border-tertiary/30 bg-tertiary/5 p-4">
      <p className="text-sm">
        <strong>Checkpoint after iter {iterN}.</strong> Review the output, then approve to resume.
      </p>
      <button
        disabled={isPending}
        onClick={async () => {
          const tx = await approve(jobAddress, iterN);
          if (tx) setDone(true);
        }}
        className="mt-3 rounded-full bg-tertiary px-4 py-2 text-sm font-medium text-on-tertiary disabled:opacity-50"
      >
        {isPending ? 'Approving…' : 'Approve & resume'}
      </button>
    </div>
  );
}

// ─── MemoryTraceViewer ─────────────────────────────────────────────────

export function MemoryTraceViewer({ jobAddress }: { jobAddress: string }) {
  const [tab, setTab] = useState<'l1' | 'l2' | 'l4'>('l1');
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  async function loadTab(level: 'l1' | 'l2' | 'l4') {
    setTab(level);
    setLoading(true);
    try {
      const r = await fetch(`${ARBLOOP_API_URL}/v3/arbloop/jobs/${jobAddress}/memory/${level}`);
      const j = await r.json();
      setData(j);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-5">
      <div className="flex gap-2">
        {(['l1', 'l2', 'l4'] as const).map((lv) => (
          <button
            key={lv}
            onClick={() => loadTab(lv)}
            className={`rounded-full border px-3 py-1.5 text-xs ${
              tab === lv
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-outline-variant/40 text-on-surface-variant'
            }`}
          >
            {lv.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="rounded bg-surface-container-low p-3 font-mono text-[11px] max-h-72 overflow-auto">
        {loading ? '…' : data ? JSON.stringify(data, null, 2) : '— click a level to load —'}
      </div>
    </div>
  );
}
