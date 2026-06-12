/**
 * keyWrap — per-(owner, layer) AES-256-GCM key derivation.
 *
 * Phase 1 implementation:
 *   key = HKDF(COGNITIVE_KEK, salt = lower(owner) + ':' + layer, info = 'fhedin-cognitive-v1')
 *   The 32-byte master KEK is one env var (COGNITIVE_KEK, 64 hex chars). Pure
 *   function: no Postgres state, no race conditions, no key-management UX.
 *
 * Phase 2 swap:
 *   Replace `deriveLayerKey()` body with a Fhenix call (`BrainKeyVaultV2`
 *   keyed on a deterministic brainId = keccak256(owner ‖ layer)). The
 *   exported function signature does not change; callers (cognitiveMemoryService,
 *   the API decrypt path) are unaffected. SOLID-DIP.
 *
 * Threat model parity:
 *   - Phase 1 key safety = KEK env-var safety (same posture as DATABASE_URL,
 *     PAYMENT_SECRET, PLATFORM_SIGNER_PRIVATE_KEY). KEK loss = unrecoverable
 *     ciphertext, identical to Fhenix key loss.
 *   - Phase 2 upgrades to Fhenix's CoFHE wrap, which adds independent
 *     key-server verification — strictly stronger.
 */

import { hkdfSync } from 'node:crypto';
import type { CognitiveLayer } from './types';

const HKDF_HASH = 'sha256';
const KEY_LEN = 32;
const HKDF_INFO = Buffer.from('fhedin-cognitive-v1', 'utf8');

let _kekCache: Buffer | null = null;

/**
 * Read the master KEK from process.env. 64 hex chars (= 32 bytes). Caller is
 * responsible for ensuring the env var exists in production; in dev, throws
 * a clear error rather than silently using a default (which would risk
 * leaking dev keys into prod).
 */
function getKek(): Buffer {
  if (_kekCache) return _kekCache;
  const raw = process.env.COGNITIVE_KEK ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw Object.assign(
      new Error('COGNITIVE_KEK env var missing or not 64 hex chars (32 bytes)'),
      { status: 503, code: 'KEK_MISSING' },
    );
  }
  _kekCache = Buffer.from(raw, 'hex');
  return _kekCache;
}

/**
 * Derive a 32-byte AES-256-GCM key for an (owner, layer) tuple. Deterministic:
 * same inputs always yield the same key. Cheap (< 10 µs per call).
 *
 * @param ownerAddr 0x-prefixed lowercase wallet address (the brain owner).
 * @param layer 'L1' | 'L2' | 'L3'.
 */
export function deriveLayerKey(ownerAddr: string, layer: CognitiveLayer): Buffer {
  if (!/^0x[0-9a-fA-F]{40}$/.test(ownerAddr)) {
    throw new Error(`deriveLayerKey: invalid owner address "${ownerAddr}"`);
  }
  const salt = Buffer.from(`${ownerAddr.toLowerCase()}:${layer}`, 'utf8');
  const out = hkdfSync(HKDF_HASH, getKek(), salt, HKDF_INFO, KEY_LEN);
  return Buffer.from(out);
}

/**
 * Reset the KEK cache. Tests only — production never calls this.
 */
export function _resetKekCache(): void {
  _kekCache = null;
}
