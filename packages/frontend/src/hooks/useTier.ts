'use client';

import { useCallback } from 'react';

/**
 * Tier picker — Arbitrum-only build collapses to a single 'standard' tier
 * (Fhenix CoFHE on Arbitrum). The trustless Sui-tier was removed; the API
 * surface is preserved so existing callers compile unchanged.
 *
 * SOLID:
 *   - SRP: tier semantics only.
 *   - DIP: callers depend on the public `useTier()` shape, not on internals.
 */
export type Tier = 'standard' | 'trustless';

export function useTier(): { tier: Tier; setTier: (t: Tier) => void } {
  const setTier = useCallback((_t: Tier) => {
    /* no-op — arb-mem is Arbitrum-only; tier always === 'standard' */
  }, []);
  return { tier: 'standard', setTier };
}
