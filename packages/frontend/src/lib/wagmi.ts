/**
 * lib/wagmi.ts — wagmi client config.
 *
 * Source of truth for chains is `lib/networks.ts`. This module only adapts
 * that registry into the shape wagmi/viem expect.
 */

import { createConfig } from '@privy-io/wagmi';
import { http } from 'wagmi';
import { arbitrum, arbitrumSepolia, baseSepolia } from 'wagmi/chains';

// Order matters only for wagmi's default-chain heuristic; we list testnets
// first because every active demo path runs on a testnet.
export const wagmiConfig = createConfig({
  chains: [baseSepolia, arbitrumSepolia, arbitrum],
  transports: {
    [baseSepolia.id]: http(),
    [arbitrumSepolia.id]: http(),
    [arbitrum.id]: http(),
  },
});
