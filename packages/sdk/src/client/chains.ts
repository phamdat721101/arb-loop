/**
 * Chain registry — single source of truth for RPC URLs (Arbitrum-only).
 *
 * Standard tier (Fhenix CoFHE) → Arbitrum Sepolia / Arbitrum One.
 */

export const arbitrumSepolia = {
  id: 421614,
  name: 'Arbitrum Sepolia',
  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
} as const;

export const arbitrum = {
  id: 42161,
  name: 'Arbitrum One',
  rpcUrl: 'https://arb1.arbitrum.io/rpc',
} as const;

export type SupportedChain = typeof arbitrumSepolia | typeof arbitrum;
