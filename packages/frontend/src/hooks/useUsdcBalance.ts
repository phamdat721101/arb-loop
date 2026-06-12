'use client';

/**
 * useUsdcBalance — read Circle USDC balance on Arbitrum Sepolia.
 *
 * SRP: this hook reads ERC-20 balanceOf for one address against the
 * configured Circle USDC contract. No payment, no faucet logic — those
 * live in components that render the balance.
 *
 * Performance: wagmi's useReadContract caches per-address. Calling this
 * hook in multiple components reuses the same query.
 */

import { useReadContract } from 'wagmi';
import { CIRCLE_USDC_ADDRESS_ARB_SEP, ARBITRUM_SEPOLIA_CHAIN_ID } from '@/lib/networks';

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export interface UsdcBalance {
  /** Raw uint256 balance (6 decimals). */
  raw: bigint | undefined;
  /** Display string with 2-decimal formatting, or '—' when not loaded. */
  display: string;
  /** True when raw < $1.00 — used to gate the faucet banner. */
  isLow: boolean;
  /** Refetch trigger — call after a known balance-changing tx. */
  refetch: () => void;
  loading: boolean;
}

const ONE_DOLLAR_MICRO = 1_000_000n;

export function useUsdcBalance(address: `0x${string}` | undefined): UsdcBalance {
  const { data, isLoading, refetch } = useReadContract({
    address: CIRCLE_USDC_ADDRESS_ARB_SEP,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
    query: { enabled: !!address, refetchInterval: 15_000 },
  });

  const raw = data as bigint | undefined;
  const display = raw == null ? '—' : (Number(raw) / 1e6).toFixed(2);
  const isLow = raw == null ? true : raw < ONE_DOLLAR_MICRO;

  return { raw, display, isLow, refetch: () => void refetch(), loading: isLoading };
}
