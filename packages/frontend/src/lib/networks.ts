/**
 * lib/networks.ts — single source of truth for the EVM networks OpenX supports
 * (Arbitrum-only build): Base Sepolia (USDC payments) + Arbitrum Sepolia
 * (FHE brain tier on Fhenix CoFHE).
 *
 * SOLID
 * -----
 *  - SRP: metadata + lookups only. No React, no wallet calls, no fetches.
 *  - DRY: chain primitives come from `wagmi/chains`.
 *  - OCP: adding a new EVM network = appending one entry to `SUPPORTED_NETWORKS`.
 */

import { arbitrumSepolia, baseSepolia } from 'wagmi/chains';

// ─── Public chain-id constants — imported by hooks/pages ─────────────────

export const BASE_SEPOLIA_CHAIN_ID = baseSepolia.id;
export const ARBITRUM_SEPOLIA_CHAIN_ID = arbitrumSepolia.id;

// ─── Stablecoin addresses ────────────────────────────────────────────────

/** Circle's official USDC on Arbitrum Sepolia. */
export const CIRCLE_USDC_ADDRESS_ARB_SEP =
  (process.env.NEXT_PUBLIC_CIRCLE_USDC_ADDRESS ?? '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d') as `0x${string}`;

/** WrappedStablecoin (FHE-encrypted balance over Circle USDC). Set after deploy. */
export const WRAPPED_USDC_ADDRESS =
  (process.env.NEXT_PUBLIC_WRAPPED_USDC_ADDRESS ?? '') as `0x${string}`;

/** PrivPayGateway — used for confidential-amount escrow flows. */
export const PRIV_PAY_GATEWAY_ADDRESS =
  (process.env.NEXT_PUBLIC_PRIV_PAY_GATEWAY_ADDRESS ?? '') as `0x${string}`;

/** Circle faucet URL for Arbitrum-Sepolia testnet USDC. */
export const CIRCLE_FAUCET_URL = 'https://faucet.circle.com/';

// ─── Types ───────────────────────────────────────────────────────────────

export type NetworkKey = 'base-sepolia' | 'arbitrum-sepolia';
export type NetworkKind = 'evm';
export type NetworkFeature = 'payment' | 'fhe-brain';
export type NetworkTier = 'standard';

interface BaseNetwork {
  readonly key: NetworkKey;
  readonly name: string;
  readonly shortName: string;
  readonly icon: string;
  readonly feature: NetworkFeature;
  readonly featureHint: string;
  readonly rpcUrl: string;
  readonly blockExplorer: string;
  readonly tier: NetworkTier;
}

export interface EvmNetwork extends BaseNetwork {
  readonly kind: 'evm';
  readonly id: number;
  readonly nativeCurrency: { name: string; symbol: string; decimals: number };
  readonly addChainPayload?: {
    chainId: `0x${string}`;
    chainName: string;
    rpcUrls: string[];
    nativeCurrency: { name: string; symbol: string; decimals: number };
    blockExplorerUrls: string[];
  };
}

export type Network = EvmNetwork;

// ─── Registry ────────────────────────────────────────────────────────────

export const SUPPORTED_NETWORKS: readonly Network[] = [
  {
    key: 'base-sepolia',
    kind: 'evm',
    id: BASE_SEPOLIA_CHAIN_ID,
    name: 'Base Sepolia',
    shortName: 'Base',
    icon: '🔵',
    feature: 'payment',
    featureHint: 'USDC payments (x402)',
    tier: 'standard',
    rpcUrl: baseSepolia.rpcUrls.default.http[0],
    blockExplorer: baseSepolia.blockExplorers.default.url,
    nativeCurrency: baseSepolia.nativeCurrency,
  },
  {
    key: 'arbitrum-sepolia',
    kind: 'evm',
    id: ARBITRUM_SEPOLIA_CHAIN_ID,
    name: 'Arbitrum Sepolia',
    shortName: 'Arbitrum',
    icon: '🔷',
    feature: 'fhe-brain',
    featureHint: 'FHE brain & subscriptions',
    tier: 'standard',
    rpcUrl: arbitrumSepolia.rpcUrls.default.http[0],
    blockExplorer: arbitrumSepolia.blockExplorers.default.url,
    nativeCurrency: arbitrumSepolia.nativeCurrency,
  },
] as const;

// ─── Lookups ─────────────────────────────────────────────────────────────

export function getNetworkById(id: number | undefined | null): Network | undefined {
  if (id == null) return undefined;
  return SUPPORTED_NETWORKS.find((n) => n.id === id);
}

export function getNetworkByKey(key: NetworkKey): Network {
  return SUPPORTED_NETWORKS.find((n) => n.key === key)!;
}

export function isSupportedChainId(id: number | undefined | null): boolean {
  return getNetworkById(id) !== undefined;
}

/** True when the network is an EVM chain — narrows to {@link EvmNetwork}. */
export function isEvmNetwork(n: Network | undefined | null): n is EvmNetwork {
  return !!n && n.kind === 'evm';
}

/**
 * EVM-only wallet-address validator (40 hex chars after `0x`).
 * `chain` is kept as a parameter so call sites compile unchanged after Sui removal.
 */
export function isValidWalletAddress(addr: string, _chain: 'evm' = 'evm'): boolean {
  if (typeof addr !== 'string') return false;
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

/**
 * Chain-agnostic wallet-address validator. Arbitrum-only build accepts EVM only.
 * Kept under the original name so PublishWizard + co. compile unchanged.
 */
export function isValidEvmOrSuiAddress(addr: string): boolean {
  return isValidWalletAddress(addr);
}
