'use client';

/**
 * usePay — EVM-only payment facade (Arbitrum-only build).
 *
 * Decision rule:
 *   tier === 'standard' → caller continues with their EVM x402 / FHERC20 path
 *
 * SOLID:
 *  - SRP: rail selection + delegation only.
 *  - DIP: callers see `pay(challenge)` — they don't know which rail won.
 *  - OCP: a 4th rail = a new branch in the switch + a new adapter; this
 *    file's call sites in `useChat`, `usePayments` etc. don't change.
 */

import { useCallback } from 'react';
import { type PaymentChallenge, type PaymentReceipt } from '@fhe-ai-context/sdk';
import { useNetwork } from './useNetwork';
import { AGENT_BACKEND_URL } from '@/lib/contracts';

interface PayResult {
  receipt?: PaymentReceipt;
  rail: 'standard' | 'unhandled';
  /** Caller continues with their own EVM flow when rail === 'standard'. */
  proceedWithEvm?: boolean;
  error?: string;
}

export function usePay() {
  const { network } = useNetwork();

  const pay = useCallback(
    async (_challenge: PaymentChallenge | null): Promise<PayResult> => {
      // Standard tier: caller handles EVM x402 / FHERC20 themselves.
      return { rail: 'standard', proceedWithEvm: true };
    },
    [],
  );

  return {
    pay,
    /** Always false in the Arbitrum-only build. Kept for API compatibility. */
    isTrustless: false as boolean,
    apiUrl: AGENT_BACKEND_URL,
  };
}
