'use client';
/**
 * hooks/useFheJobResults.ts — buyer-side decrypt + download.
 *
 * Two paths:
 *   A. x402 fast lane: response body already includes
 *      { response_cid, enc_response_handle, response_iv }.
 *      Hook fetches IPFS, asks the gateway to decrypt the AES key (gateway
 *      enforces ConfidentialAIContextV2.access[buyer]==true), AES-GCM
 *      decrypts the blob, triggers download.
 *
 *   B. loop hire: hook reads FheLoopMemory.iterResults(iterN) on-chain
 *      (wagmi useReadContract), then runs the same decrypt+download path.
 *
 * SOLID: SRP — one hook owns the decrypt+download UX. Crypto primitives
 * imported from @fhe-ai-context/sdk.
 */

import { useCallback, useState } from 'react';
import { aesGcmDecrypt, ipfsFetch } from '@fhe-ai-context/sdk';
import { ARBLOOP_API_URL } from '@/lib/arbloop';

export interface DecryptArgs {
  responseCid: string;
  encResponseHandle: `0x${string}`;
  responseIv: `0x${string}`;
  contextV2Address: `0x${string}`;
  /** Buyer wallet — must match the recipient encoded in the FHE handle. */
  buyerAddress: `0x${string}`;
  /** Optional download filename. */
  filename?: string;
  /** MIME type for download blob. */
  mimeType?: string;
  /** Buyer's wallet signature over a permit message (proves wallet control). */
  walletPermitSignature?: `0x${string}`;
}

export function useFheJobResults() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decryptAndDownload = useCallback(async (args: DecryptArgs): Promise<Uint8Array> => {
    setIsLoading(true);
    setError(null);
    try {
      // 1. Ask the gateway (via API proxy) to decrypt the AES key for the buyer.
      const r = await fetch(`${ARBLOOP_API_URL}/v3/arbloop/fhe/decrypt-for-buyer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          handle: args.encResponseHandle,
          contract_address: args.contextV2Address,
          buyer_address: args.buyerAddress,
          permit_signature: args.walletPermitSignature ?? null,
        }),
      });
      if (!r.ok) throw new Error(`decrypt-for-buyer:${r.status}:${await r.text()}`);
      const { cleartext_hex }: { cleartext_hex: string } = await r.json();

      // 2. Hex → 32-byte AES key.
      const clean = cleartext_hex.startsWith('0x') ? cleartext_hex.slice(2) : cleartext_hex;
      const key = new Uint8Array(32);
      for (let i = 0; i < 32; i++) key[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);

      // 3. Fetch ciphertext from IPFS.
      const ciphertext = await ipfsFetch(args.responseCid);

      // 4. Decode IV.
      const ivHex = args.responseIv.startsWith('0x') ? args.responseIv.slice(2) : args.responseIv;
      const iv = new Uint8Array(12);
      for (let i = 0; i < 12; i++) iv[i] = parseInt(ivHex.slice(i * 2, i * 2 + 2), 16);

      // 5. AES-GCM decrypt.
      const plaintext = await aesGcmDecrypt({ ciphertext, iv, key });

      // 6. Trigger download.
      if (typeof window !== 'undefined') {
        const blob = new Blob([plaintext as unknown as BlobPart], { type: args.mimeType ?? 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = args.filename ?? `arbloop-result-${Date.now()}.bin`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
      return plaintext;
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { decryptAndDownload, isLoading, error };
}
