'use client';

import Link from 'next/link';

/**
 * MarketplaceCard — single-tier (Arbitrum) discriminated card. The four
 * product types share one ProductRoot shape on the API; this card is the
 * UI mirror of that pattern.
 */
export type MarketplaceCardType = 'brain' | 'skill' | 'workflow' | 'reflective';

export interface MarketplaceCardProps {
  type: MarketplaceCardType;
  id: string | number;
  title: string;
  description?: string;
  priceUsdc: string;
  meta?: {
    stepCount?: number;
    runs?: number;
    successRate?: number;
    tags?: string[];
    domain?: 'marketing' | 'finance' | 'research' | 'engineering' | 'generalist' | 'other';
    verification_tier?: 'basic' | 'verified' | 'tee_attested';
    licensesSold?: number;
  };
}

const TYPE_THEME: Record<MarketplaceCardType, { icon: string; color: string; verb: string }> = {
  brain:      { icon: 'psychology',     color: 'text-primary',   verb: 'Ask' },
  skill:      { icon: 'build',          color: 'text-tertiary',  verb: 'Invoke' },
  workflow:   { icon: 'account_tree',   color: 'text-secondary', verb: 'Run' },
  reflective: { icon: 'auto_awesome',   color: 'text-amber-500', verb: 'License' },
};

export function MarketplaceCard(props: MarketplaceCardProps) {
  const theme = TYPE_THEME[props.type];

  const targetHref =
    props.type === 'brain' ? `/agent/${props.id}` :
    `/marketplace?type=${props.type}&id=${props.id}`;

  return (
    <Link
      href={targetHref}
      className="encryption-glow group flex h-full flex-col gap-3 rounded-xl border border-outline-variant/30 bg-surface p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 ${theme.color}`}>
          <span className="material-symbols-outlined text-[20px]">{theme.icon}</span>
        </div>
        <span className="inline-flex flex-wrap items-center justify-end gap-1">
          <span className="inline-flex items-center gap-1 rounded-full border border-outline-variant/40 bg-surface-variant/40 px-2 py-0.5 font-mono text-[10px] uppercase text-on-surface-variant">
            {props.type}
          </span>
          {props.meta?.domain && (
            <span className="matrix-chip rounded px-1.5 py-0.5 font-mono text-[10px] uppercase">
              {props.meta.domain}
            </span>
          )}
          {props.meta?.verification_tier && props.meta.verification_tier !== 'basic' && (
            <span className="inline-flex items-center gap-0.5 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-primary">
              <span className="material-symbols-outlined text-[12px]" aria-hidden>verified</span>
              {props.meta.verification_tier === 'tee_attested' ? 'TEE' : 'Verified'}
            </span>
          )}
        </span>
      </div>

      <div className="space-y-1">
        <h3 className="font-headline text-base font-semibold leading-snug text-on-surface group-hover:text-primary">
          {props.title}
        </h3>
        {props.description ? (
          <p className="line-clamp-2 text-sm text-on-surface-variant">{props.description}</p>
        ) : null}
      </div>

      <div className="mt-auto flex items-center justify-between text-xs text-on-surface-variant">
        <div className="flex items-center gap-2">
          {props.type === 'workflow' && props.meta?.stepCount !== undefined && (
            <span>{props.meta.stepCount} steps</span>
          )}
          {props.type === 'workflow' && props.meta?.runs !== undefined && (
            <span>· {props.meta.runs} runs</span>
          )}
          {props.type === 'reflective' && props.meta?.licensesSold !== undefined && (
            <span>{props.meta.licensesSold} licenses sold</span>
          )}
          {props.type === 'brain' && props.meta?.tags?.[0] && (
            <span>{props.meta.tags.slice(0, 2).join(' · ')}</span>
          )}
        </div>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-primary">
          ${Number(props.priceUsdc).toFixed(2)} · {theme.verb}
        </span>
      </div>
    </Link>
  );
}
