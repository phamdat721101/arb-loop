/* eslint-disable no-console */
/**
 * smoke-arbloop-gasless-publish.ts
 *
 * Asserts: seller signs ONE EIP-712 message; relayer pays gas; on-chain
 * AgentRegistryV2.agents[id].seller == seller.address (NOT relayer).
 *
 * Usage:
 *   API_URL=... PHAM_PRIVATE_KEY=... ARBLOOP_AGENT_REGISTRY_V2_ADDRESS=... \
 *     npm run smoke:arbloop-gasless-publish
 */

import { Wallet, JsonRpcProvider, Contract } from 'ethers';
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
  if (!SELLER_KEY || !REGISTRY_V2) throw new Error('env missing: PHAM_PRIVATE_KEY + ARBLOOP_AGENT_REGISTRY_V2_ADDRESS');
  const seller = new Wallet(SELLER_KEY);
  console.log('seller:', seller.address);

  const manifestYaml = `kind: loop\nmode: x402\ntitle: Smoke Translator\n`;
  const enc = new TextEncoder().encode(manifestYaml);
  const hashBuf = await crypto.subtle.digest('SHA-256', enc);
  const manifestIpfsCid = ('0x' + Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;

  const nonce = freshPublishNonce();
  const deadlineSec = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const td = buildPublishAgentTypedData({
    chainId: CHAIN_ID, registryV2Address: REGISTRY_V2, seller: seller.address as `0x${string}`,
    manifestIpfsCid, defaultBackend: 'bedrock', defaultModel: 'claude-opus-4-6',
    perIterMinMicroUsdc: 500_000n, perIterDefaultMicroUsdc: 1_000_000n, maxIter: 1,
    deadlineSec, nonce,
  });
  const signature = await seller.signTypedData(td.domain, { PublishAgent: td.types.PublishAgent }, td.message);

  const r = await fetch(`${API_URL}/v3/arbloop/agents/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      seller_address: seller.address,
      title: 'smoke-' + Date.now(),
      short_description: 'gasless publish smoke',
      per_iter_default_micro_usdc: 1_000_000,
      per_iter_min_micro_usdc: 500_000,
      max_iter_per_job: 1,
      default_inference_backend: 'bedrock',
      default_model_id: 'claude-opus-4-6',
      manifest_yaml: manifestYaml,
      seller_signature: signature,
      publish_nonce: nonce.toString(),
      publish_deadline: deadlineSec.toString(),
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`publish_failed: ${JSON.stringify(j)}`);
  console.log('✓ published. agent_id =', j.agent_id, 'tx =', j.tx_hash);

  // Assert on-chain seller == seller.address
  const provider = new JsonRpcProvider(RPC_URL);
  const registry = new Contract(REGISTRY_V2, [
    'function getAgent(uint256) view returns ((address seller, bytes32 manifestIpfsCid, string, string, uint256, uint256, uint256, address, uint256, uint256, uint256, uint256, bool))',
  ], provider);
  const agent = await registry.getAgent(j.agent_id);
  if (agent.seller.toLowerCase() !== seller.address.toLowerCase()) {
    throw new Error(`Drift #2 NOT FIXED: on-chain seller=${agent.seller}, signer=${seller.address}`);
  }
  console.log('✓ on-chain seller == signer (Drift #2 fixed)');
  console.log('SMOKE PASS');
}

main().catch((e) => { console.error('SMOKE FAIL', e); process.exit(1); });
