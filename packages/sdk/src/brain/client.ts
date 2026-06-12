import { encryptContent, splitKey, decryptContent, joinKey } from './encryption';
import {
  CHAIN_TIER_TO_PROVIDER,
} from './types';
import type {
  BrainClient as IBrainClient,
  BrainClientOptions,
  ChainKey,
  ChainProvider,
  ChainTier,
  ChatMode,
  ChatResponse,
  ChatHistoryItem,
  Brain,
  PublishMeta,
  SubscribeResult,
  Tier,
  UploadResult,
} from './types';

// Re-export low-level crypto helpers and supporting types for backward compatibility.
// Existing code that did `import { encryptContent, ChainKey, Tier } from '@fhe-ai-context/sdk'`
// continues to work without changes. The `BrainClient` interface itself is exported from
// `./types` (single source of truth); we don't re-export it here to avoid declaration ambiguity.
export { encryptContent, decryptContent, splitKey, joinKey };
export type {
  ChainKey,
  ChainProvider,
  ChatMode,
  ChatResponse,
  ChatHistoryItem,
  Brain,
  PublishMeta,
  SubscribeResult,
  Tier,
  UploadResult,
  BrainClientOptions,
} from './types';

/**
 * Fhenix CoFHE implementation of the BrainClient contract.
 *
 * Targets the existing Express API at packages/api which talks to:
 *   - Arbitrum Sepolia (Fhenix) for keys and policies
 *   - Supabase for content storage
 *   - AWS Bedrock for inference
 *
 * The transport layer is fetch+JSON. Authentication is the wallet address
 * carried in `x-wallet-address`; chain selection in `x-chain`. Decryption
 * is mediated by an FHE permit imported by the user beforehand.
 */
export class FhenixBrainClient implements IBrainClient {
  private readonly apiUrl: string;
  private readonly chain: ChainKey;
  private readonly walletAddress?: string;

  constructor(apiUrl: string, chain: ChainKey = 'arbitrum-sepolia', walletAddress?: string) {
    this.apiUrl = apiUrl;
    this.chain = chain;
    this.walletAddress = walletAddress;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', 'x-chain': this.chain };
    if (this.walletAddress) h['x-wallet-address'] = this.walletAddress;
    return h;
  }

  private async request<T>(path: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      ...opts,
      headers: { ...this.headers(), ...opts?.headers },
    });
    if (res.status === 402) throw new Error('Subscription required. Call subscribe() first.');
    if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async subscribe(tier: Tier): Promise<SubscribeResult> {
    const res = await fetch(`${this.apiUrl}/subscribe`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ tier }),
    });

    if (res.status === 402) {
      const challenge = res.headers.get('payment-required');
      throw new Error(`x402 payment required. Challenge: ${challenge}`);
    }
    if (!res.ok) throw new Error(`Subscribe failed: ${res.status}`);
    return res.json() as Promise<SubscribeResult>;
  }

  chat(message: string, brainId?: string, mode: ChatMode = 'learn'): Promise<ChatResponse> {
    return this.request<ChatResponse>('/chat', {
      method: 'POST',
      body: JSON.stringify({ message, brainId, mode }),
    });
  }

  async upload(file: Blob, brainId?: string): Promise<UploadResult> {
    const form = new FormData();
    form.append('file', file);
    if (brainId) form.append('brainId', brainId);
    const res = await fetch(`${this.apiUrl}/upload`, {
      method: 'POST',
      headers: { 'x-wallet-address': this.walletAddress ?? '', 'x-chain': this.chain },
      body: form,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return res.json() as Promise<UploadResult>;
  }

  /**
   * Encrypt content client-side (AES-256-GCM) and upload encrypted bytes.
   * The platform pins the encrypted blob and stores the FHE-encrypted key on-chain.
   */
  async uploadEncrypted(content: string, brainId?: string): Promise<UploadResult> {
    const { encrypted, key } = encryptContent(content);
    const { high, low } = splitKey(key);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(encrypted)]), 'brain.enc');
    form.append('keyHigh', Buffer.from(high).toString('hex'));
    form.append('keyLow', Buffer.from(low).toString('hex'));
    if (brainId) form.append('brainId', brainId);

    const res = await fetch(`${this.apiUrl}/upload`, {
      method: 'POST',
      headers: { 'x-wallet-address': this.walletAddress ?? '', 'x-chain': this.chain },
      body: form,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return res.json() as Promise<UploadResult>;
  }

  listBrains(page = 1): Promise<Brain[]> {
    return this.request<Brain[]>(`/brains?page=${page}`);
  }

  searchBrains(query: string): Promise<Brain[]> {
    return this.request<Brain[]>(`/brains/search?q=${encodeURIComponent(query)}`);
  }

  getBrain(id: string | number): Promise<Brain> {
    return this.request<Brain>(`/brains/${id}`);
  }

  publishBrain(brainId: number, meta: PublishMeta): Promise<Brain> {
    return this.request<Brain>('/brains/publish', {
      method: 'POST',
      body: JSON.stringify({ brainId, ...meta }),
    });
  }

  getMyBrains(): Promise<Brain[]> {
    return this.request<Brain[]>('/brains/mine');
  }

  getHistory(brainId?: string, limit = 20): Promise<ChatHistoryItem[]> {
    const params = new URLSearchParams();
    if (brainId) params.set('brainId', brainId);
    params.set('limit', String(limit));
    return this.request<ChatHistoryItem[]>(`/chat/history?${params}`);
  }
}

/**
 * Provider registry — Open/Closed: new chains register themselves; this file
 * never grows when a chain is added. The Fhenix factory is registered below.
 */
type BrainClientFactory = (opts: BrainClientOptions) => IBrainClient;

const providers = new Map<ChainProvider, BrainClientFactory>();

/** Register a chain-specific factory. Idempotent. */
export function registerBrainProvider(name: ChainProvider, factory: BrainClientFactory): void {
  providers.set(name, factory);
}

// Built-in: Fhenix is always registered.
registerBrainProvider('fhenix', (opts) =>
  new FhenixBrainClient(opts.apiUrl, opts.chain ?? 'arbitrum-sepolia', opts.walletAddress),
);

/**
 * Factory: pick a chain-specific implementation.
 *
 * @example
 *   import { createBrainClient } from '@fhe-ai-context/sdk';
 *   const fhenix = createBrainClient('fhenix', { apiUrl, walletAddress });
 *
 *   // For Sui: import the sui-sdk once (registers itself), then:
 *   import '@fhe-ai-context/sui-sdk';
 *   const sui = createBrainClient('sui', { apiUrl, walletAddress });
 */
export function createBrainClient(
  provider: ChainProvider,
  opts: BrainClientOptions,
): IBrainClient {
  const factory = providers.get(provider);
  if (!factory) {
    throw new Error(
      `BrainClient provider '${provider}' not registered. ` +
        (provider === 'sui'
          ? 'Did you import @fhe-ai-context/sui-sdk?'
          : 'Call registerBrainProvider() first.'),
    );
  }
  return factory(opts);
}

// Add a `.forTier` static helper for the human-facing surface (per UNIFIED_FLOW_SPEC).
// Defined as a property so callers can do `createBrainClient.forTier('trustless', ...)`.
export namespace createBrainClient {
  export function forTier(tier: ChainTier, opts: BrainClientOptions): IBrainClient {
    const provider = CHAIN_TIER_TO_PROVIDER[tier];
    return createBrainClient(provider, opts);
  }
}

/**
 * Merge two brain catalogs (typically Fhenix + Sui) into a single de-duplicated
 * list. De-dup key is `${chain}:${id}` so the same brain ID across chains
 * coexists. Used by the catalog UI when tier filter = "all".
 */
export function mergeBrainCatalogs<B extends { id: number; chain?: ChainProvider }>(
  ...catalogs: B[][]
): B[] {
  const seen = new Set<string>();
  const out: B[] = [];
  for (const catalog of catalogs) {
    for (const b of catalog) {
      const key = `${b.chain ?? 'unknown'}:${b.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(b);
    }
  }
  return out;
}
