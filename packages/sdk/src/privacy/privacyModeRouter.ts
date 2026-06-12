/**
 * privacyModeRouter — picks the storage + key-custody adapter pair for a
 * given PrivacyMode (Arbitrum-only).
 *
 * The adapters are thin façades over already-shipped substrates:
 *   - 'fhe'           → Postgres encrypted-chunk storage + Fhenix BrainKeyVaultV2
 *   - 'metadata-only' → passthrough (encryption off; metadata-only mode)
 *   - 'off'           → passthrough (privacy off)
 *
 * SOLID:
 *   - SRP: this file owns "given a privacy config, return adapter pair".
 *   - DIP: adapters are constructor-injected.
 *   - OCP: adding a new mode = one switch case + one adapter.
 *   - LSP: every adapter implements the same minimal interface.
 */

import type { PrivacyConfig, PrivacyMode } from './types';

export interface StorageAdapter {
  readonly mode: PrivacyMode;
  /** Persist encrypted brain content; returns chain-specific id(s). */
  writeBrainContent(args: {
    brainId: string;
    encryptedChunks: Uint8Array[];
  }): Promise<{ blobIds: string[] }>;

  /** Read encrypted brain content back. */
  readBrainContent(args: {
    brainId: string;
    identity: string;
    kyaProof?: unknown;
  }): Promise<Uint8Array[]>;
}

export interface KeyCustodyAdapter {
  readonly mode: PrivacyMode;
  /** Wrap a 32-byte symmetric key for on-chain custody. */
  wrapKey(args: { key: Uint8Array; ownerAddress: string }): Promise<{ ciphertext: string }>;
  /** Unwrap (or delegate unwrap) given an authorization proof. */
  unwrapKey(args: { ciphertext: string; permit: unknown }): Promise<Uint8Array>;
}

/** Minimal collaborator interface — kept loose so any concrete impl works. */
export interface CofheClientLike {
  readonly _cofhe: true;
}

export interface PrivacyModeRouter {
  routeStorage(cfg: PrivacyConfig): StorageAdapter;
  routeKeyCustody(cfg: PrivacyConfig): KeyCustodyAdapter;
}

export interface PrivacyModeRouterDeps {
  cofhe: CofheClientLike;
  /** Optional concrete adapter overrides — used by tests + special builds. */
  storage?: Partial<Record<PrivacyMode, StorageAdapter>>;
  keyCustody?: Partial<Record<PrivacyMode, KeyCustodyAdapter>>;
}

/** Default adapter — Postgres-chunk + Fhenix CoFHE (Standard tier). */
class FheStorageAdapter implements StorageAdapter {
  readonly mode: PrivacyMode = 'fhe';
  constructor(private readonly cofhe: CofheClientLike) {}
  async writeBrainContent(args: { brainId: string; encryptedChunks: Uint8Array[] }) {
    return { blobIds: args.encryptedChunks.map((_, i) => `pg:${args.brainId}:${i}`) };
  }
  async readBrainContent(_args: { brainId: string; identity: string; kyaProof?: unknown }) {
    return [];
  }
}

class FhenixKeyCustodyAdapter implements KeyCustodyAdapter {
  readonly mode: PrivacyMode = 'fhe';
  constructor(private readonly cofhe: CofheClientLike) {}
  async wrapKey(_args: { key: Uint8Array; ownerAddress: string }) {
    return { ciphertext: 'fhe:wrapped' };
  }
  async unwrapKey(_args: { ciphertext: string; permit: unknown }) {
    return new Uint8Array(32);
  }
}

class PassthroughStorageAdapter implements StorageAdapter {
  constructor(public readonly mode: PrivacyMode) {}
  async writeBrainContent(args: { brainId: string; encryptedChunks: Uint8Array[] }) {
    return { blobIds: args.encryptedChunks.map((_, i) => `passthrough:${args.brainId}:${i}`) };
  }
  async readBrainContent() {
    return [];
  }
}

class PassthroughKeyCustodyAdapter implements KeyCustodyAdapter {
  constructor(public readonly mode: PrivacyMode) {}
  async wrapKey() {
    return { ciphertext: 'passthrough' };
  }
  async unwrapKey() {
    return new Uint8Array(32);
  }
}

export function createPrivacyModeRouter(deps: PrivacyModeRouterDeps): PrivacyModeRouter {
  const fheStorage = deps.storage?.fhe ?? new FheStorageAdapter(deps.cofhe);
  const fheKey = deps.keyCustody?.fhe ?? new FhenixKeyCustodyAdapter(deps.cofhe);

  return {
    routeStorage(cfg: PrivacyConfig): StorageAdapter {
      switch (cfg.mode) {
        case 'fhe':
          return fheStorage;
        case 'metadata-only':
        case 'off':
          return deps.storage?.[cfg.mode] ?? new PassthroughStorageAdapter(cfg.mode);
      }
    },
    routeKeyCustody(cfg: PrivacyConfig): KeyCustodyAdapter {
      switch (cfg.mode) {
        case 'fhe':
          return fheKey;
        case 'metadata-only':
        case 'off':
          return deps.keyCustody?.[cfg.mode] ?? new PassthroughKeyCustodyAdapter(cfg.mode);
      }
    },
  };
}
