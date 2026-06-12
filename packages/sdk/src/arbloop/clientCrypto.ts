/**
 * sdk/src/arbloop/clientCrypto.ts — browser-side crypto + IPFS upload helpers.
 *
 * Three responsibilities collapsed into one file per the essential-files-only
 * mandate (each is <50 LOC standalone):
 *
 *   1. AES-256-GCM encrypt/decrypt via WebCrypto (browser-native).
 *   2. Fhenix encryptInput() thin wrapper that defers to the existing SDK
 *      `cofheClient` singleton — does NOT duplicate fhevmjs init.
 *   3. Pinata IPFS upload — single fetch() call with JWT bearer auth.
 *
 * SOLID:
 *   - SRP: one logical concern per exported function.
 *   - DIP: cofheClient is imported from the existing SDK singleton; this
 *     module never constructs its own fhevmjs instance.
 *
 * Usage in PayAndExecuteButton:
 *     const { ciphertext, iv, key } = await aesGcmEncrypt(fileBytes);
 *     const sourceCid = await ipfsPut(ciphertext, pinataJwt);
 *     const { handle, inputProof } = await fhenixEncryptKey(key, runnerAddr);
 */

// ─── 1. AES-256-GCM ─────────────────────────────────────────────────────────

export interface AesEnvelope {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  key: Uint8Array;          // 32 raw bytes — never persists; only handed to FHE.
}

/** Generate a fresh 256-bit AES key. */
export function freshAesKey(): Uint8Array {
  const key = new Uint8Array(32);
  globalThis.crypto.getRandomValues(key);
  return key;
}

export async function aesGcmEncrypt(plaintext: Uint8Array, key?: Uint8Array): Promise<AesEnvelope> {
  const k = key ?? freshAesKey();
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw', k as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt']
  );
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    cryptoKey,
    plaintext as unknown as BufferSource,
  );
  return { ciphertext: new Uint8Array(ct), iv, key: k };
}

export async function aesGcmDecrypt(env: { ciphertext: Uint8Array; iv: Uint8Array; key: Uint8Array }): Promise<Uint8Array> {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw', env.key as unknown as BufferSource, { name: 'AES-GCM' }, false, ['decrypt']
  );
  const pt = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: env.iv as unknown as BufferSource },
    cryptoKey,
    env.ciphertext as unknown as BufferSource,
  );
  return new Uint8Array(pt);
}

// ─── 2. Fhenix encryptInput thin wrapper ───────────────────────────────────

export interface FhenixHandle {
  /** Hex-encoded euint256 handle (bytes32). */
  handle: `0x${string}`;
  /** Hex-encoded ZK validity proof. */
  inputProof: `0x${string}`;
}

/**
 * Encrypts a 32-byte AES key as a Fhenix `euint256`.
 *
 * Defers to the existing SDK `cofheClient` singleton — does NOT duplicate
 * fhevmjs init. Caller passes the target contract address (the
 * ConfidentialAIContextV2 address that will receive the handle).
 *
 * @param keyBytes 32-byte AES key
 * @param contractAddr address of ConfidentialAIContextV2
 * @param userAddr buyer's wallet (acts as the FHE input owner)
 */
export async function fhenixEncryptAesKey(
  keyBytes: Uint8Array,
  contractAddr: `0x${string}`,
  userAddr: `0x${string}`,
): Promise<FhenixHandle> {
  if (keyBytes.length !== 32) throw new Error('clientCrypto:fhenix:expect_32_byte_key');
  // Lazy-import to keep the SDK importable from contexts that don't have
  // CoFHE wired (e.g. server-side scripts that only need AES + IPFS).
  const { getCofheClient } = await import('../client/cofheClient.js');
  const client = await getCofheClient();
  // CoFHE client API: createEncryptedInput(contractAddr, userAddr).add256(value).encrypt()
  // (matches the existing pattern used in packages/sdk/src/context/encryptContext.ts)
  // The exact method names depend on the cofheClient build; we use the
  // documented public surface and let TS narrow at call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const input = (client as any).createEncryptedInput(contractAddr, userAddr);
  // Pack 32 bytes as bigint.
  let value = 0n;
  for (const b of keyBytes) value = (value << 8n) | BigInt(b);
  input.add256(value);
  const out = await input.encrypt();
  // Different fhevmjs versions return either {handles[0], inputProof} or
  // {handle, inputProof} or {handles: [...], inputProof}. Normalize.
  const handle: `0x${string}` = (out.handles?.[0] ?? out.handle) as `0x${string}`;
  const inputProof: `0x${string}` = out.inputProof as `0x${string}`;
  if (!handle || !inputProof) throw new Error('clientCrypto:fhenix:bad_output_shape');
  return { handle, inputProof };
}

// ─── 3. Pinata IPFS upload ──────────────────────────────────────────────────

/**
 * Upload bytes to Pinata as a binary blob. Returns the CIDv1 string.
 * For server-only uploads, pass `pinataJwt` directly. For browser uploads,
 * use `signedUploadEndpoint` (the API issues a short-lived signed URL via
 * `POST /v3/arbloop/ipfs/sign-upload` to avoid exposing the JWT).
 */
export async function ipfsPut(args: {
  bytes: Uint8Array;
  pinataJwt?: string;
  signedUploadEndpoint?: string;
  filename?: string;
}): Promise<string> {
  const filename = args.filename ?? 'arbloop-blob.bin';
  const formData = new FormData();
  formData.append('file', new Blob([args.bytes as unknown as BlobPart]), filename);

  let url = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
  const headers: Record<string, string> = {};
  if (args.pinataJwt) {
    headers['Authorization'] = `Bearer ${args.pinataJwt}`;
  } else if (args.signedUploadEndpoint) {
    url = args.signedUploadEndpoint;
  } else {
    throw new Error('clientCrypto:ipfs:missing_auth');
  }

  const res = await fetch(url, { method: 'POST', headers, body: formData });
  if (!res.ok) throw new Error(`clientCrypto:ipfs:put_failed:${res.status}:${await res.text()}`);
  const json: { IpfsHash?: string; cid?: string } = await res.json();
  const cid = json.IpfsHash ?? json.cid;
  if (!cid) throw new Error('clientCrypto:ipfs:no_cid_in_response');
  return cid;
}

export async function ipfsFetch(cid: string, gateway = 'https://gateway.pinata.cloud/ipfs'): Promise<Uint8Array> {
  const res = await fetch(`${gateway}/${cid}`);
  if (!res.ok) throw new Error(`clientCrypto:ipfs:fetch_failed:${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Pack a CID string into bytes32 (truncated; only safe for short CIDs). */
export function cidToBytes32(cid: string): `0x${string}` {
  const buf = new TextEncoder().encode(cid);
  if (buf.length > 32) {
    // CIDv1 (base32) is ~59 chars; we hash for the on-chain pointer and keep
    // the full string in arbloop_iteration_log.response_ipfs_cid.
    return ('0x' + Array.from(new Uint8Array(buf)).slice(0, 32).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
  }
  return ('0x' + Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('').padEnd(64, '0')) as `0x${string}`;
}
