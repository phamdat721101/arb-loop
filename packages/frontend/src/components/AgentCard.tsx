import Link from 'next/link';

export interface AgentCardProps {
  id: number | string;
  title: string;
  description: string;
  tags?: string[];
  ownerAddress?: string;
  price?: { amount: string; currency: string };
  /** Override default `/agent/[id]` link target. */
  href?: string;
  /** When set, the card surfaces "Pay-per-call · /api/v1/<slug>". */
  slug?: string;
  /** When true, marks the card with a "Confidential mode" pill. */
  acceptsPrivate?: boolean;
}

export function AgentCard({
  id,
  title,
  description,
  tags = [],
  ownerAddress,
  price,
  href,
  slug,
  acceptsPrivate,
}: AgentCardProps) {
  const target = href ?? `/agent/${id}`;
  return (
    <Link
      href={target}
      className="encryption-glow group flex h-full flex-col gap-3 rounded-xl border border-outline-variant/30 bg-surface p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <span className="material-symbols-outlined text-[20px]">smart_toy</span>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full border border-secondary/30 bg-secondary/10 px-2 py-0.5 font-mono text-[10px] text-secondary">
          <span className="material-symbols-outlined text-[12px]">verified_user</span>
          FHE
        </span>
      </div>

      <div className="space-y-1">
        <h3 className="font-headline text-base font-semibold leading-snug text-on-surface group-hover:text-primary">
          {title}
        </h3>
        <p className="line-clamp-2 text-sm text-on-surface-variant">{description}</p>
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-outline-variant/40 px-2 py-0.5 font-mono text-[10px] text-on-surface-variant"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-end justify-between gap-2 pt-2">
        {ownerAddress ? (
          <span className="font-mono text-[11px] text-on-surface-variant">
            {ownerAddress.slice(0, 6)}…{ownerAddress.slice(-4)}
          </span>
        ) : (
          <span />
        )}
        {price ? (
          <span className="font-headline text-sm font-semibold text-on-surface">
            {price.amount}
            <span className="ml-1 font-mono text-[10px] uppercase text-on-surface-variant">
              {price.currency}
            </span>
            <span className="ml-1 font-mono text-[10px] text-on-surface-variant">/call</span>
          </span>
        ) : (
          <span className="font-mono text-[10px] uppercase text-on-surface-variant">
            Free preview
          </span>
        )}
      </div>

      {(slug || acceptsPrivate) && (
        <div className="flex flex-wrap items-center gap-1 border-t border-outline-variant/20 pt-2">
          {slug && (
            <span className="font-mono text-[10px] text-on-surface-variant">/api/v1/{slug}</span>
          )}
          {acceptsPrivate && (
            <span className="ml-auto rounded-full border border-tertiary/30 bg-tertiary/10 px-2 py-0.5 font-mono text-[9px] text-tertiary">
              CONFIDENTIAL OK
            </span>
          )}
        </div>
      )}
    </Link>
  );
}
