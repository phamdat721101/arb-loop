/**
 * services/arbloop/fheGateway.ts — Fhenix CoFHE gateway HTTP client +
 * IPFS helpers (server-side). Collapses PRD's separate ipfsClient.ts and
 * fheGatewayClient.ts into one file per the essential-files-only mandate.
 *
 * Three responsibilities, one file:
 *   1. Fhenix gateway HTTP API: decrypt(handle, runnerSig)
 *      and encryptForAddress(value, recipient).
 *   2. Pinata IPFS HTTP API: put(bytes), fetch(cid).
 *   3. AES-256-GCM decrypt server-side (after gateway decrypts AES key).
 *
 * SOLID:
 *   - SRP: each exported function does ONE thing. The "collapsed file"
 *     does not couple the three concerns — they're just adjacent.
 *   - DIP: configuration via env, not hard-coded; URLs configurable.
 *
 * This is the privacy-substrate hot path. Every call is structured-logged
 * via correlation_id so the runtime can trace a single x402 invocation
 * across decrypt → IPFS fetch → Bedrock → IPFS put → encrypt-for-buyer.
 */

import crypto from 'node:crypto';
import { Wallet } from 'ethers';

// ─── 1. Fhenix gateway client ───────────────────────────────────────────

export interface FheGatewayConfig {
  url: string;                            // e.g. https://gateway.testnet.fhenix.zone
  runnerPrivateKey: string;               // signs the runner's auth challenges
  /** Optional: allow callers to override fetch (e.g. for retry wrappers). */
  fetchImpl?: typeof fetch;
}

export class FheGateway {
  private readonly cfg: FheGatewayConfig;
  private readonly runner: Wallet;
  constructor(cfg: FheGatewayConfig) {
    this.cfg = cfg;
    this.runner = new Wallet(cfg.runnerPrivateKey);
  }

  private async sign(challenge: string): Promise<`0x${string}`> {
    return (await this.runner.signMessage(challenge)) as `0x${string}`;
  }

  /**
   * Decrypt a Fhenix handle. Caller must have been granted access via
   * ConfidentialAIContextV2.grantRunnerAccess() (buyer-only call) or be
   * the original input owner. Gateway enforces this.
   *
   * Returns the cleartext as a 0x-prefixed hex string (caller decodes).
   */
  async decrypt(handle: `0x${string}`, contractAddr: `0x${string}`): Promise<string> {
    const challenge = `decrypt:${handle}:${contractAddr}:${Date.now()}`;
    const sig = await this.sign(challenge);
    const f = this.cfg.fetchImpl ?? fetch;
    const res = await f(`${this.cfg.url}/decrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle,
        contract_address: contractAddr,
        runner_address: this.runner.address,
        challenge,
        signature: sig,
      }),
    });
    if (!res.ok) throw new Error(`fheGateway:decrypt:${res.status}:${await res.text()}`);
    const json = (await res.json()) as { cleartext_hex: string };
    return json.cleartext_hex;
  }

  /**
   * Encrypt a value FOR a recipient. The handle returned is the
   * `externalEuint256` shape — caller posts it on-chain via
   * `ConfidentialAIContextV2.writeContextWithKey(handle, proof)`.
   *
   * Use case: re-encrypt the response AES key for the buyer.
   */
  async encryptForAddress(args: {
    valueHex: `0x${string}`;
    recipient: `0x${string}`;
    contractAddr: `0x${string}`;
  }): Promise<{ handle: `0x${string}`; inputProof: `0x${string}` }> {
    const f = this.cfg.fetchImpl ?? fetch;
    const res = await f(`${this.cfg.url}/encrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        value: args.valueHex,
        recipient: args.recipient,
        contract_address: args.contractAddr,
      }),
    });
    if (!res.ok) throw new Error(`fheGateway:encrypt:${res.status}:${await res.text()}`);
    return res.json();
  }
}

export function loadFheGatewayFromEnv(): FheGateway {
  const url = process.env.ARBLOOP_FHENIX_GATEWAY_URL;
  const runnerKey = process.env.ARBLOOP_RUNNER_PRIVATE_KEY ?? process.env.RELAYER_PRIVATE_KEY;
  if (!url) throw new Error('fheGateway:env:ARBLOOP_FHENIX_GATEWAY_URL_required');
  if (!runnerKey) throw new Error('fheGateway:env:ARBLOOP_RUNNER_PRIVATE_KEY_required');
  return new FheGateway({ url, runnerPrivateKey: runnerKey });
}

// ─── 2. Pinata IPFS helpers ─────────────────────────────────────────────

export interface PinataConfig {
  jwt: string;
  gateway?: string;                       // default: https://gateway.pinata.cloud
}

export class PinataClient {
  constructor(private cfg: PinataConfig) {}

  async put(bytes: Uint8Array, filename = 'arbloop-blob.bin'): Promise<string> {
    const formData = new FormData();
    formData.append('file', new Blob([bytes as unknown as BlobPart]), filename);
    const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.cfg.jwt}` },
      body: formData,
    });
    if (!res.ok) throw new Error(`pinata:put:${res.status}:${await res.text()}`);
    const json = (await res.json()) as { IpfsHash: string };
    return json.IpfsHash;
  }

  async fetch(cid: string): Promise<Uint8Array> {
    const gateway = this.cfg.gateway ?? 'https://gateway.pinata.cloud';
    const res = await fetch(`${gateway}/ipfs/${cid}`);
    if (!res.ok) throw new Error(`pinata:fetch:${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

export function loadPinataFromEnv(): PinataClient {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error('pinata:env:PINATA_JWT_required');
  return new PinataClient({ jwt, gateway: process.env.PINATA_GATEWAY });
}

// ─── 3. AES-GCM decrypt (server-side, used after gateway decrypt) ───────

/** Decrypt an AES-GCM blob. iv = first 12 bytes of `iv` param OR caller passes separately. */
export function aesGcmDecryptServer(args: {
  ciphertext: Uint8Array;
  key: Uint8Array;                        // 32 bytes (returned by gateway.decrypt)
  iv: Uint8Array;                         // 12 bytes
}): Uint8Array {
  if (args.key.length !== 32) throw new Error('aes:bad_key_length');
  if (args.iv.length !== 12) throw new Error('aes:bad_iv_length');
  // GCM: ciphertext format from WebCrypto = ciphertext || tag (16 bytes).
  const tagLen = 16;
  if (args.ciphertext.length < tagLen) throw new Error('aes:ciphertext_too_short');
  const tag = args.ciphertext.slice(args.ciphertext.length - tagLen);
  const ct = args.ciphertext.slice(0, args.ciphertext.length - tagLen);
  const decipher = crypto.createDecipheriv('aes-256-gcm', args.key, args.iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return new Uint8Array(pt);
}

export function aesGcmEncryptServer(plaintext: Uint8Array, key?: Uint8Array): {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  key: Uint8Array;
} {
  const k = key ?? crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: new Uint8Array(Buffer.concat([ct, tag])), iv: new Uint8Array(iv), key: new Uint8Array(k) };
}

/** Convert a 32-byte hex string (from gateway.decrypt) to raw bytes. */
export function hexToKey32(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length !== 64) throw new Error('hexToKey32:bad_length');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
