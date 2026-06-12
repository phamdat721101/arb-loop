import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

/** Encrypt content with AES-256-GCM. Returns encrypted buffer and 32-byte key. */
export function encryptContent(text: string): { encrypted: Buffer; key: Buffer } {
  const key = randomBytes(32);
  return { encrypted: encryptWithKey(text, key), key };
}

/**
 * Encrypt content with a pre-existing 32-byte AES key. Use this when multiple
 * chunks belong to the same brain and must share a single content-key (e.g.
 * the SealBrainClient append flow).
 */
export function encryptContentWithKey(text: string, key: Buffer): { encrypted: Buffer } {
  return { encrypted: encryptWithKey(text, key) };
}

function encryptWithKey(text: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

/** Decrypt AES-256-GCM content with key. */
export function decryptContent(encrypted: Buffer, key: Buffer): string {
  const iv = encrypted.subarray(0, 12);
  const tag = encrypted.subarray(12, 28);
  const data = encrypted.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final('utf8');
}

/** Split 32-byte AES key into two 16-byte halves for FHE euint128 storage. */
export function splitKey(key: Buffer): { high: Buffer; low: Buffer } {
  return { high: key.subarray(0, 16), low: key.subarray(16, 32) };
}

/** Reconstruct 32-byte AES key from two 16-byte halves. */
export function joinKey(high: Buffer, low: Buffer): Buffer {
  return Buffer.concat([high, low]);
}
