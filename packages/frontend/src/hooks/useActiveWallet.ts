'use client';

/**
 * useActiveWallet — single source of truth for "the user's wallet on the
 * currently selected network" (Arbitrum-only build).
 *
 * SOLID:
 *  - SRP: one hook, one job — return the user's EVM address + readiness.
 *  - DIP: pages depend on this hook, never on `useAccount()` directly.
 */

import { useAccount } from 'wagmi';
import { usePrivy, useWallets, type ConnectedWallet } from '@privy-io/react-auth';
import { useNetwork } from './useNetwork';

export interface ActiveWallet {
  /** EVM address, or `undefined` when no wallet is connected. */
  address: string | undefined;
  /** Always 'evm' in the Arbitrum-only build. */
  kind: 'evm';
  /** `true` after `useNetwork()` hydration completes — gate UI on this to avoid SSR flicker. */
  isReady: boolean;
}

/**
 * usePrivyEvmWallet — returns the user's currently-connected EVM
 * `ConnectedWallet` from Privy, or `undefined` when no EVM wallet is
 * active.
 */
export function usePrivyEvmWallet(): ConnectedWallet | undefined {
  const { wallets } = useWallets();
  return wallets.find((w) => w.type === 'ethereum');
}

/**
 * usePrivyEvmAddress — single source of truth for "the user's EVM address,
 * regardless of how they signed in". Reads `useWallets()` first, falls back
 * to `usePrivy().user.wallet.address` for embedded-only sessions.
 */
export function usePrivyEvmAddress(): `0x${string}` | undefined {
  const evmWallet = usePrivyEvmWallet();
  const { user } = usePrivy();

  if (evmWallet?.address) return evmWallet.address as `0x${string}`;
  if (user?.wallet?.chainType === 'ethereum' && user.wallet.address) {
    return user.wallet.address as `0x${string}`;
  }
  return undefined;
}

export function useActiveWallet(): ActiveWallet {
  const { ready } = useNetwork();
  const evm = useAccount();
  const privyEvm = usePrivyEvmAddress();
  return {
    address: evm.address ?? privyEvm,
    kind: 'evm',
    isReady: ready,
  };
}
