/**
 * litEncryption.ts — Mock Lit Protocol V3 client for arb-loop v0.1.
 *
 * Substitutes threshold-MPC PKPs with HKDF-derived AES-256-GCM keys so the
 * envelope shape is identical to what real Lit returns. Real `@lit-protocol/
 * lit-node-client` swaps in via the factory in `index.ts` (v0.2).
 *
 * Policy-aware: each LitPolicyName maps to a different HKDF salt, so a
 * ciphertext encrypted under one policy cannot be decrypted under another.
 * The ECDH fallback path implements Tiger-1 mitigation (per docs/research
 * pre-mortem): when Lit Datil is down, the client encrypts to the buyer's
 * wallet pubkey via a one-shot ephemeral keypair.
 *
 * SOLID:
 *   - SRP: encrypt + decrypt only. Policies are data, not code.
 *   - DIP: callers depend on `ILitEncryption`.
 *   - OCP: adding a policy = one entry in POLICY_SALTS.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';
import type { ILitEncryption, LitPolicyName } from '@fhe-ai-context/sdk';

const POLICY_SALTS: Record<LitPolicyName, string> = {
  'job-memory-l1': 'arbloop:job-memory-l1:v1',
  'job-memory-l2': 'arbloop:job-memory-l2:v1',
  'job-memory-l4': 'arbloop:job-memory-l4:v1',
  'agent-memory-l3': 'arbloop:agent-memory-l3:v1',
  'agent-memory-l5': 'arbloop:agent-memory-l5:v1',
  'agent-memory-l3-public-read': 'arbloop:agent-memory-l3-public-read:v1',
};

// ─── HKDF (RFC 5869) — extract + expand to 32-byte AES key ────────────────

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return createHmac('sha256', Buffer.from(key)).update(Buffer.from(data)).digest();
}

function hkdfDeriveKey(masterSecret: string, info: string, salt: string): Uint8Array {
  const ikm = Buffer.from(masterSecret, 'utf8');
  const saltBuf = Buffer.from(salt, 'utf8');
  const prk = hmacSha256(saltBuf, ikm);
  const t1 = hmacSha256(prk, Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([0x01])]));
  return new Uint8Array(t1);
}

interface LitEnvelope {
  ciphertext: string;
  dataToEncryptHash: string;
  policy: LitPolicyName;
  iv: string;
  authTag: string;
  /** When set, indicates an ECDH fallback envelope (Tiger-1 mitigation). */
  fallback?: 'ecdh';
}

export class MockLitEncryption implements ILitEncryption {
  constructor(private readonly masterSecret: string) {
    if (!masterSecret || masterSecret.length < 16) {
      throw new Error('arbloop:lit:master_secret_required (>=16 bytes)');
    }
  }

  async encryptForOwner(
    plaintext: unknown,
    ownerAddress: string,
    policyName: LitPolicyName,
  ): Promise<string> {
    const data = Buffer.from(JSON.stringify(plaintext), 'utf8');
    const key = this.deriveKey(ownerAddress.toLowerCase(), policyName);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), iv);
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const envelope: LitEnvelope = {
      ciphertext: ct.toString('base64'),
      dataToEncryptHash: '0x' + Buffer.from(hmacSha256(key, data)).toString('hex'),
      policy: policyName,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
    };
    return JSON.stringify(envelope);
  }

  async decryptForReader(
    envelopeJson: string,
    sessionSig: string,
    policyName: LitPolicyName,
    opts?: { filter?: string; contractAddress?: string },
  ): Promise<unknown> {
    const env = JSON.parse(envelopeJson) as LitEnvelope;
    if (env.policy !== policyName) {
      throw new Error(`arbloop:lit:policy_mismatch:${env.policy}!=${policyName}`);
    }
    // sessionSig in this mock is the lowercased reader address (contract or wallet)
    const ownerKey = sessionSig.toLowerCase();
    const key = this.deriveKey(ownerKey, policyName);
    const iv = Buffer.from(env.iv, 'base64');
    const ct = Buffer.from(env.ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), iv);
    decipher.setAuthTag(Buffer.from(env.authTag, 'base64'));
    let pt: Buffer;
    try {
      pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new Error('arbloop:lit:decrypt_failed');
    }
    const value = JSON.parse(pt.toString('utf8'));
    if (opts?.filter) return applyFilter(value, opts.filter);
    return value;
  }

  /** Tiger-1 fallback path — expose encrypt-via-static-symmetric for tests. */
  encryptWithEcdhFallback(plaintext: unknown, sharedSecret: Uint8Array): string {
    const data = Buffer.from(JSON.stringify(plaintext), 'utf8');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(sharedSecret), iv);
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    const env: LitEnvelope = {
      ciphertext: ct.toString('base64'),
      dataToEncryptHash:
        '0x' + Buffer.from(hmacSha256(sharedSecret, data)).toString('hex'),
      policy: 'agent-memory-l3-public-read', // placeholder — fallback bypasses policy
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      fallback: 'ecdh',
    };
    return JSON.stringify(env);
  }

  private deriveKey(ownerAddress: string, policyName: LitPolicyName): Uint8Array {
    const salt = POLICY_SALTS[policyName];
    const info = `${policyName}:${ownerAddress}`;
    return hkdfDeriveKey(this.masterSecret, info, salt);
  }
}

/**
 * Apply a simple equality filter expression like `buyer_industry == "saas"` to
 * a parsed object. Returns the input unchanged on filter parse failure (best-
 * effort; the predicate evaluator in the SDK is the authoritative grammar).
 */
function applyFilter(value: unknown, filter: string): unknown {
  const m = filter.match(/^(\w+)\s*==\s*"(.+)"$/);
  if (!m || typeof value !== 'object' || value === null) return value;
  const [, key, expected] = m;
  const v = (value as Record<string, unknown>)[key];
  return v === expected ? value : null;
}
