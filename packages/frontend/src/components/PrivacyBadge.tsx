'use client';

/**
 * PrivacyBadge — buyer-side trust signal (Arbitrum-only).
 *
 * Renders one of two badges based on PrivacyMode:
 *   'fhe'           → "Encrypted at rest · Fhenix" (X-Blue surface-tint chip)
 *   'metadata-only' → "Metadata redacted"          (subtle outline)
 *   'off'           → null (no badge)
 *
 * SOLID:
 *  - SRP: render-only. No data fetching, no state.
 *  - OCP: adding a new mode = one entry in BADGES; the component stays.
 */

import type { PrivacyMode } from '@fhe-ai-context/sdk';

interface BadgeSpec {
  label: string;
  tooltip: string;
  className: string;
}

const BADGES: Record<Exclude<PrivacyMode, 'off'>, BadgeSpec> = {
  fhe: {
    label: 'Encrypted · Fhenix',
    tooltip:
      'The platform holds an FHE-wrapped symmetric key on Fhenix CoFHE. Buyer pays, seller-permit unlocks the key, inference runs in plaintext on the platform.',
    className:
      'border-[var(--color-surface-tint,_#00dbe9)] bg-[color-mix(in_oklab,_#00dbe9_8%,_transparent)] text-[var(--color-primary,_#dbfcff)]',
  },
  'metadata-only': {
    label: 'Metadata redacted',
    tooltip: 'PII fields are regex-redacted before storage. Plaintext content otherwise.',
    className: 'border-outline-variant/40 bg-surface-container-low text-on-surface-variant',
  },
};

export function PrivacyBadge({ mode }: { mode: PrivacyMode }) {
  if (mode === 'off') return null;
  const spec = BADGES[mode];
  return (
    <span
      title={spec.tooltip}
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${spec.className}`}
    >
      {spec.label}
    </span>
  );
}
