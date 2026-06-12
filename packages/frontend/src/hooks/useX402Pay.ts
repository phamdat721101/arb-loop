'use client';
/**
 * hooks/useX402Pay.ts — wagmi v2 + Privy-friendly x402 dance.
 *
 * Usage:
 *   const { pay, isLoading, error } = useX402Pay();
 *   const result = await pay({
 *     url: '/v3/arbloop/agents/42/invoke',
 *     body: { text: 'translate this' },
 *   });
 *
 * Flow:
 *   1. Initial POST without X-PAYMENT → server returns 402 + challenge.
 *   2. Build EIP-3009 typed-data from challenge.
 *   3. signTypedData via wagmi.
 *   4. Re-POST with X-PAYMENT header.
 *   5. Return JSON body + settlement tx hash.
 *
 * SOLID:
 *   - SRP: one hook owns the x402 dance.
 *   - DIP: wagmi's signTypedDataAsync is the only external dependency.
 */

import { useCallback, useState } from 'react';
import { useAccount, useSignTypedData } from 'wagmi';
import {
  buildEip3009TypedData,
  USDC_DOMAINS,
  type X402Challenge,
} from '@fhe-ai-context/sdk';
import { ARBLOOP_API_URL } from '@/lib/arbloop';

export interface PayArgs {
  /** Path or absolute URL of the x402 endpoint (e.g. '/v3/arbloop/agents/42/invoke'). */
  url: string;
  /** Request body (JSON). */
  body: Record<string, unknown>;
  /** Optional override for the JSON content-type (default 'application/json'). */
  contentType?: string;
}

export interface PayResult<T> {
  ok: boolean;
  status: number;
  data: T;
  settlementTxHash?: `0x${string}`;
}

export function useX402Pay() {
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<`0x${string}` | null>(null);

  const pay = useCallback(async <T = unknown>(args: PayArgs): Promise<PayResult<T>> => {
    if (!address) {
      const err = 'wallet_not_connected';
      setError(err);
      throw new Error(err);
    }
    setIsLoading(true);
    setError(null);

    const fullUrl = args.url.startsWith('http') ? args.url : `${ARBLOOP_API_URL}${args.url}`;
    const network = (process.env.NEXT_PUBLIC_ARBLOOP_NETWORK as 'arbitrum-sepolia' | 'arbitrum') ?? 'arbitrum-sepolia';

    try {
      // 1. Initial call without payment.
      const r1 = await fetch(fullUrl, {
        method: 'POST',
        headers: { 'content-type': args.contentType ?? 'application/json' },
        body: JSON.stringify(args.body),
      });
      if (r1.status !== 402) {
        // Already free or other status → return as-is.
        const json = await r1.json().catch(() => ({}));
        return { ok: r1.ok, status: r1.status, data: json as T };
      }

      // 2. Parse challenge.
      const challenge: X402Challenge = await r1.json();
      const accept = challenge.accepts?.[0];
      if (!accept) throw new Error('x402:no_accept_in_challenge');

      // 3. Build EIP-3009 typed-data.
      const domain = network === 'arbitrum' ? USDC_DOMAINS.arbitrum : USDC_DOMAINS.arbitrumSepolia;
      const td = buildEip3009TypedData({
        domain,
        from: address as `0x${string}`,
        to: accept.pay_to,
        valueMicroUsdc: BigInt(accept.max_amount_required),
      });

      // 4. Sign.
      const signature = (await signTypedDataAsync({
        domain: td.domain,
        types: { TransferWithAuthorization: td.types.TransferWithAuthorization },
        primaryType: 'TransferWithAuthorization',
        message: td.message,
      } as never)) as `0x${string}`;

      // 5. Build X-PAYMENT header.
      const xPayment = btoa(JSON.stringify({
        x402_version: '1.0',
        scheme: 'exact',
        network: accept.network,
        signature,
        authorization: {
          ...td.message,
          value: td.message.value.toString(),
          validAfter: td.message.validAfter.toString(),
          validBefore: td.message.validBefore.toString(),
        },
      }));

      // 6. Retry with X-PAYMENT.
      const r2 = await fetch(fullUrl, {
        method: 'POST',
        headers: {
          'content-type': args.contentType ?? 'application/json',
          'X-PAYMENT': xPayment,
        },
        body: JSON.stringify(args.body),
      });
      const json = await r2.json().catch(() => ({}));

      // 7. Decode settlement tx from response header (if present).
      const xpr = r2.headers.get('X-PAYMENT-RESPONSE');
      let settlementTxHash: `0x${string}` | undefined;
      if (xpr) {
        try {
          const decoded = JSON.parse(atob(xpr));
          settlementTxHash = decoded.tx_hash;
        } catch { /* ignore */ }
      }
      if (settlementTxHash) setLastTxHash(settlementTxHash);

      return { ok: r2.ok, status: r2.status, data: json as T, settlementTxHash };
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, [address, signTypedDataAsync]);

  return { pay, isLoading, error, lastTxHash };
}
