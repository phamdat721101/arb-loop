'use client';

/**
 * useFherc20Pay — buyer-side hook for confidential-amount payments.
 *
 * Flow:
 *   1. Encrypt the amount via the existing CoFHE singleton (useFheClient).
 *   2. Call WrappedStablecoin.encryptedTransfer(payTo, encrypted) via wagmi.
 *   3. Wait for the receipt; return the tx hash.
 *
 * The hook configures the SDK's fherc20Adapter on first use so any future
 * call to PayRouter on the 'fherc20' rail dispatches here.
 *
 * SOLID:
 *   - SRP: this hook owns ONE side-effect — paying via FHERC20.
 *   - DIP: the SDK adapter accepts encryptUint64+sendTransfer callbacks;
 *     this hook supplies them, decoupling SDK from cofhejs/wagmi specifics.
 */

import { useCallback, useEffect, useState } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { configureFherc20 } from '@fhe-ai-context/sdk';
import { useFheClient } from './useFheClient';
import { WRAPPED_USDC_ADDRESS, ARBITRUM_SEPOLIA_CHAIN_ID } from '@/lib/networks';

const WRAPPED_ABI = [
  {
    type: 'function',
    name: 'encryptedTransfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'inAmount', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

export function useFherc20Pay() {
  const { client: cofhe, ready: fheReady } = useFheClient() as any;
  const { writeContractAsync } = useWriteContract();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<`0x${string}` | null>(null);
  const wait = useWaitForTransactionReceipt({ hash: lastTx ?? undefined, chainId: ARBITRUM_SEPOLIA_CHAIN_ID });

  // Wire the SDK's fherc20Adapter to use this hook's encrypt + send pair.
  useEffect(() => {
    if (!fheReady || !cofhe) return;
    configureFherc20({
      wrappedTokenAddress: WRAPPED_USDC_ADDRESS,
      provider: cofhe,
      encryptUint64: async (amount: bigint) => {
        // cofhejs returns { handles, proof } for an euint64 input. Shape may
        // vary by SDK version; cast to any then narrow to the consumer shape.
        const enc = await cofhe.encrypt([{ type: 'uint64', value: amount }]);
        return { handles: enc.handles ?? [enc[0]], proof: enc.proof ?? enc.inputProof };
      },
      sendTransfer: async (to, encrypted) => {
        const inAmount = encrypted.handles[0]; // single euint64
        const hash = await writeContractAsync({
          address: WRAPPED_USDC_ADDRESS,
          abi: WRAPPED_ABI,
          functionName: 'encryptedTransfer',
          args: [to, inAmount],
          chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
        });
        return hash as `0x${string}`;
      },
    });
  }, [fheReady, cofhe, writeContractAsync]);

  const pay = useCallback(
    async (amountUsdcDecimal: string, payTo: `0x${string}`): Promise<`0x${string}`> => {
      setPending(true);
      setError(null);
      try {
        if (!cofhe || !fheReady) throw new Error('CoFHE client not ready — sign in first.');
        if (!WRAPPED_USDC_ADDRESS) throw new Error('WRAPPED_USDC_ADDRESS not configured');
        const amountMicro = BigInt(Math.round(Number(amountUsdcDecimal) * 1_000_000));
        const enc = await cofhe.encrypt([{ type: 'uint64', value: amountMicro }]);
        const inAmount = (enc.handles ?? [enc[0]])[0];
        const hash = await writeContractAsync({
          address: WRAPPED_USDC_ADDRESS,
          abi: WRAPPED_ABI,
          functionName: 'encryptedTransfer',
          args: [payTo, inAmount],
          chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
        });
        setLastTx(hash as `0x${string}`);
        return hash as `0x${string}`;
      } catch (e: any) {
        setError(e?.message ?? 'Payment failed');
        throw e;
      } finally {
        setPending(false);
      }
    },
    [cofhe, fheReady, writeContractAsync],
  );

  return {
    pay,
    pending: pending || wait.isLoading,
    settled: wait.isSuccess,
    error,
    lastTx,
  };
}
