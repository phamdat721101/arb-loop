/* eslint-disable no-console */
/**
 * smoke-arbloop-fhe.ts
 *
 * Asserts the Fhenix encryption pipeline:
 *   1. AES-GCM encrypt sample bytes; upload ciphertext to Pinata.
 *   2. Build a Fhenix euint256 handle for the AES key (server-side via
 *      gateway.encryptForAddress).
 *   3. Gateway.decrypt() recovers the same AES key.
 *   4. AES-GCM decrypt round-trip yields the original bytes.
 *
 * Note: this smoke runs server-side (Node) and uses the gateway HTTP API
 * directly. Requires PINATA_JWT + ARBLOOP_FHENIX_GATEWAY_URL +
 * ARBLOOP_RUNNER_PRIVATE_KEY in env.
 *
 * Usage:
 *   PINATA_JWT=... ARBLOOP_FHENIX_GATEWAY_URL=... \
 *   ARBLOOP_RUNNER_PRIVATE_KEY=... \
 *     npm run smoke:arbloop-fhe
 */

import {
  FheGateway,
  PinataClient,
  aesGcmEncryptServer,
  aesGcmDecryptServer,
  hexToKey32,
  loadFheGatewayFromEnv,
  loadPinataFromEnv,
} from '../packages/api/src/services/arbloop/fheGateway';

const SAMPLE = 'Smoke test: legal translator output. 2026-06-12.';
const RECIPIENT = (process.env.RECIPIENT_ADDRESS ?? '0x100690a32B562fd45e685BC2E63bbfF566d452db') as `0x${string}`;
const CONTEXT_V2 = (process.env.ARBLOOP_CONFIDENTIAL_AI_CONTEXT_V2_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;

async function main() {
  const fhe = loadFheGatewayFromEnv();
  const pinata = loadPinataFromEnv();

  // 1. AES-encrypt sample.
  const plaintext = new TextEncoder().encode(SAMPLE);
  const enc = aesGcmEncryptServer(plaintext);
  console.log('✓ AES-GCM encrypted', plaintext.length, 'bytes');

  // 2. Upload ciphertext to Pinata.
  const cid = await pinata.put(enc.ciphertext, 'smoke-fhe.bin');
  console.log('✓ Pinata CID =', cid);

  // 3. Encrypt AES key for recipient via gateway.
  const valueHex = ('0x' + Buffer.from(enc.key).toString('hex')) as `0x${string}`;
  const handle = await fhe.encryptForAddress({
    valueHex,
    recipient: RECIPIENT,
    contractAddr: CONTEXT_V2,
  });
  console.log('✓ Fhenix handle =', handle.handle.slice(0, 20), '…');

  // 4. Decrypt via gateway (runner privilege).
  const cleartextHex = await fhe.decrypt(handle.handle, CONTEXT_V2);
  const recoveredKey = hexToKey32(cleartextHex);
  if (Buffer.compare(Buffer.from(recoveredKey), Buffer.from(enc.key)) !== 0) {
    throw new Error('Fhenix roundtrip key mismatch');
  }
  console.log('✓ AES key roundtrip via Fhenix gateway');

  // 5. Fetch ciphertext from Pinata + AES-GCM decrypt.
  const fetched = await pinata.fetch(cid);
  const recoveredText = aesGcmDecryptServer({ ciphertext: fetched, key: recoveredKey, iv: enc.iv });
  if (new TextDecoder().decode(recoveredText) !== SAMPLE) {
    throw new Error('AES roundtrip plaintext mismatch');
  }
  console.log('✓ AES roundtrip: bytes match');
  console.log('SMOKE PASS');
}

main().catch((e) => { console.error('SMOKE FAIL', e); process.exit(1); });
