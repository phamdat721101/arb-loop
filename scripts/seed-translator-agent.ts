/* eslint-disable no-console */
/**
 * scripts/seed-translator-agent.ts — bootstraps the EN→VI translator agent
 * onto AgentRegistryV2 via the gasless EIP-712 path.
 *
 * Usage:
 *   API_URL=https://13-229-63-192.sslip.io \
 *   PHAM_PRIVATE_KEY=0x... \
 *   ARBLOOP_AGENT_REGISTRY_V2_ADDRESS=0x... \
 *     npm run seed:translator
 *
 * Output: prints agent_id + tx_hash + persona_namespace_address.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Wallet, JsonRpcProvider } from 'ethers';
import {
  buildPublishAgentTypedData,
  freshPublishNonce,
} from '@fhe-ai-context/sdk';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const RPC_URL = process.env.RPC_URL_ARBITRUM_SEPOLIA ?? 'https://sepolia-rollup.arbitrum.io/rpc';
const SELLER_KEY = process.env.PHAM_PRIVATE_KEY ?? process.env.SELLER_PRIVATE_KEY ?? '';
const REGISTRY_V2 = (process.env.ARBLOOP_AGENT_REGISTRY_V2_ADDRESS ?? '') as `0x${string}`;
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 421614);

async function main() {
  if (!SELLER_KEY) throw new Error('PHAM_PRIVATE_KEY required');
  if (!REGISTRY_V2) throw new Error('ARBLOOP_AGENT_REGISTRY_V2_ADDRESS required');

  const seller = new Wallet(SELLER_KEY, new JsonRpcProvider(RPC_URL));
  console.log('seller:', seller.address);

  const manifestPath = path.resolve(__dirname, '../examples/translator/manifest.yaml');
  const manifestYaml = await fs.readFile(manifestPath, 'utf8');

  // Hash manifest to bytes32 (full YAML uploaded by relayer to Pinata).
  const enc = new TextEncoder().encode(manifestYaml);
  const hashBuf = await crypto.subtle.digest('SHA-256', enc);
  const manifestIpfsCid: `0x${string}` = ('0x' + Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;

  const nonce = freshPublishNonce();
  const deadlineSec = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const td = buildPublishAgentTypedData({
    chainId: CHAIN_ID,
    registryV2Address: REGISTRY_V2,
    seller: seller.address as `0x${string}`,
    manifestIpfsCid,
    defaultBackend: 'bedrock',
    defaultModel: 'us.anthropic.claude-opus-4-6-v1',
    perIterMinMicroUsdc: 750_000n,
    perIterDefaultMicroUsdc: 1_500_000n,
    maxIter: 1,
    deadlineSec,
    nonce,
  });

  const signature = await seller.signTypedData(
    td.domain,
    { PublishAgent: td.types.PublishAgent },
    td.message,
  );
  console.log('signature:', signature.slice(0, 18), '…');

  const r = await fetch(`${API_URL}/v3/arbloop/agents/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      seller_address: seller.address,
      title: 'Legal NDA Translator (EN→VI)',
      short_description: 'Translates English NDAs into Vietnamese, preserves clause numbering.',
      per_iter_default_micro_usdc: 1_500_000,
      per_iter_min_micro_usdc: 750_000,
      max_iter_per_job: 1,
      default_inference_backend: 'bedrock',
      default_model_id: 'us.anthropic.claude-opus-4-6-v1',
      manifest_yaml: manifestYaml,
      seller_signature: signature,
      publish_nonce: nonce.toString(),
      publish_deadline: deadlineSec.toString(),
    }),
  });

  const j = await r.json();
  if (!r.ok) throw new Error(`publish_failed:${r.status}:${JSON.stringify(j)}`);
  console.log('✓ published agent_id =', j.agent_id);
  console.log('  tx_hash =', j.tx_hash);
  console.log('  persona_namespace_address =', j.persona_namespace_address);
  console.log('  manifest_ipfs_cid =', j.manifest_ipfs_cid);
  console.log('  mode =', j.mode);
  console.log('  agent_registry_version =', j.agent_registry_version);
  console.log('  gas_paid_by =', j.gas_paid_by);
}

main().catch((e) => { console.error(e); process.exit(1); });
