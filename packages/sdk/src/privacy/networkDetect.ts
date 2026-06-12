/**
 * networkDetect — pure-function privacy-mode detection from connected
 * wallet network (Arbitrum-only).
 *
 * No I/O, no side effects, no async. The caller (UI hook or API service)
 * passes whatever they know about the connected wallet; we return a
 * structured result.
 *
 * SOLID:
 *   - SRP: one job — chain-id → PrivacyMode.
 *   - OCP: extending to a new chain = one entry in FHENIX_CHAIN_IDS.
 */

import type {
  PrivacyMode,
  PrivacySource,
  PrivacyTier,
} from './types';
import { privacyTierFor } from './types';

export interface NetworkDetectInput {
  /** wagmi `useChainId()` — numeric EVM chain id; undefined when not connected. */
  evmChainId?: number;
  /** Manual override from the wizard's collapsed picker. Always wins. */
  manualOverride?: PrivacyMode;
}

export interface NetworkDetectResult {
  mode: PrivacyMode;
  tier: PrivacyTier;
  source: PrivacySource;
  reason: string;
  chainId?: number;
}

const FHENIX_CHAIN_IDS = new Set<number>([
  421614, // Arbitrum Sepolia (Fhenix CoFHE testnet — current)
  42161,  // Arbitrum One (Fhenix CoFHE mainnet — future)
  84532,  // Base Sepolia
  1,      // Ethereum mainnet
]);

export function detectPrivacyMode(input: NetworkDetectInput): NetworkDetectResult {
  if (input.manualOverride) {
    const mode = input.manualOverride;
    return {
      mode,
      tier: privacyTierFor(mode),
      source: 'manual',
      reason: 'manual override',
    };
  }
  if (input.evmChainId && FHENIX_CHAIN_IDS.has(input.evmChainId)) {
    return {
      mode: 'fhe',
      tier: 'standard',
      source: 'auto',
      reason: `connected to chain ${input.evmChainId}`,
      chainId: input.evmChainId,
    };
  }
  return {
    mode: 'fhe',
    tier: 'standard',
    source: 'auto',
    reason: 'no recognized network connected; defaulting to Standard',
  };
}
