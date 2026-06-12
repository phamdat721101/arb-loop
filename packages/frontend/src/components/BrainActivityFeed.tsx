'use client';

/**
 * BrainActivityFeed — sticky panel + level-up modal + cross-lane events.
 *
 * SRP: this file owns the global cognitive UI events that aren't tied to a
 * single lane: (a) a chronological feed of the last 10 events across L1/L2/L3,
 * (b) the L3 mint celebration ("your brain leveled up!"), (c) the toast
 * announcer for L2 derivations.
 *
 * It renders zero state if there's no addr (no wallet connected).
 *
 * The feed itself derives from the in-memory arrays passed by the parent —
 * no extra API calls. The L3 mint modal fires once per session per skill id
 * (we de-dupe via a ref so re-renders don't replay it).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { EpisodeRow, FactRow, SkillRow } from '@/lib/cognitive';

interface ActivityEvent {
  kind: 'episode' | 'fact' | 'skill';
  id: string;
  createdAt: string;
  summary: string;
  isFresh: boolean;
}

export function BrainActivityFeed({
  episodes,
  facts,
  skills,
  freshEpisodeIds,
  freshFactIds,
  freshSkillIds,
  isLive,
}: {
  episodes: EpisodeRow[];
  facts: FactRow[];
  skills: SkillRow[];
  freshEpisodeIds: Set<string>;
  freshFactIds: Set<string>;
  freshSkillIds: Set<string>;
  isLive: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [levelUp, setLevelUp] = useState<SkillRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seenSkills = useRef<Set<string>>(new Set());
  const seenFacts = useRef<Set<string>>(new Set());

  // L3 mint celebration — fires once per fresh skill id.
  useEffect(() => {
    for (const s of skills) {
      if (freshSkillIds.has(s.id) && !seenSkills.current.has(s.id)) {
        seenSkills.current.add(s.id);
        setLevelUp(s);
        // Auto-dismiss after 3.5s (still feels celebratory, doesn't block).
        const t = setTimeout(() => setLevelUp(null), 3500);
        return () => clearTimeout(t);
      }
      seenSkills.current.add(s.id);
    }
  }, [skills, freshSkillIds]);

  // L2 derivation toast — fires for the most recent fresh fact only.
  useEffect(() => {
    for (const f of facts) {
      if (freshFactIds.has(f.id) && !seenFacts.current.has(f.id)) {
        seenFacts.current.add(f.id);
        setToast(f.fact ?? `New fact (encrypted) on topic ${f.topic}`);
        const t = setTimeout(() => setToast(null), 5500);
        return () => clearTimeout(t);
      }
      seenFacts.current.add(f.id);
    }
  }, [facts, freshFactIds]);

  // Build a unified, freshly-sorted feed of the last 10 events.
  const feed = useMemo<ActivityEvent[]>(() => {
    const items: ActivityEvent[] = [];
    for (const e of episodes) {
      items.push({
        kind: 'episode',
        id: e.id,
        createdAt: e.createdAt,
        summary: `agent ${e.agentId.slice(0, 8)}… · topic ${e.topic}`,
        isFresh: freshEpisodeIds.has(e.id),
      });
    }
    for (const f of facts) {
      items.push({
        kind: 'fact',
        id: f.id,
        createdAt: f.createdAt,
        summary: f.fact?.slice(0, 80) ?? `topic ${f.topic} · ${f.factType} · conf ${f.confidence}%`,
        isFresh: freshFactIds.has(f.id),
      });
    }
    for (const s of skills) {
      items.push({
        kind: 'skill',
        id: s.id,
        createdAt: s.createdAt,
        summary: `skill minted: ${s.procedureKey}`,
        isFresh: freshSkillIds.has(s.id),
      });
    }
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return items.slice(0, 10);
  }, [episodes, facts, skills, freshEpisodeIds, freshFactIds, freshSkillIds]);

  return (
    <>
      <div className="sticky top-16 z-30 -mx-4 mb-6 border-b border-outline-variant/30 bg-background/90 backdrop-blur md:-mx-8">
        <div className="mx-auto max-w-6xl px-4 py-2 md:px-8">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="flex w-full items-center gap-2 text-left"
            aria-expanded={!collapsed}
          >
            <span
              className={`relative flex h-2 w-2 rounded-full ${isLive ? 'bg-secondary' : 'bg-on-surface-variant'}`}
            >
              {isLive && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-secondary opacity-75" />
              )}
            </span>
            <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
              brain activity
            </span>
            <span className="font-mono text-[11px] text-on-surface">
              {feed.length === 0 ? 'no events yet' : `${feed.length} recent`}
            </span>
            <span className="ml-auto material-symbols-outlined text-[16px] text-on-surface-variant">
              {collapsed ? 'expand_more' : 'expand_less'}
            </span>
          </button>

          {!collapsed && feed.length > 0 && (
            <ul className="mt-2 grid gap-1 pb-2 text-[11px]">
              {feed.map((ev) => (
                <li
                  key={`${ev.kind}-${ev.id}`}
                  className={`flex items-center gap-2 rounded px-2 py-1 transition-colors ${
                    ev.isFresh ? 'bg-secondary/10' : 'hover:bg-surface-container-low'
                  }`}
                >
                  <span
                    className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[12px] ${
                      ev.kind === 'episode'
                        ? 'bg-primary/15 text-primary'
                        : ev.kind === 'fact'
                          ? 'bg-secondary/15 text-secondary'
                          : 'bg-amber-500/15 text-amber-500'
                    }`}
                  >
                    {ev.kind === 'episode' ? '📥' : ev.kind === 'fact' ? '🧠' : '⚡'}
                  </span>
                  <span className="flex-1 truncate text-on-surface">{ev.summary}</span>
                  <span className="font-mono text-on-surface-variant">{relativeTime(ev.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* L2 toast (bottom-right) */}
      {toast && (
        <div className="pointer-events-none fixed bottom-6 right-6 z-40 max-w-sm animate-in slide-in-from-right duration-500">
          <div className="rounded-lg border border-secondary/40 bg-surface px-4 py-3 shadow-lg">
            <div className="font-mono text-[10px] uppercase tracking-wider text-secondary">
              🧠 your brain just learned
            </div>
            <p className="mt-1 text-sm text-on-surface line-clamp-3">{toast}</p>
          </div>
        </div>
      )}

      {/* L3 level-up modal (full-screen) */}
      {levelUp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-4 animate-in fade-in duration-300">
          <div className="relative w-full max-w-md rounded-2xl border border-primary/50 bg-surface p-8 text-center">
            {/* 12-circle SVG explosion */}
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full"
              viewBox="0 0 200 200"
              aria-hidden
            >
              {Array.from({ length: 12 }).map((_, i) => {
                const angle = (i / 12) * Math.PI * 2;
                const x2 = 100 + Math.cos(angle) * 90;
                const y2 = 100 + Math.sin(angle) * 90;
                return (
                  <circle
                    key={i}
                    cx={100}
                    cy={100}
                    r={4}
                    className="animate-ping fill-primary"
                    style={{
                      transformOrigin: '100px 100px',
                      transform: `translate(${x2 - 100}px, ${y2 - 100}px)`,
                      animationDelay: `${i * 60}ms`,
                      animationDuration: '900ms',
                    }}
                  />
                );
              })}
            </svg>
            <div className="relative">
              <div className="mb-2 text-4xl">🎉</div>
              <h2 className="font-headline text-2xl font-bold">Your brain leveled up!</h2>
              <p className="mt-2 text-sm text-on-surface-variant">
                New skill minted:&nbsp;
                <code className="font-mono text-primary">{levelUp.procedureKey}</code>
              </p>
              <p className="mt-1 font-mono text-[11px] text-on-surface-variant">
                derived from {levelUp.derivedFrom.length} facts · target {levelUp.defaultPriceUsdc} USDC/run
              </p>
              <button
                type="button"
                onClick={() => setLevelUp(null)}
                className="mt-4 rounded-full bg-primary px-4 py-1.5 text-xs font-medium text-on-primary hover:opacity-90"
              >
                See it in Skills lane →
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
