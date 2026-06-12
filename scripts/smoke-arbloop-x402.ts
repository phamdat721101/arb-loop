/* eslint-disable no-console */
/**
 * smoke-arbloop-x402.ts
 *
 * Asserts the x402 fast lane:
 *   1. POST /agents/:id/invoke without X-PAYMENT → 402 + challenge.
 *   2. Sign EIP-3009 typed-data with buyer wallet.
 *   3. Retry with X-PAYMENT → 200 + response_cid + enc_response_handle.
 *   4. Decode X-PAYMENT-RESPONSE header → settlement tx hash present.
 *
 * Usage:
 *   API_URL=... BUYER_PRIVATE_KEY=... AGENT_ID=42 \
 *     npm run smoke:arbloop-x402
 */

import { Wallet } from 'ethers';
import {
  buildEip3009TypedData,
  USDC_DOMAINS,
  type X402Challenge,
} from '@fhe-ai-context/sdk';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const BUYER_KEY = process.env.BUYER_PRIVATE_KEY ?? process.env.PHAM_PRIVATE_KEY ?? '';
const AGENT_ID = process.env.AGENT_ID ?? '0';

async function main() {
  if (!BUYER_KEY) throw new Error('BUYER_PRIVATE_KEY required');
  const buyer = new Wallet(BUYER_KEY);
  const url = `${API_URL}/v3/arbloop/agents/${AGENT_ID}/invoke`;

  // 1. Initial call → expect 402.
  const r1 = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'translate this NDA to vietnamese: This Agreement...' }),
  });
  if (r1.status !== 402) throw new Error(`expected 402, got ${r1.status}`);
  const challenge: X402Challenge = await r1.json();
  console.log('✓ challenge envelope received');

  const accept = challenge.accepts?.[0];
  if (!accept) throw new Error('no accept in challenge');

  // 2. Sign EIP-3009.
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
  console.log('✓ signed EIP-3009');

  const xPayment = Buffer.from(JSON.stringify({
    x402_version: '1.0',
    scheme: 'exact',
    network: 'arbitrum-sepolia',
    signature,
    authorization: {
      ...td.message,
      value: td.message.value.toString(),
      validAfter: td.message.validAfter.toString(),
      validBefore: td.message.validBefore.toString(),
    },
  })).toString('base64');

  // 3. Retry with X-PAYMENT.
  const r2 = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-PAYMENT': xPayment },
    body: JSON.stringify({ text: 'translate this NDA to vietnamese: This Agreement...' }),
  });
  const j = await r2.json();
  if (r2.status !== 200) throw new Error(`expected 200, got ${r2.status}: ${JSON.stringify(j)}`);
  if (!j.ok || !j.response_cid || !j.enc_response_handle) throw new Error(`bad response: ${JSON.stringify(j)}`);

  console.log('✓ 200 OK. response_cid =', j.response_cid);
  console.log('  enc_response_handle =', j.enc_response_handle.slice(0, 20), '…');
  console.log('  settlement_tx =', j.settlement_tx);

  // 4. Verify X-PAYMENT-RESPONSE header.
  const xpr = r2.headers.get('X-PAYMENT-RESPONSE');
  if (!xpr) throw new Error('missing X-PAYMENT-RESPONSE header');
  const decoded = JSON.parse(Buffer.from(xpr, 'base64').toString('utf8'));
  if (!decoded.tx_hash) throw new Error('no tx_hash in payment-response');
  console.log('✓ X-PAYMENT-RESPONSE tx_hash =', decoded.tx_hash);
  console.log('SMOKE PASS');
}

main().catch((e) => { console.error('SMOKE FAIL', e); process.exit(1); });
