/**
 * Privacy types — Arbitrum-only.
 *
 * Modes: 'fhe' (Fhenix CoFHE on Arbitrum), 'metadata-only', 'off'.
 *
 * SOLID:
 *   - Types are the public contract. No runtime code in this file.
 *   - The router (privacyModeRouter.ts) and detector (networkDetect.ts)
 *     read these types; UI badges (PrivacyBadge.tsx) derive labels
 *     from `tier`, never from raw `mode`.
 */

export type PrivacyMode = 'fhe' | 'metadata-only' | 'off';

/** Human-facing tier label. All Arbitrum modes are 'standard'. */
export type PrivacyTier = 'standard';

/**
 * Whether the mode was auto-detected from the connected wallet's network
 * or manually picked by the seller via the wizard's override radio.
 */
export type PrivacySource = 'auto' | 'manual';

export interface PrivacyConfig {
  mode: PrivacyMode;
  tier?: PrivacyTier;
  source?: PrivacySource;
  metadataFilter?: boolean;
  contextEncryption?: boolean;
}

/** Pure projection — no runtime side-effects. */
export function privacyTierFor(_mode: PrivacyMode): PrivacyTier {
  return 'standard';
}

export interface FilteredMetadata {
  original: string;
  filtered: string;
  redactedFields: string[];
  piiCount: number;
}

export interface SealedPaymentEvent {
  protocol: string;
  chain: string;
  timestamp: number;
  encrypted: {
    urlHash?: `0x${string}`;
    durationMs?: `0x${string}`;
    success?: `0x${string}`;
  };
}

export interface PaymentEvent {
  protocol: string;
  chain: string;
  timestamp: number;
  url: string;
  durationMs: number;
  success: boolean;
  error?: string;
}
