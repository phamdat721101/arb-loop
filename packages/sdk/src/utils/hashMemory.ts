import { createHash } from 'crypto';

/** Hash a conversation string to a bigint safe for euint128 (max 2^128 - 1). */
export function hashMemory(conversation: string): bigint {
  const hash = createHash('sha256').update(conversation, 'utf8').digest('hex');
  // Take first 32 hex chars (128 bits) to fit in euint128
  const truncated = hash.slice(0, 32);
  return BigInt('0x' + truncated);
}
