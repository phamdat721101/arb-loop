'use client';
/**
 * components/arbloop/index.tsx — consolidated UI components for arb-loop.
 *
 * SOLID: each component owns one render concern. State and writes come from
 * hooks/useArbLoop.ts (DI-style: hooks are the data layer).
 */

import { useEffect, useRef, useState } from 'react';
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

// ─── File-attach helpers (shared with chat composer pattern) ───────────
//
// Text-likes inline their content as labelled task context; binary files
// inline only metadata so the agent acknowledges + asks for a text export.
// Same regex/MIME detection as chat/[agentId]/page.tsx — duplication kept
// short (~25 LOC) instead of cross-package extraction to honour the
// "essential files only" mandate.
const TEXTY_EXT_LOOP = /\.(txt|md|markdown|json|ya?ml|xml|csv|tsv|js|ts|tsx|jsx|py|rb|go|java|c|cpp|h|hpp|sh|sql|toml|ini|env|log|html|css|svg|sol|move|rs)$/i;
function isLikelyTextLoop(f: File): boolean {
  return f.type.startsWith('text/')
    || /^application\/(json|xml|yaml|x-yaml|toml|x-toml|javascript|typescript|sql)/.test(f.type)
    || TEXTY_EXT_LOOP.test(f.name);
}
async function readFileAsTaskContext(file: File): Promise<string> {
  const header = `\n\n--- Attached file: ${file.name} (${file.size} bytes, ${file.type || 'unknown'}) ---\n`;
  if (!isLikelyTextLoop(file)) {
    return `${header}[binary content not decoded; ask the user for a text export if needed]\n--- End attached file ---`;
  }
  const text = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
  const MAX = 60_000;
  const body = text.length > MAX ? `${text.slice(0, MAX)}\n[…truncated ${text.length - MAX} chars]` : text;
  return `${header}${body}\n--- End attached file ---`;
}

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
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const { hire, isPending, error, txHash } = useHireLoop();

  // After the hire tx is mined, read any attached file → append to task as
  // labelled context → ask the API to parse the receipt + run iter 1, then
  // redirect to the job tracking page.
  useEffect(() => {
    if (!txHash) return;
    let cancelled = false;
    setConfirming(true); setConfirmErr(null);
    (async () => {
      try {
        let composedTask = task.trim();
        if (attachedFile) {
          try { composedTask = `${composedTask || `Process the attached file: ${attachedFile.name}`}${await readFileAsTaskContext(attachedFile)}`; }
          catch { /* file unreadable — fall through with bare task */ }
        }
        const r = await fetch(`${ARBLOOP_API_URL}/v3/arbloop/jobs/from-tx`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tx_hash: txHash, task: composedTask || undefined }),
        });
        const j = await r.json();
        if (!r.ok || !j.job_address) throw new Error(j.error ?? `HTTP ${r.status}`);
        if (!cancelled) router.push(`/arbloop/job/${j.job_address}`);
      } catch (e) {
        if (!cancelled) setConfirmErr(String((e as Error)?.message ?? e));
      } finally {
        if (!cancelled) setConfirming(false);
      }
    })();
    return () => { cancelled = true; };
  }, [txHash, router, task, attachedFile]);

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
          placeholder="Describe what the agent should do (optional — agent uses its persona prompt by default). Attach a file below for context."
          className="mt-1 w-full resize-y rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-sm"
        />
      </label>
      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          onChange={(e) => setAttachedFile(e.target.files?.[0] ?? null)}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isPending || confirming}
          className="flex items-center gap-1 rounded-full border border-outline-variant/40 px-3 py-1.5 text-xs hover:border-primary/40 hover:text-primary disabled:opacity-50"
          title="Attach a file (any type) for task context"
        >
          <span className="material-symbols-outlined text-[14px]">attach_file</span>
          {attachedFile ? attachedFile.name : 'Attach context file'}
        </button>
        {attachedFile && (
          <>
            <span className="font-mono text-[10px] text-on-surface-variant">
              {(attachedFile.size / 1024).toFixed(1)} kB
            </span>
            <button
              type="button"
              onClick={() => {
                setAttachedFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              className="ml-auto rounded-full p-1 text-on-surface-variant hover:bg-surface-container hover:text-error"
              aria-label="Remove attachment"
            >
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          </>
        )}
      </div>
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

export function IterationReceiptList({
  log,
  txByIter,
}: {
  log: IterationLogDto[];
  /** Optional on-chain settlement tx per iter (from useIterationTxs). */
  txByIter?: Record<number, `0x${string}`>;
}) {
  if (log.length === 0) {
    return <p className="text-sm text-on-surface-variant">Running iter 1… result will appear here in ~10–30s.</p>;
  }
  // Per-network explorer base. Reads NEXT_PUBLIC_ARBLOOP_NETWORK so the link
  // works on both Sepolia and mainnet without code changes.
  const explorerBase =
    (process.env.NEXT_PUBLIC_ARBLOOP_NETWORK ?? 'arbitrum-sepolia') === 'arbitrum'
      ? 'https://arbiscan.io'
      : 'https://sepolia.arbiscan.io';
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
      {log.map((it) => {
        const settlementTx = txByIter?.[it.iter_n];
        const paidUsdc = (Number(it.amount_paid_micro_usdc ?? 0) / 1e6).toFixed(2);
        return (
        <li
          key={it.iter_n}
          className="space-y-2 rounded border border-outline-variant/30 bg-surface-container-low px-3 py-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-mono text-sm">iter #{it.iter_n}</span>{' '}
              <span className="text-xs text-on-surface-variant">
                · {it.inference_backend} · {it.inference_model_id}
              </span>
            </div>
            <span
              className="rounded-full bg-secondary/10 px-2 py-0.5 font-mono text-[11px] text-secondary tabular-nums"
              title="USDC paid into escrow for this iter; split 70/25/5 to seller / compute / platform"
            >
              ${paidUsdc} settled
            </span>
          </div>
          {/* Settlement + attestation row — both deeplink to public chain
              proof so the buyer can verify where their USDC went, and the
              seller can verify they got paid. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            {settlementTx ? (
              <a
                href={`${explorerBase}/tx/${settlementTx}`}
                target="_blank"
                rel="noreferrer"
                title={`Settlement tx ${settlementTx} — performs the 70/25/5 USDC split`}
                className="font-mono text-primary hover:underline"
                data-test="iter-settlement-tx"
              >
                Settlement: {settlementTx.slice(0, 10)}…{settlementTx.slice(-6)} ↗
              </a>
            ) : (
              <span className="font-mono text-on-surface-variant">Settlement: pending…</span>
            )}
            {it.attestation_uid && it.attestation_uid !== '00'.repeat(32) && (
              <a
                href={`https://arbitrum.easscan.org/attestation/view/${it.attestation_uid}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-primary hover:underline"
              >
                Attestation: EAS ↗
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
        );
      })}
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

// ─── BuyerPortfolio ────────────────────────────────────────────────────
//
// Studio Buyer tab. One component, two render branches: card list (<sm)
// and table (>=sm). Same rows in both — Tailwind toggles visibility, no
// JS resize listener. Polls every 5s while any job is RUNNING, every 30s
// otherwise. useFetchJson skips polls on hidden tabs.

import {
  useBuyerJobs,
  usePauseJob,
  useResumeJob,
  useCancelJob,
  useChangeRequests,
  useSendChangeRequest,
  useSellerJobs,
  useJobChainHistory,
  type ChangeRequestDto,
  type JobChainEvent,
} from '@/hooks/useArbLoop';
import { LOOP_JOB_STATUS, type BuyerJobDto, type SellerJobDto } from '@/lib/arbloop';

const STATUS_TINT: Record<string, string> = {
  PENDING: 'bg-surface-container-low text-on-surface-variant',
  RUNNING: 'bg-primary/10 text-primary',
  PAUSED_BUDGET: 'bg-amber-500/10 text-amber-500',
  PAUSED_CHECKPOINT: 'bg-tertiary/10 text-tertiary',
  DONE: 'bg-secondary/10 text-secondary',
  CANCELLED: 'bg-error/10 text-error',
};

function fmtUsdc(micro: string | bigint | undefined): string {
  if (micro === undefined || micro === null) return '0.00';
  try { return formatUnits(BigInt(micro), 6); } catch { return '0.00'; }
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function BuyerPortfolio({ buyerAddress }: { buyerAddress: `0x${string}` | null | undefined }) {
  const anyRunning = (rows: BuyerJobDto[]) =>
    rows.some((j) => LOOP_JOB_STATUS[j.status] === 'RUNNING');
  // Two-pass cadence: start fast, slow down once we know there are no
  // running rows. The hook re-renders on rows change; cadence updates.
  const fast = 5_000;
  const slow = 30_000;
  // Initial render uses fast cadence to avoid a 30s wait on first paint.
  const probe = useBuyerJobs(buyerAddress, fast);
  const intervalMs = anyRunning(probe.jobs) ? fast : slow;
  const { jobs, loading, error } = useBuyerJobs(buyerAddress, intervalMs);

  if (!buyerAddress) {
    return (
      <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-8 text-center">
        <p className="text-on-surface-variant">Connect a wallet to see your hired loops.</p>
      </div>
    );
  }
  if (loading && jobs.length === 0) {
    return <p className="py-12 text-center text-on-surface-variant">Loading your loops…</p>;
  }
  if (error) {
    return <p className="py-8 text-center text-amber-500">Could not load: {error}</p>;
  }
  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-10 text-center">
        <p className="text-on-surface-variant">You haven&apos;t hired a loop yet.</p>
        <p className="mt-2 text-xs text-on-surface-variant">
          Browse the <Link href="/arbloop/marketplace" className="text-primary hover:underline">marketplace</Link>{' '}
          or describe what you need on the <Link href="/" className="text-primary hover:underline">home page</Link>.
        </p>
      </div>
    );
  }

  return (
    <div data-test="buyer-portfolio">
      {/* Mobile: card list (<sm) */}
      <ul data-test="buyer-portfolio-card-list" className="space-y-3 sm:hidden">
        {jobs.map((j) => <BuyerJobCard key={j.job_contract_address} j={j} />)}
      </ul>
      {/* Desktop: table (≥sm) */}
      <div data-test="buyer-portfolio-table" className="hidden overflow-x-auto rounded-xl border border-outline-variant/30 bg-surface sm:block">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-left text-[11px] uppercase tracking-wider text-on-surface-variant">
            <tr className="border-b border-outline-variant/20">
              <th className="px-4 py-3 font-medium">Title</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Iter</th>
              <th className="px-4 py-3 font-medium">Spent / Budget</th>
              <th className="px-4 py-3 font-medium">Last activity</th>
              <th className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const statusName = LOOP_JOB_STATUS[j.status] ?? '?';
              return (
                <tr key={j.job_contract_address} className="border-b border-outline-variant/10 last:border-0 hover:bg-surface-container-low">
                  <td className="px-4 py-3">
                    <div className="font-medium text-on-surface">{j.agent_title ?? `Agent #${j.agent_id}`}</div>
                    <div className="font-mono text-[10px] text-on-surface-variant">{j.job_contract_address.slice(0, 10)}…</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TINT[statusName] ?? ''}`}>
                      {statusName}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono">{j.iterations_done}/{j.max_iterations}</td>
                  <td className="px-4 py-3 font-mono">${fmtUsdc(j.spent_micro_usdc)} / ${fmtUsdc(j.budget_micro_usdc)}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{relTime(j.last_iter_completed_at ?? j.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/arbloop/job/${j.job_contract_address}`}
                      className="rounded-full border border-primary/40 bg-primary/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-primary hover:bg-primary/20"
                    >
                      Open ↗
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BuyerJobCard({ j }: { j: BuyerJobDto }) {
  const statusName = LOOP_JOB_STATUS[j.status] ?? '?';
  return (
    <li className="rounded-xl border border-outline-variant/30 bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-on-surface">{j.agent_title ?? `Agent #${j.agent_id}`}</div>
          <div className="font-mono text-[10px] text-on-surface-variant">{j.job_contract_address.slice(0, 14)}…</div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TINT[statusName] ?? ''}`}>
          {statusName}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs tabular-nums">
        <div>
          <dt className="text-[10px] uppercase text-on-surface-variant">Iter</dt>
          <dd className="font-mono">{j.iterations_done}/{j.max_iterations}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase text-on-surface-variant">Spent</dt>
          <dd className="font-mono">${fmtUsdc(j.spent_micro_usdc)} / ${fmtUsdc(j.budget_micro_usdc)}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-[10px] uppercase text-on-surface-variant">Last activity</dt>
          <dd>{relTime(j.last_iter_completed_at ?? j.created_at)}</dd>
        </div>
      </dl>
      <Link
        href={`/arbloop/job/${j.job_contract_address}`}
        className="mt-3 inline-flex w-full items-center justify-center rounded-full border border-primary/40 bg-primary/10 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-primary hover:bg-primary/20"
        style={{ minHeight: 44 }}
      >
        Open ↗
      </Link>
    </li>
  );
}

// ─── SellerHiresPanel ──────────────────────────────────────────────────
//
// Studio Seller "Hires" view: every job that hired one of this wallet's
// agents, with earnings already paid (LoopJob.advanceIterWithSplit ships
// the seller's 70% inline per iter — there is no withdrawal step). The
// header note tells the seller this explicitly so they don't look for a
// button. Each row deeplinks to the per-job page where the buyer + seller
// can see every settlement tx on Arbiscan.

export function SellerHiresPanel({ sellerAddress }: { sellerAddress: `0x${string}` | null | undefined }) {
  // Cadence mirrors BuyerPortfolio: 5s while any job RUNNING, 30s otherwise.
  const fast = 5_000;
  const slow = 30_000;
  const probe = useSellerJobs(sellerAddress, fast);
  const anyRunning = probe.jobs.some((j) => LOOP_JOB_STATUS[j.status] === 'RUNNING');
  const { jobs, loading, error } = useSellerJobs(sellerAddress, anyRunning ? fast : slow);

  const totalEarnedMicro = jobs.reduce((acc, j) => acc + Number(j.earned_micro_usdc ?? 0), 0);
  const totalEarnedUsdc = (totalEarnedMicro / 1e6).toFixed(2);

  if (!sellerAddress) return null;
  if (loading && jobs.length === 0) {
    return <p className="py-8 text-center text-on-surface-variant">Loading hires…</p>;
  }
  if (error) {
    return <p className="py-6 text-center text-amber-500">Could not load: {error}</p>;
  }
  return (
    <section className="space-y-3" data-test="seller-hires-panel">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-headline text-lg font-semibold">Hires</h2>
          <p className="text-xs text-on-surface-variant">
            Every loop your agents have run. Each iter pays you 70% directly to your wallet — no manual withdrawal needed.
          </p>
        </div>
        {jobs.length > 0 && (
          <div
            className="rounded-full border border-secondary/30 bg-secondary/5 px-3 py-1 text-xs tabular-nums"
            title="Sum of seller cuts across all your hires (already in your wallet)"
            data-test="seller-total-earned"
          >
            Earned: <span className="font-mono text-secondary">${totalEarnedUsdc}</span>
          </div>
        )}
      </header>
      {jobs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-8 text-center">
          <p className="text-on-surface-variant">No hires yet.</p>
          <p className="mt-2 text-xs text-on-surface-variant">
            When a buyer hires one of your agents, the loop appears here with per-iter settlement proof.
          </p>
        </div>
      ) : (
        <>
          {/* Mobile cards */}
          <ul className="space-y-3 sm:hidden">
            {jobs.map((j) => <SellerHireCard key={j.job_contract_address} j={j} />)}
          </ul>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl border border-outline-variant/30 bg-surface sm:block">
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-[11px] uppercase tracking-wider text-on-surface-variant">
                <tr className="border-b border-outline-variant/20">
                  <th className="px-4 py-3 font-medium">Agent</th>
                  <th className="px-4 py-3 font-medium">Buyer</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Iter</th>
                  <th className="px-4 py-3 font-medium">Earned</th>
                  <th className="px-4 py-3 font-medium">Activity</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const statusName = LOOP_JOB_STATUS[j.status] ?? '?';
                  const earned = (Number(j.earned_micro_usdc ?? 0) / 1e6).toFixed(2);
                  return (
                    <tr key={j.job_contract_address} className="border-b border-outline-variant/10 last:border-0 hover:bg-surface-container-low">
                      <td className="px-4 py-3">
                        <div className="font-medium text-on-surface">{j.agent_title ?? `Agent #${j.agent_id}`}</div>
                        <div className="font-mono text-[10px] text-on-surface-variant">{j.job_contract_address.slice(0, 10)}…</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{j.buyer_address.slice(0, 8)}…{j.buyer_address.slice(-4)}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TINT[statusName] ?? ''}`}>
                          {statusName}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono">{j.iterations_done}/{j.max_iterations}</td>
                      <td className="px-4 py-3 font-mono text-secondary">${earned}</td>
                      <td className="px-4 py-3 text-on-surface-variant">{relTime(j.last_iter_at ?? j.created_at)}</td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/arbloop/job/${j.job_contract_address}`}
                          className={`rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-wider ${
                            statusName === 'DONE'
                              ? 'border-secondary/40 bg-secondary/10 text-secondary hover:bg-secondary/20'
                              : 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
                          }`}
                          title={
                            statusName === 'DONE'
                              ? 'Job complete — your 70% was paid inline per iter via advanceIterWithSplit. Click to view payout txs on Arbiscan.'
                              : 'Open job page'
                          }
                        >
                          {statusName === 'DONE' ? 'Claim & verify ↗' : 'Open ↗'}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function SellerHireCard({ j }: { j: SellerJobDto }) {
  const statusName = LOOP_JOB_STATUS[j.status] ?? '?';
  const earned = (Number(j.earned_micro_usdc ?? 0) / 1e6).toFixed(2);
  return (
    <li className="rounded-xl border border-outline-variant/30 bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-on-surface">{j.agent_title ?? `Agent #${j.agent_id}`}</div>
          <div className="font-mono text-[10px] text-on-surface-variant">buyer {j.buyer_address.slice(0, 10)}…</div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TINT[statusName] ?? ''}`}>
          {statusName}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs tabular-nums">
        <div>
          <dt className="text-[10px] uppercase text-on-surface-variant">Iter</dt>
          <dd className="font-mono">{j.iterations_done}/{j.max_iterations}</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase text-on-surface-variant">Earned</dt>
          <dd className="font-mono text-secondary">${earned}</dd>
        </div>
      </dl>
      <Link
        href={`/arbloop/job/${j.job_contract_address}`}
        className={`mt-3 inline-flex w-full items-center justify-center rounded-full border px-3 py-2 font-mono text-[11px] uppercase tracking-wider ${
          statusName === 'DONE'
            ? 'border-secondary/40 bg-secondary/10 text-secondary hover:bg-secondary/20'
            : 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
        }`}
        style={{ minHeight: 44 }}
      >
        {statusName === 'DONE' ? 'Claim & verify ↗' : 'Open ↗'}
      </Link>
    </li>
  );
}

// ─── JobChainHistory ───────────────────────────────────────────────────
//
// On-chain USDC flow timeline for a single job: hire deposit, per-iter
// settlement splits, refund. Each row deeplinks to Arbiscan so buyer +
// seller both have the public-chain proof of where every dollar moved.
// Empty state when the RPC rate-limits getLogs (graceful degradation).

export function JobChainHistory({ jobAddress }: { jobAddress: `0x${string}` }) {
  const events = useJobChainHistory(jobAddress);
  // Per-network explorer base — same env knob the action bar uses, so
  // switching to mainnet is a single env-var change.
  const explorerBase =
    (process.env.NEXT_PUBLIC_ARBLOOP_NETWORK ?? 'arbitrum-sepolia') === 'arbitrum'
      ? 'https://arbiscan.io'
      : 'https://sepolia.arbiscan.io';
  // Heuristic labels: first inflow = HIRE; outflows during a RUNNING job
  // = settlement legs of advanceIterWithSplit (3 per iter); a final
  // outflow back to the job's buyer (when present) = REFUND. The label
  // is just a hint — the user clicks through to Arbiscan for the full
  // call data and 70/25/5 trace.
  function labelFor(ev: JobChainEvent, idx: number): string {
    if (ev.direction === 'in') return idx === 0 ? 'Hire deposit' : 'Top-up';
    return 'Settlement leg';
  }
  return (
    <section
      data-test="job-chain-history"
      className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-4"
    >
      <header className="flex items-center justify-between gap-3">
        <h3 className="font-headline text-base font-semibold">On-chain history</h3>
        <a
          href={`${explorerBase}/address/${jobAddress}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[11px] text-primary hover:underline"
          title="Open the LoopJob escrow on Arbiscan to see every call + ERC-20 trace"
        >
          escrow ↗
        </a>
      </header>
      {events.length === 0 ? (
        <p className="text-sm text-on-surface-variant">
          No on-chain transfers yet — or the RPC rate-limited the log scan.
          Open the escrow address above to view directly on Arbiscan.
        </p>
      ) : (
        <ol className="space-y-2 text-sm">
          {events.map((ev, idx) => {
            const usdc = (Number(ev.amountMicro) / 1e6).toFixed(2);
            const arrow = ev.direction === 'in' ? '↘' : '↗';
            return (
              <li
                key={`${ev.txHash}-${idx}`}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded border border-outline-variant/20 bg-surface-container-low px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      ev.direction === 'in'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-secondary/10 text-secondary'
                    }`}
                  >
                    {arrow} {labelFor(ev, idx)}
                  </span>
                  <span className="font-mono text-xs tabular-nums">${usdc}</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-on-surface-variant">
                  <a
                    href={`${explorerBase}/address/${ev.counterparty}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono hover:text-primary hover:underline"
                    title={ev.direction === 'in' ? 'Payer' : 'Recipient'}
                  >
                    {ev.direction === 'in' ? 'from' : 'to'} {ev.counterparty.slice(0, 8)}…
                  </a>
                  <a
                    href={`${explorerBase}/tx/${ev.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-primary hover:underline"
                  >
                    tx ↗
                  </a>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// ─── JobActionBar ──────────────────────────────────────────────────────
//
// Pause / Resume / Cancel buttons gated by the current LoopJob status.
// Each button is ≥44pt tap target (iOS guideline), stacks vertically <sm,
// inlines >=sm. State-machine guards mirror the on-chain modifiers in
// LoopJob.sol so a stale UI cannot revert silently.

export interface JobActionBarProps {
  jobAddress: `0x${string}`;
  statusName: LoopJobStatusName | null;
  onAfter?: () => void;
}

export function JobActionBar({ jobAddress, statusName, onAfter }: JobActionBarProps) {
  const pause = usePauseJob();
  const resume = useResumeJob();
  const cancel = useCancelJob();
  const [tx, setTx] = useState<`0x${string}` | null>(null);

  const isRunning = statusName === 'RUNNING';
  const isPaused = statusName === 'PAUSED_BUDGET' || statusName === 'PAUSED_CHECKPOINT';
  const terminal = statusName === 'DONE' || statusName === 'CANCELLED';

  async function run(action: (a: `0x${string}`) => Promise<`0x${string}` | null>) {
    const h = await action(jobAddress);
    if (h) { setTx(h); onAfter?.(); }
  }

  const pending = pause.isPending || resume.isPending || cancel.isPending;

  if (terminal) {
    return (
      <div className="rounded-xl border border-outline-variant/30 bg-surface-container-low p-4 text-sm text-on-surface-variant">
        Loop is {statusName?.toLowerCase()}. No further actions available.
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-xl border border-outline-variant/30 bg-surface p-4">
      <h3 className="font-headline text-base font-semibold">Controls</h3>
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
        {isRunning && (
          <button
            data-test="action-pause"
            disabled={pending}
            onClick={() => run(pause.call)}
            className="flex-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm font-medium text-amber-600 hover:bg-amber-500/20 disabled:opacity-50"
            style={{ minHeight: 44 }}
          >
            {pause.isPending ? 'Pausing…' : '⏸ Pause'}
          </button>
        )}
        {isPaused && (
          <button
            data-test="action-resume"
            disabled={pending}
            onClick={() => run(resume.call)}
            className="flex-1 rounded-full border border-primary/40 bg-primary/10 px-4 py-3 text-sm font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
            style={{ minHeight: 44 }}
          >
            {resume.isPending ? 'Resuming…' : '▶ Resume'}
          </button>
        )}
        <button
          data-test="action-cancel"
          disabled={pending}
          onClick={() => {
            if (!confirm('Cancel this loop? The unspent budget will be refunded to your wallet.')) return;
            void run(cancel.call);
          }}
          className="flex-1 rounded-full border border-error/40 bg-error/5 px-4 py-3 text-sm font-medium text-error hover:bg-error/10 disabled:opacity-50"
          style={{ minHeight: 44 }}
        >
          {cancel.isPending ? 'Cancelling…' : '✕ Cancel'}
        </button>
      </div>
      {tx && (
        <p className="font-mono text-[11px] text-on-surface-variant break-all">
          tx: <a className="text-primary hover:underline" href={`https://sepolia.arbiscan.io/tx/${tx}`} target="_blank" rel="noreferrer">{tx}</a>
        </p>
      )}
    </div>
  );
}

// ─── ChangeRequestThread ───────────────────────────────────────────────
//
// Off-chain message thread bound to a job. Same component for buyer and
// seller; direction comes from the row. Server enforces auth via
// x-wallet-address header (must be buyer or seller of the job).

export interface ChangeRequestThreadProps {
  jobAddress: string;
  /** Wallet of the connected user — used to colour their own bubbles. */
  selfAddress: string | null | undefined;
}

export function ChangeRequestThread({ jobAddress, selfAddress }: ChangeRequestThreadProps) {
  const { requests, loading, error, refetch } = useChangeRequests(jobAddress);
  const { send, sending, error: sendErr } = useSendChangeRequest(jobAddress);
  const [body, setBody] = useState('');
  const remaining = 2000 - body.length;

  async function onSend() {
    const ok = await send(body);
    if (ok) { setBody(''); refetch(); }
  }

  return (
    <div className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-4">
      <h3 className="font-headline text-base font-semibold">Change requests</h3>
      <ul className="space-y-2 max-h-80 overflow-y-auto" aria-live="polite">
        {loading && requests.length === 0 && (
          <li className="text-sm text-on-surface-variant">Loading…</li>
        )}
        {!loading && requests.length === 0 && (
          <li className="text-sm text-on-surface-variant">
            No messages yet. Send the seller a request — for example, “please use a more formal register”.
          </li>
        )}
        {requests.map((r) => <ChangeRequestBubble key={r.id} r={r} selfAddress={selfAddress} />)}
      </ul>
      {error && <p className="text-xs text-amber-500">load: {error}</p>}
      <div className="space-y-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, 2000))}
          rows={3}
          placeholder="Describe what you'd like changed (≤2000 chars)…"
          className="w-full resize-y rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-base sm:text-sm"
          style={{ minHeight: 80 }}
        />
        <div className="flex items-center justify-between gap-3">
          <span className={`font-mono text-[11px] ${remaining < 50 ? 'text-amber-500' : 'text-on-surface-variant'}`}>
            {remaining} chars left
          </span>
          <button
            data-test="change-request-send"
            disabled={sending || !body.trim()}
            onClick={onSend}
            className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
            style={{ minHeight: 44, minWidth: 88 }}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
        {sendErr && <p className="text-xs text-amber-500">send: {sendErr}</p>}
      </div>
    </div>
  );
}

function ChangeRequestBubble({ r, selfAddress }: { r: ChangeRequestDto; selfAddress: string | null | undefined }) {
  const mine = !!selfAddress && r.sender_address.toLowerCase() === selfAddress.toLowerCase();
  const directionLabel = r.direction === 'buyer_to_seller' ? 'Buyer' : 'Seller';
  return (
    <li className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] sm:max-w-[70%] rounded-2xl px-3 py-2 text-sm ${
          mine
            ? 'bg-primary/10 text-on-surface'
            : 'bg-surface-container-low text-on-surface-variant'
        }`}
      >
        <div className="mb-1 font-mono text-[10px] uppercase opacity-70">
          {directionLabel} · {relTime(r.created_at)}
        </div>
        <p className="whitespace-pre-wrap break-words">{r.body}</p>
      </div>
    </li>
  );
}
