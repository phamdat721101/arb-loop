import type { PrivyClientConfig } from '@privy-io/react-auth';
import { baseSepolia, arbitrumSepolia } from 'viem/chains';

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? '';

/**
 * Privy embedded wallets only sign on chains declared in `supportedChains`.
 * The list mirrors `lib/networks.ts`.
 */
export const privyConfig: PrivyClientConfig = {
  loginMethods: ['email', 'wallet', 'google'],
  appearance: {
    theme: 'dark',
    accentColor: '#E94560',
  },
  embeddedWallets: {
    createOnLogin: 'users-without-wallets',
  },
  defaultChain: baseSepolia,
  supportedChains: [baseSepolia, arbitrumSepolia],
};
