export interface RawContext {
  userId: bigint;
  sessionKey: bigint;
  sentimentScore: number;   // 0–255
  trustLevel: number;       // 0–3
  isVerified: boolean;
  authorizedAgent: `0x${string}`;
}

export interface DecryptedContext {
  sessionKey: bigint;
  sentimentScore: number;
  trustLevel: number;
  isVerified: boolean;
  memoryTier: number;       // 0=short, 1=medium, 2=long
}

export interface ContextHandles {
  sessionKey: bigint;
  userId: bigint;
  contextVersion: bigint;
  sentimentScore: bigint;
  trustLevel: bigint;
  memoryTier: bigint;
  isActive: bigint;
  isVerified: bigint;
  authorizedAgent: bigint;
}

export type MemoryTier = 'short' | 'medium' | 'long';
export type TrustLevel = 'anonymous' | 'basic' | 'premium' | 'admin';

export const MEMORY_TIER_MAP: Record<number, MemoryTier> = {
  0: 'short',
  1: 'medium',
  2: 'long',
};

export const TRUST_LEVEL_MAP: Record<number, TrustLevel> = {
  0: 'anonymous',
  1: 'basic',
  2: 'premium',
  3: 'admin',
};
