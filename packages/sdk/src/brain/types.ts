/**
 * Chain-agnostic BrainClient contract and supporting types.
 *
 * SOLID:
 * - Single Responsibility: this file declares contracts only; no runtime logic.
 * - Open/Closed: new chains add new implementations of `BrainClient`, never modify existing ones.
 * - Liskov: any implementation (FhenixBrainClient, SealBrainClient, ...) must honour these signatures.
 * - Interface Segregation: a single cohesive surface — humans use `chat/upload/...`, agents use the same.
 * - Dependency Inversion: callers depend on `BrainClient`, not on a concrete chain implementation.
 */

export type ChainKey =
  | 'arbitrum-sepolia'
  | 'arbitrum-mainnet'
  | 'base-sepolia'
  | 'sui-testnet'
  | 'sui-mainnet';

/** Provider abstraction. Used by the factory to pick an implementation. */
export type ChainProvider = 'fhenix' | 'sui';

/** Subscription duration tier (existing). */
export type Tier = 'week' | 'month' | 'quarter';

/**
 * Human-facing chain tier (per docs/UNIFIED_FLOW_SPEC.md). Internally maps to
 * a `ChainProvider`. Humans see the tier; agents see the provider directly.
 */
export type ChainTier = 'standard' | 'trustless';

/** Canonical mapping from chain tier (human surface) to provider (chain surface). */
export const CHAIN_TIER_TO_PROVIDER: Record<ChainTier, ChainProvider> = {
  standard: 'fhenix',
  trustless: 'sui',
};
export type ChatMode = 'learn' | 'store';

export interface AttestationReceipt {
  /** e.g. 'phala-tee', 'fhenix-cofhe', 'seal-threshold' */
  provider: string;
  /** Opaque cryptographic quote for client-side verification. */
  quote: string;
  /** Whether the SDK verified the quote locally. */
  verified: boolean;
  /** ISO timestamp when the receipt was issued. */
  issuedAt: string;
}

export interface ChatResponse {
  response: string;
  stored: boolean;
  sources: string[];
  attestation?: AttestationReceipt;
}

export interface Brain {
  id: number;
  owner_address: string;
  title: string;
  description: string;
  tags: string[];
  published: boolean;
  created_at: string;
  /** Set when the catalog merges results across chains. */
  chain?: ChainProvider;
}

/** Lightweight handle used when migrating brains across chains. */
export interface BrainHandle {
  id: number;
  chain: ChainProvider;
}

/** Hex-encoded halves of a 256-bit AES key (matches Fhenix `euint128 high|low`). */
export interface KeyHandle {
  high: string;
  low: string;
}

export interface UploadResult {
  brainId: number;
  estimatedChunks: number;
}

export interface SubscribeResult {
  txHash: string;
  expiresAt: string;
  tier: string;
}

export interface PublishMeta {
  title: string;
  description?: string;
  tags?: string[];
}

export interface ChatHistoryItem {
  role: string;
  content: string;
  created_at: string;
}

export interface BrainClientOptions {
  apiUrl: string;
  chain?: ChainKey;
  walletAddress?: string;
}

/**
 * The contract every chain-specific client implements.
 *
 * Stable across providers; each implementation routes the call to the right
 * combination of contracts, storage and inference (see docs/UNIFIED_FLOW_SPEC.md).
 */
export interface BrainClient {
  subscribe(tier: Tier): Promise<SubscribeResult>;
  chat(message: string, brainId?: string, mode?: ChatMode): Promise<ChatResponse>;
  upload(file: Blob, brainId?: string): Promise<UploadResult>;
  uploadEncrypted(content: string, brainId?: string): Promise<UploadResult>;
  listBrains(page?: number): Promise<Brain[]>;
  searchBrains(query: string): Promise<Brain[]>;
  getBrain(id: string | number): Promise<Brain>;
  publishBrain(brainId: number, meta: PublishMeta): Promise<Brain>;
  getMyBrains(): Promise<Brain[]>;
  getHistory(brainId?: string, limit?: number): Promise<ChatHistoryItem[]>;
}
