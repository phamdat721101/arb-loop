'use client';

/**
 * useConnectedPrivacyMode — wizard step-3 detector (Arbitrum-only).
 *
 * Reads the canonical network registry (via `useNetwork`) and projects it
 * into a PrivacyMode. Manual override (collapsed picker in the wizard)
 * always wins.
 *
 * SOLID:
 *  - SRP: this hook just derives privacy from network + override. The
 *    detection algorithm itself lives in `@fhe-ai-context/sdk` (pure fn).
 *  - DIP: the SDK function is the policy; this hook is the adapter to
 *    React state.
 */

import { useMemo, useState } from 'react';
import {
  detectPrivacyMode,
  type NetworkDetectResult,
  type PrivacyMode,
} from '@fhe-ai-context/sdk';
import { useNetwork } from './useNetwork';

export interface UseConnectedPrivacyMode {
  detected: NetworkDetectResult;
  override: PrivacyMode | undefined;
  setOverride: (m: PrivacyMode | undefined) => void;
  /** Numeric EVM chain id — passed to publish API as `privacy.chain_id`. */
  chainId: number | undefined;
}

export function useConnectedPrivacyMode(): UseConnectedPrivacyMode {
  const { network } = useNetwork();
  const [override, setOverride] = useState<PrivacyMode | undefined>(undefined);

  const detected = useMemo(
    () =>
      detectPrivacyMode({
        evmChainId: network.id,
        manualOverride: override,
      }),
    [network.id, override],
  );

  return { detected, override, setOverride, chainId: network.id };
}
