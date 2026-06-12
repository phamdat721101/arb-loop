'use client';

/**
 * /brain — Cognitive Memory v1 surface.
 *
 * Owner-only page. Three lanes (Episodes / Facts / Skills) on top of the
 * /v4/cognitive/* endpoints, polled every 3s. Visible cognition: every L1
 * write, L2 derivation, L3 mint produces an animation moment via
 * BrainActivityFeed.
 *
 * Privacy boundary: this page calls owner-gated routes only. Plaintext
 * fields (body, fact, steps) come from the server when x-wallet-address
 * matches; otherwise they're undefined and cards render the 🔒 state.
 */

import { useEffect, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { usePrivyEvmAddress } from '@/hooks/useActiveWallet';
import { useCognitive } from '@/lib/cognitive';
import { EpisodeLane, FactLane, SkillLane } from '@/components/CognitiveLanes';
import { BrainActivityFeed } from '@/components/BrainActivityFeed';

type Lane = 'episodes' | 'facts' | 'skills';
const LANES: Lane[] = ['episodes', 'facts', 'skills'];
const HINT_KEY = 'openx:brain-explainer-dismissed';

export default function BrainPage() {
  const { user, authenticated, login } = usePrivy();
  const addr = usePrivyEvmAddress();
  const cognitive = useCognitive(authenticated && addr ? addr : undefined);
  const [lane, setLane] = useState<Lane>('episodes');
  const [explainerDismissed, setExplainerDismissed] = useState(true); // hydrate-safe

  useEffect(() => {
    try {
      setExplainerDismissed(window.localStorage.getItem(HINT_KEY) === '1');
    } catch {
      /* ignore */
    }
  }, []);

  // URL ?lane=... binding for shareable deep-links.
  useEffect(() => {
    try {
      const fromUrl = new URL(window.location.href).searchParams.get('lane');
      if (fromUrl && (LANES as string[]).includes(fromUrl)) setLane(fromUrl as Lane);
    } catch {
      /* ignore */
    }
  }, []);
  const switchLane = (next: Lane) => {
    setLane(next);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('lane', next);
      window.history.replaceState({}, '', u.toString());
    } catch {
      /* ignore */
    }
  };

  if (!authenticated) {
    return (
      <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-12 text-center">
        <span className="material-symbols-outlined mb-3 text-5xl text-on-surface-variant">
          psychology
        </span>
        <h1 className="font-headline text-2xl font-bold">Your brain — owner-only.</h1>
        <p className="mt-2 text-sm text-on-surface-variant">
          Sign in with your wallet to see your encrypted Episodes, derived Facts, and minted Skills.
        </p>
        <button
          type="button"
          onClick={login}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary hover:opacity-90"
        >
          <span className="material-symbols-outlined text-[18px]">login</span>
          Sign in
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <BrainActivityFeed
        episodes={cognitive.episodes}
        facts={cognitive.facts}
        skills={cognitive.skills}
        freshEpisodeIds={cognitive.freshEpisodeIds}
        freshFactIds={cognitive.freshFactIds}
        freshSkillIds={cognitive.freshSkillIds}
        isLive={cognitive.isLive}
      />

      {!explainerDismissed && (
        <div className="rounded-xl border border-secondary/30 bg-secondary/5 p-4 text-sm">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-secondary">psychology</span>
            <div className="flex-1 space-y-2">
              <p>
                Your brain has <strong>three layers</strong>. Every paid agent query writes an
                encrypted <strong>Episode</strong> (L1). When 3+ episodes share a topic, the
                consolidator derives a signed <strong>Fact</strong> (L2). When 5+ facts share a
                procedure, the promoter mints a runnable <strong>Skill</strong> (L3) that other
                agents can rent.
              </p>
              <p className="text-xs text-on-surface-variant">
                All three layers are AES-256-GCM encrypted; keys are derived per-(you, layer) and
                rotate independently. Phase 1 is free for all queries; per-skill prices show as
                <strong> target</strong> chips today.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                try {
                  window.localStorage.setItem(HINT_KEY, '1');
                } catch {
                  /* ignore */
                }
                setExplainerDismissed(true);
              }}
              className="rounded p-1 text-on-surface-variant hover:bg-surface-container"
              aria-label="Dismiss"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        </div>
      )}

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-headline text-2xl font-bold">Your brain</h1>
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-primary">
            cognitive memory v1
          </span>
        </div>
        <dl className="grid grid-cols-3 gap-4 text-xs">
          <Stat label="episodes" value={cognitive.episodes.length} />
          <Stat label="facts" value={cognitive.facts.length} />
          <Stat label="skills" value={cognitive.skills.length} />
        </dl>
      </header>

      <nav className="inline-flex rounded-full border border-outline-variant/40 p-0.5 font-mono text-[11px]">
        {LANES.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => switchLane(l)}
            className={`rounded-full px-3 py-1 transition-colors ${
              lane === l ? 'bg-primary/15 text-primary' : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            {l}
          </button>
        ))}
      </nav>

      {lane === 'episodes' && (
        <EpisodeLane rows={cognitive.episodes} freshIds={cognitive.freshEpisodeIds} />
      )}
      {lane === 'facts' && (
        <FactLane
          rows={cognitive.facts}
          freshIds={cognitive.freshFactIds}
          episodes={cognitive.episodes}
        />
      )}
      {lane === 'skills' && (
        <SkillLane rows={cognitive.skills} freshIds={cognitive.freshSkillIds} walletAddress={addr} />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-outline-variant/30 bg-surface p-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
        {label}
      </div>
      <div className="font-headline text-lg font-bold">{value}</div>
    </div>
  );
}
