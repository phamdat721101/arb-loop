/* eslint-disable no-console */
/**
 * smoke-arbloop-translation.ts — full Day-1 lighthouse demo.
 *
 * 7-step end-to-end:
 *   1. POST /v3/arbloop/concierge/search "translate this NDA to vietnamese"
 *      → asserts ≥1 candidate with mode=='x402'.
 *   2. AES-encrypt sample NDA bytes client-side.
 *   3. Upload ciphertext to Pinata (server-signed upload endpoint).
 *   4. Build Fhenix euint256 handle for the AES key.
 *   5. POST /agents/:id/invoke without payment → 402.
 *   6. Sign EIP-3009; retry → 200 + response_cid + enc_response_handle.
 *   7. Server-side gateway.decrypt + AES-decrypt → assert non-empty Vietnamese
 *      output; print first 200 chars.
 *
 * Usage:
 *   API_URL=... BUYER_PRIVATE_KEY=... \
 *   PINATA_JWT=... ARBLOOP_FHENIX_GATEWAY_URL=... \
 *   ARBLOOP_RUNNER_PRIVATE_KEY=... \
 *     npm run smoke:arbloop-translation
 */

import { Wallet } from 'ethers';
import {
  buildEip3009TypedData,
  USDC_DOMAINS,
  type X402Challenge,
  aesGcmEncryptServer,
  aesGcmDecryptServer,
  hexToKey32,
} from '@fhe-ai-context/sdk';
import {
  loadFheGatewayFromEnv,
  loadPinataFromEnv,
} from '../packages/api/src/services/arbloop/fheGateway';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const BUYER_KEY = process.env.BUYER_PRIVATE_KEY ?? process.env.PHAM_PRIVATE_KEY ?? '';
const CONTEXT_V2 = (process.env.ARBLOOP_CONFIDENTIAL_AI_CONTEXT_V2_ADDRESS ?? '0x0') as `0x${string}`;

const SAMPLE_NDA = `
NON-DISCLOSURE AGREEMENT

This Non-Disclosure Agreement (the "Agreement") is entered into by and between
the parties identified below.

1. CONFIDENTIAL INFORMATION
1.1 The Disclosing Party agrees to share certain confidential information.
1.2 The Receiving Party agrees to maintain such information in confidence.

2. NON-USE
The Receiving Party shall not use the Confidential Information for any purpose
other than the evaluation of a potential business relationship.
`.trim();

async function main() {
  if (!BUYER_KEY) throw new Error('BUYER_PRIVATE_KEY required');
  const buyer = new Wallet(BUYER_KEY);
  const t0 = Date.now();

  // 1. Concierge search.
  const r0 = await fetch(`${API_URL}/v3/arbloop/concierge/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: 'translate this NDA to vietnamese',
      buyer_address: buyer.address,
    }),
  });
  if (!r0.ok) throw new Error(`concierge:${r0.status}`);
  const concierge = await r0.json();
  const x402Candidate = concierge.candidates?.find((c: { mode: string }) => c.mode === 'x402');
  if (!x402Candidate) throw new Error(`no x402 candidate in: ${JSON.stringify(concierge.candidates)}`);
  console.log('✓ concierge matched agent_id =', x402Candidate.agent_id);
  const agentId = Number(x402Candidate.agent_id);

  // 2. AES-encrypt NDA bytes.
  const ndaBytes = new TextEncoder().encode(SAMPLE_NDA);
  const enc = aesGcmEncryptServer(ndaBytes);
  console.log('✓ AES encrypted (', ndaBytes.length, 'bytes)');

  // 3. Pinata put.
  const pinata = loadPinataFromEnv();
  const sourceCid = await pinata.put(enc.ciphertext, 'sample-NDA.bin');
  console.log('✓ Pinata CID =', sourceCid);

  // 4. Fhenix encrypt key for buyer.
  const fhe = loadFheGatewayFromEnv();
  const valueHex = ('0x' + Buffer.from(enc.key).toString('hex')) as `0x${string}`;
  const handle = await fhe.encryptForAddress({ valueHex, recipient: buyer.address as `0x${string}`, contractAddr: CONTEXT_V2 });
  const ivHex = ('0x' + Buffer.from(enc.iv).toString('hex')) as `0x${string}`;
  console.log('✓ Fhenix handle ready');

  // 5+6. x402 invoke.
  const url = `${API_URL}/v3/arbloop/agents/${agentId}/invoke`;
  const body = {
    text: 'translate this NDA to vietnamese',
    source_doc_ipfs_cid: sourceCid,
    source_doc_aes_key_handle: handle.handle,
    source_doc_iv: ivHex,
  };
  const r1 = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status}`);
  const challenge: X402Challenge = await r1.json();
  const accept = challenge.accepts[0];

  const td = buildEip3009TypedData({
    domain: USDC_DOMAINS.arbitrumSepolia,
    from: buyer.address as `0x${string}`,
    to: accept.pay_to,
    valueMicroUsdc: BigInt(accept.max_amount_required),
  });
  const signature = await buyer.signTypedData(
    td.domain,
    { TransferWithAuthorization: td.types.TransferWithAuthorization },
    td.message,
  );
  const xPayment = Buffer.from(JSON.stringify({
    x402_version: '1.0', scheme: 'exact', network: 'arbitrum-sepolia', signature,
    authorization: {
      ...td.message,
      value: td.message.value.toString(),
      validAfter: td.message.validAfter.toString(),
      validBefore: td.message.validBefore.toString(),
    },
  })).toString('base64');
  const r2 = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-PAYMENT': xPayment }, body: JSON.stringify(body) });
  const j = await r2.json();
  if (r2.status !== 200) throw new Error(`invoke:${r2.status}:${JSON.stringify(j)}`);
  console.log('✓ invoked. response_cid =', j.response_cid);
  console.log('  settlement_tx =', j.settlement_tx);

  // 7. Decrypt result.
  const responseClearHex = await fhe.decrypt(j.enc_response_handle, CONTEXT_V2);
  const responseAesKey = hexToKey32(responseClearHex);
  const responseCt = await pinata.fetch(j.response_cid);
  const responseIv = new Uint8Array(12);
  const ivHex2 = j.response_iv.startsWith('0x') ? j.response_iv.slice(2) : j.response_iv;
  for (let i = 0; i < 12; i++) responseIv[i] = parseInt(ivHex2.slice(i * 2, i * 2 + 2), 16);
  const responseBytes = aesGcmDecryptServer({ ciphertext: responseCt, key: responseAesKey, iv: responseIv });
  const translation = new TextDecoder().decode(responseBytes);
  if (translation.length < 50) throw new Error(`translation too short: ${translation}`);
  console.log('✓ translation decrypted (', translation.length, 'chars):');
  console.log('  ', translation.slice(0, 200), '…');

  const ms = Date.now() - t0;
  console.log(`SMOKE PASS · ${ms}ms wall clock (target <120s for ship-day demo)`);
  if (ms > 120_000) console.warn('⚠ wall clock exceeded 120s target');
}

main().catch((e) => { console.error('SMOKE FAIL', e); process.exit(1); });
