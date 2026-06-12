'use client';

/**
 * CognitiveLanes — three lane renderers for /brain page.
 *
 * SRP at the module level: this file owns the lane visuals. The page
 * assembles them; the activity feed (BrainActivityFeed) owns cross-cutting
 * "global" UI (level-up modal, thinking indicator, derivation overlay).
 *
 * Visual rules per the locked PRDs:
 *   - Each card uses the 3-state lock pattern: 🔒 (no plaintext) / ✓ decrypted
 *     (plaintext present). The intermediate "🔓 decrypting" state is only
 *     visible during permit signing — Phase 1 has no permit dance, so we
 *     elide that state and rely on the server returning plaintext for owners.
 *   - "Fresh" rows (just appeared since last poll) get an `animate-in
 *     slide-in-from-top duration-500` entrance animation, plus a "✨ just
 *     learned" / "✨ NEW" badge that fades after the row settles.
 *   - Empty lanes show a tutorial, not a "no data yet".
 */

import { useState } from 'react';
import { runSkill, type EpisodeRow, type FactRow, type SkillRow } from '@/lib/cognitive';

// ─── Episodes Lane ──────────────────────────────────────────────────────────

export function EpisodeLane({
  rows,
  freshIds,
}: {
  rows: EpisodeRow[];
  freshIds: Set<string>;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        emoji="🌱"
        title="Your Episodes lane is fresh"
        body="Ask your demo agent something — every paid agent query is recorded here as an encrypted episode (TTL 7 days)."
      />
    );
  }
  return (
    <div className="grid gap-3">
      {rows.map((e) => {
        const isFresh = freshIds.has(e.id);
        return (
          <div
            key={e.id}
            className={`rounded-xl border bg-surface p-4 transition-all ${
              isFresh
                ? 'border-primary/60 ring-2 ring-primary/30 animate-in slide-in-from-top duration-500'
                : 'border-outline-variant/30'
            }`}
          >
            <div className="flex items-start gap-3">
              <span
                className={`material-symbols-outlined text-[20px] ${
                  e.body ? 'text-secondary' : 'text-on-surface-variant'
                }`}
                title={e.body ? 'Decrypted in this tab (you are the owner)' : 'Encrypted at rest — server returned ciphertext'}
              >
                {e.body ? 'lock_open' : 'lock'}
              </span>
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                  <span>topic {e.topic}</span>
                  <span>·</span>
                  <span>agent {e.agentId.slice(0, 8)}…</span>
                  <span>·</span>
                  <span>{relativeTime(e.createdAt)}</span>
                  {isFresh && (
                    <span className="ml-auto rounded-full bg-primary/15 px-2 py-0.5 text-[9px] font-bold text-primary">
                      ✨ NEW
                    </span>
                  )}
                </div>
                {e.body ? (
                  <p className="text-sm text-on-surface line-clamp-3">{e.body}</p>
                ) : (
                  <p className="text-sm text-on-surface-variant italic">
                    🔒 encrypted · {e.payloadHex.length / 2} bytes ciphertext
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Facts Lane ─────────────────────────────────────────────────────────────

export function FactLane({
  rows,
  freshIds,
  episodes,
}: {
  rows: FactRow[];
  freshIds: Set<string>;
  episodes: EpisodeRow[];
}) {
  const [openDerivation, setOpenDerivation] = useState<FactRow | null>(null);
  if (rows.length === 0) {
    return (
      <EmptyState
        emoji="💭"
        title="Facts derive automatically"
        body="When 3+ episodes share a topic, the consolidator emits a single semantic fact — encrypted, signed, graph-linked back to its sources."
      />
    );
  }
  return (
    <>
      <div className="grid gap-3">
        {rows.map((f) => {
          const isFresh = freshIds.has(f.id);
          const conf = f.confidence;
          const confColor = conf >= 85 ? 'text-secondary' : conf >= 70 ? 'text-amber-500' : 'text-on-surface-variant';
          return (
            <div
              key={f.id}
              className={`rounded-xl border bg-surface p-4 transition-all ${
                isFresh
                  ? 'border-secondary/60 ring-2 ring-secondary/30 animate-in slide-in-from-top duration-500'
                  : 'border-outline-variant/30'
              }`}
            >
              <div className="flex items-start gap-3">
                <span
                  className="material-symbols-outlined text-[20px] text-secondary"
                  title="Derived under your Fhenix permit"
                >
                  psychology
                </span>
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                    <span>{f.factType}</span>
                    <span>·</span>
                    <span>topic {f.topic}</span>
                    <span>·</span>
                    <span className={confColor}>conf {conf}%</span>
                    <span>·</span>
                    <span>{relativeTime(f.createdAt)}</span>
                    {isFresh && (
                      <span className="ml-auto rounded-full bg-secondary/15 px-2 py-0.5 text-[9px] font-bold text-secondary">
                        ✨ just derived
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-on-surface">
                    {f.fact ?? <span className="italic text-on-surface-variant">🔒 encrypted</span>}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[10px]">
                    <button
                      type="button"
                      onClick={() => setOpenDerivation(f)}
                      className="rounded-full border border-outline-variant/40 px-2 py-0.5 font-mono text-on-surface-variant hover:border-secondary/40 hover:text-secondary"
                    >
                      derived from {f.derivedFrom.length} episodes →
                    </button>
                    {f.procedureKey && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-primary">
                        proc · {f.procedureKey}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {openDerivation && (
        <DerivationModal
          fact={openDerivation}
          episodes={episodes}
          onClose={() => setOpenDerivation(null)}
        />
      )}
    </>
  );
}

function DerivationModal({
  fact,
  episodes,
  onClose,
}: {
  fact: FactRow;
  episodes: EpisodeRow[];
  onClose: () => void;
}) {
  const matches = episodes.filter((e) => fact.derivedFrom.includes(e.id));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 animate-in fade-in duration-200">
      <div className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-xl border border-secondary/40 bg-surface p-6">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-secondary">derivation graph</div>
            <h3 className="font-headline text-lg font-semibold">{fact.fact ?? '🔒 encrypted'}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-on-surface-variant hover:bg-surface-container"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
        <div className="space-y-2">
          <p className="text-xs text-on-surface-variant">
            This fact was derived from <strong>{fact.derivedFrom.length}</strong> source episodes (3 minimum threshold).
          </p>
          {matches.length === 0 ? (
            <p className="text-sm italic text-on-surface-variant">
              The source episodes have already expired (TTL 7 days) — only the derived fact is preserved.
            </p>
          ) : (
            matches.map((e) => (
              <div key={e.id} className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-3">
                <div className="font-mono text-[10px] text-on-surface-variant">
                  agent {e.agentId.slice(0, 8)}… · {relativeTime(e.createdAt)}
                </div>
                <p className="mt-1 text-sm">{e.body ?? '🔒 encrypted'}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Skills Lane ────────────────────────────────────────────────────────────

export function SkillLane({
  rows,
  freshIds,
  walletAddress,
}: {
  rows: SkillRow[];
  freshIds: Set<string>;
  walletAddress: string | undefined;
}) {
  const [openRun, setOpenRun] = useState<SkillRow | null>(null);
  if (rows.length === 0) {
    return (
      <EmptyState
        emoji="⚡"
        title="Skills graduate automatically"
        body="When 5+ facts share a procedure key, the promoter mints a runnable, signed, encrypted skill bundle. Each run carries a Phala TEE attestation."
      />
    );
  }
  return (
    <>
      <div className="grid gap-3">
        {rows.map((s) => {
          const isFresh = freshIds.has(s.id);
          return (
            <div
              key={s.id}
              className={`rounded-xl border bg-surface p-4 transition-all ${
                isFresh
                  ? 'border-primary/60 ring-2 ring-primary/30 animate-in slide-in-from-top duration-500'
                  : 'border-outline-variant/30'
              }`}
            >
              <div className="flex items-start gap-3">
                <span
                  className="material-symbols-outlined text-[20px] text-primary"
                  title="Runs in Phala TEE — attested per execution"
                >
                  bolt
                </span>
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <h4 className="font-headline text-sm font-semibold">{s.procedureKey}</h4>
                    {isFresh && (
                      <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[9px] font-bold text-primary">
                        ✨ NEW
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-on-surface-variant">
                    <span>derived from {s.derivedFrom.length} facts</span>
                    <span>·</span>
                    <span>{s.runCount} runs</span>
                    <span>·</span>
                    <span>{relativeTime(s.createdAt)}</span>
                  </div>
                  {/* Target-price chip per locked option-1 */}
                  <div className="inline-flex items-center gap-1 rounded-full border border-outline-variant/40 bg-surface-container-low px-2 py-1 text-[10px]">
                    <span className="text-on-surface-variant">now:</span>
                    <span className="font-mono text-secondary">free</span>
                    <span className="text-on-surface-variant">·</span>
                    <span className="text-on-surface-variant">target:</span>
                    <span className="font-mono text-primary">{s.defaultPriceUsdc} USDC/run</span>
                  </div>
                  {s.steps && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-on-surface-variant hover:text-on-surface">
                        manifest ({s.steps.length} steps)
                      </summary>
                      <ol className="mt-2 list-decimal space-y-1 pl-5">
                        {s.steps.map((st, i) => (
                          <li key={i} className="text-on-surface-variant">
                            <strong className="text-on-surface">{st.name}</strong> — {st.description}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setOpenRun(s)}
                      className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-[11px] font-medium text-on-primary hover:opacity-90"
                    >
                      <span className="material-symbols-outlined text-[14px]">play_arrow</span>
                      Run skill
                    </button>
                    {s.lastAttestation && (
                      <span className="inline-flex items-center gap-1 font-mono text-[10px] text-on-surface-variant">
                        last attestation
                        <code className="rounded bg-surface-container px-1 text-[10px]">
                          {s.lastAttestation.slice(0, 12)}…
                        </code>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {openRun && (
        <RunSkillModal skill={openRun} walletAddress={walletAddress} onClose={() => setOpenRun(null)} />
      )}
    </>
  );
}

function RunSkillModal({
  skill,
  walletAddress,
  onClose,
}: {
  skill: SkillRow;
  walletAddress: string | undefined;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ result: unknown; attestation: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!walletAddress) {
      setError('Connect a wallet first');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await runSkill(skill.id, walletAddress, input);
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-xl rounded-xl border border-primary/40 bg-surface p-6">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-primary">run skill</div>
            <h3 className="font-headline text-lg font-semibold">{skill.procedureKey}</h3>
            <p className="text-xs text-on-surface-variant">
              Phase 1: free · Target price: {skill.defaultPriceUsdc} USDC/run
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-on-surface-variant hover:bg-surface-container"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {!result ? (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-on-surface-variant">Input</label>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder='{"input": "..."}'
                rows={4}
                className="w-full rounded-lg border border-outline-variant/40 bg-surface-container px-3 py-2 font-mono text-xs focus:border-primary/60 focus:outline-none"
              />
            </div>
            {error && <p className="text-xs text-error">{error}</p>}
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="w-full rounded-full bg-primary py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Running in TEE…' : 'Run'}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-secondary/30 bg-secondary/5 p-3">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-secondary">
                🛡️ attested result
              </div>
              <pre className="overflow-auto text-xs">{JSON.stringify(result.result, null, 2)}</pre>
            </div>
            <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-3 font-mono text-[10px]">
              <div className="text-on-surface-variant">attestation hash</div>
              <code className="break-all text-on-surface">{result.attestation}</code>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Shared empty state ─────────────────────────────────────────────────────

function EmptyState({ emoji, title, body }: { emoji: string; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-10 text-center">
      <div className="mb-2 text-3xl">{emoji}</div>
      <p className="font-headline font-semibold">{title}</p>
      <p className="mt-1 text-sm text-on-surface-variant">{body}</p>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
