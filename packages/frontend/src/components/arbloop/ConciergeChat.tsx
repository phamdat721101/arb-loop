'use client';
/**
 * components/arbloop/ConciergeChat.tsx — chat-driven discovery + execution.
 *
 * Replaces the existing ChatBox on `/page.tsx` when
 * NEXT_PUBLIC_FEATURE_ARBLOOP_CHAT_EXECUTION=true. Inlines InlineFileDrop +
 * PayAndExecuteButton sub-components per the essential-files mandate (each
 * is <50 LOC and tightly coupled to chat state — splitting would inflate
 * file count without improving SOLID).
 *
 * Flow:
 *   1. User types intent → POST /v3/arbloop/concierge/search.
 *   2. Render top-3 candidates with mode chip (X402 / LOOP / FREE-PREVIEW).
 *   3. User clicks a candidate → reveals InlineFileDrop or text input.
 *   4. User drops file → encrypt client-side (clientCrypto) + Pinata put +
 *      Fhenix encrypt of AES key.
 *   5. Click Pay & Run → useX402Pay() runs the 402 dance + invoke.
 *   6. After 200 OK, show "Decrypt & Download" button (useFheJobResults).
 *
 * SOLID: SRP — one component owns the chat conversation state. The two
 * sub-components are inline because they share the same render tree and
 * splitting would add files without improving cohesion.
 */

import { useEffect, useRef, useState } from 'react';
import { useAccount } from 'wagmi';
import {
  aesGcmEncrypt,
  fhenixEncryptAesKey,
  ipfsPut,
  cidToBytes32,
} from '@fhe-ai-context/sdk';
import { ARBLOOP_API_URL } from '@/lib/arbloop';
import { useX402Pay } from '@/hooks/useX402Pay';
import { useFheJobResults } from '@/hooks/useFheJobResults';

interface Candidate {
  agent_id: string;
  title: string;
  short_description?: string | null;
  score: number;
  reason: string;
  mode: 'x402' | 'loop' | 'free';
  pricing: Record<string, string | null>;
}

interface ConciergeResult {
  intent: { capability: string; needs_memory: boolean };
  candidates: Candidate[];
  explain: string;
}

interface InvokeResult {
  ok: boolean;
  agent_id: number;
  response_cid: string;
  enc_response_handle: `0x${string}`;
  response_iv: `0x${string}`;
  settlement_tx: `0x${string}`;
}

const PLACEHOLDERS = [
  'Translate this NDA to Vietnamese',
  'Summarize a 50-page contract',
  'Extract invoice line items from a PDF',
];

const HISTORY_KEY = 'arbloop:concierge:history:v1';

export function ConciergeChat() {
  const { address } = useAccount();
  const [demand, setDemand] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConciergeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [placeholderIdx, setPlaceholderIdx] = useState(0);

  // Rotate placeholder examples (Task 6.x copy refresh).
  useEffect(() => {
    const t = setInterval(() => setPlaceholderIdx((i) => (i + 1) % PLACEHOLDERS.length), 4000);
    return () => clearInterval(t);
  }, []);

  // localStorage history (F6 reflexive loop, client-side).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) setHistory((JSON.parse(raw) as string[]).slice(0, 20));
    } catch { /* ignore */ }
  }, []);

  function appendHistory(q: string) {
    const next = [q, ...history.filter((h) => h !== q)].slice(0, 20);
    setHistory(next);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }

  async function search() {
    const message = demand.trim();
    if (!message) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${ARBLOOP_API_URL}/v3/arbloop/concierge/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message,
          buyer_address: address ?? undefined,
          session_id: typeof window !== 'undefined' ? localStorage.getItem('arbloop:sid') ?? '' : '',
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as ConciergeResult;
      setResult(j);
      appendHistory(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="mx-auto max-w-3xl">
        <form
          onSubmit={(e) => { e.preventDefault(); search(); }}
          className="glass-panel rounded-xl p-4 transition-shadow focus-within:x-blue-glow"
        >
          <div className="mb-3 flex items-center gap-2 border-b border-white/5 pb-2">
            <span className="material-symbols-outlined text-[18px] text-primary">terminal</span>
            <span className="font-mono text-xs uppercase tracking-wider text-on-surface-variant">
              Chat to find · Fhenix encrypted · 1-sig pay
            </span>
            {result && (
              <button type="button"
                onClick={() => { setResult(null); setDemand(''); }}
                className="ml-auto rounded border border-outline-variant/40 px-2 py-1 font-mono text-[10px] uppercase">
                Clear
              </button>
            )}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <textarea
              value={demand}
              onChange={(e) => setDemand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); search(); }
              }}
              placeholder={PLACEHOLDERS[placeholderIdx]}
              rows={3}
              className="min-h-[72px] w-full resize-none rounded bg-transparent text-base text-on-surface placeholder:text-outline focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || !demand.trim()}
              className="inline-flex items-center justify-center gap-2 rounded bg-primary px-4 py-2 font-medium text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:self-end"
            >
              <span className={`material-symbols-outlined text-[18px] ${busy ? 'animate-spin' : ''}`}>
                {busy ? 'progress_activity' : 'send'}
              </span>
              {busy ? 'Searching…' : 'Match'}
            </button>
          </div>
          {history.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-white/5 pt-2">
              {history.slice(0, 5).map((h) => (
                <button key={h} type="button"
                  onClick={() => setDemand(h)}
                  className="rounded-full border border-outline-variant/30 px-2 py-0.5 font-mono text-[10px] text-on-surface-variant hover:text-primary">
                  {h.length > 40 ? `${h.slice(0, 37)}…` : h}
                </button>
              ))}
            </div>
          )}
        </form>
        {error && <p className="mt-3 text-center text-sm text-amber-500">{error}</p>}
      </div>

      {result && result.candidates.length > 0 && (
        <section className="mx-auto max-w-3xl space-y-3">
          <h2 className="font-headline text-sm font-semibold text-on-surface-variant">
            Top {result.candidates.length} matches · {result.intent.capability}
          </h2>
          <div className="space-y-3">
            {result.candidates.slice(0, 3).map((c) => (
              <CandidateCard key={c.agent_id} candidate={c} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Inline sub-components (per essential-files mandate) ─────────────────

function CandidateCard({ candidate }: { candidate: Candidate }) {
  const [expanded, setExpanded] = useState(false);
  const modeColor = candidate.mode === 'x402'
    ? 'bg-secondary/15 text-secondary border-secondary/30'
    : candidate.mode === 'loop' ? 'bg-primary/15 text-primary border-primary/30'
    : 'bg-outline/15 text-on-surface-variant border-outline/30';
  return (
    <div className="rounded-xl border border-outline-variant/30 bg-surface p-4 hover:border-primary/40">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${modeColor}`}>
              {candidate.mode}
            </span>
            <h3 className="font-headline text-base font-semibold">{candidate.title}</h3>
            <span className="ml-auto font-mono text-[11px] text-on-surface-variant">
              {(candidate.score * 100).toFixed(0)}% · ${(Number(candidate.pricing.x402 ?? 1500000) / 1e6).toFixed(2)}
            </span>
          </div>
          {candidate.short_description && (
            <p className="text-sm text-on-surface-variant">{candidate.short_description}</p>
          )}
          {candidate.reason && (
            <p className="text-xs italic text-on-surface-variant">"{candidate.reason}"</p>
          )}
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        {candidate.mode === 'loop' ? (
          <a href={`/arbloop/compose?agent=${candidate.agent_id}`}
            className="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-on-primary">
            Hire as loop →
          </a>
        ) : (
          <button
            onClick={() => setExpanded(!expanded)}
            className="rounded-full bg-secondary px-4 py-1.5 text-sm font-medium text-on-primary">
            {expanded ? 'Cancel' : 'Use this →'}
          </button>
        )}
      </div>
      {expanded && candidate.mode === 'x402' && (
        <PayAndExecutePanel candidate={candidate} />
      )}
    </div>
  );
}

function PayAndExecutePanel({ candidate }: { candidate: Candidate }) {
  const { address } = useAccount();
  const { pay, isLoading: paying, error: payError } = useX402Pay();
  const { decryptAndDownload, isLoading: decrypting, error: decryptError } = useFheJobResults();
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [invokeResult, setInvokeResult] = useState<InvokeResult | null>(null);
  const [stage, setStage] = useState<'idle' | 'encrypting' | 'paying' | 'done'>('idle');
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function payAndRun() {
    if (!address) { alert('Connect wallet first'); return; }
    setStage('encrypting');
    let inputs: Record<string, unknown> = { text };
    if (file) {
      // Encrypt file client-side; upload to Pinata via signed-upload endpoint.
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      const enc = await aesGcmEncrypt(fileBytes);
      // For v0.0 the API exposes a signed-upload endpoint; using
      // pinataJwt directly only in trusted Node-side scripts.
      const cid = await ipfsPut({
        bytes: enc.ciphertext,
        signedUploadEndpoint: `${ARBLOOP_API_URL}/v3/arbloop/ipfs/upload`,
        filename: file.name,
      });
      const ctxAddr = (process.env.NEXT_PUBLIC_ARBLOOP_CONFIDENTIAL_AI_CONTEXT_V2_ADDRESS ?? '0x0') as `0x${string}`;
      const handle = await fhenixEncryptAesKey(enc.key, ctxAddr, address as `0x${string}`);
      inputs = {
        text: text || `process: ${file.name}`,
        source_doc_ipfs_cid: cid,
        source_doc_aes_key_handle: handle.handle,
        source_doc_iv: '0x' + Array.from(enc.iv).map(b => b.toString(16).padStart(2, '0')).join(''),
      };
    }

    setStage('paying');
    try {
      const r = await pay<InvokeResult>({
        url: `/v3/arbloop/agents/${candidate.agent_id}/invoke`,
        body: inputs,
      });
      if (r.data?.ok) { setInvokeResult(r.data); setStage('done'); }
      else throw new Error('invoke_failed');
    } catch {
      setStage('idle');
    }
  }

  async function downloadResult() {
    if (!invokeResult || !address) return;
    const ctxAddr = (process.env.NEXT_PUBLIC_ARBLOOP_CONFIDENTIAL_AI_CONTEXT_V2_ADDRESS ?? '0x0') as `0x${string}`;
    await decryptAndDownload({
      responseCid: invokeResult.response_cid,
      encResponseHandle: invokeResult.enc_response_handle,
      responseIv: invokeResult.response_iv,
      contextV2Address: ctxAddr,
      buyerAddress: address as `0x${string}`,
      filename: `arbloop-${candidate.agent_id}-result.txt`,
      mimeType: 'text/plain',
    });
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-outline-variant/20 bg-surface-container-low p-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What should the agent do? (optional if you upload a file)"
        rows={2}
        className="w-full rounded border border-outline-variant/30 bg-surface px-2 py-1 text-sm"
      />
      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.txt,.docx,.md"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="hidden"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1 rounded border border-outline-variant/30 px-2 py-1 text-xs">
          <span className="material-symbols-outlined text-[14px]">attach_file</span>
          {file ? file.name : 'Drop file'}
        </button>
        <button
          onClick={payAndRun}
          disabled={paying || stage === 'encrypting' || (!text && !file)}
          className="ml-auto rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-on-primary disabled:opacity-50">
          {stage === 'encrypting' ? 'Encrypting…' : stage === 'paying' ? 'Paying…' : 'Pay & Run'}
        </button>
      </div>
      {(payError || decryptError) && (
        <p className="text-xs text-amber-500">{payError ?? decryptError}</p>
      )}
      {invokeResult && (
        <div className="space-y-2 rounded border border-secondary/30 bg-secondary/5 p-2">
          <p className="text-xs">✓ Settled in tx <code className="font-mono">{invokeResult.settlement_tx.slice(0, 10)}…</code></p>
          <button
            onClick={downloadResult}
            disabled={decrypting}
            className="w-full rounded-full bg-secondary px-4 py-1.5 text-sm font-medium text-on-primary disabled:opacity-50">
            {decrypting ? 'Decrypting…' : 'Decrypt & Download'}
          </button>
        </div>
      )}
    </div>
  );
}
