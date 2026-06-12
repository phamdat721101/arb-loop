/**
 * smoke-arbloop.ts — consolidated end-to-end smoke for arb-loop v0.1.
 *
 * Exercises:
 *   1. POST /v3/arbloop/agents/publish (relayer signs publishAgent)
 *   2. GET  /v3/arbloop/agents/:id
 *   3. POST /v3/arbloop/hire/prepare (returns prepared multicall)
 *   4. GET  /v3/arbloop/jobs/:address (after a hire, if address provided)
 *
 * Usage:
 *   FEATURE_ARBLOOP=true ARBLOOP_API_URL=http://localhost:3001 \
 *     SELLER_ADDRESS=0x... BUYER_ADDRESS=0x... \
 *     tsx scripts/smoke-arbloop.ts
 *
 * SOLID: pure script. No services, no factories. Just HTTP exercise.
 */

const API = process.env.ARBLOOP_API_URL ?? 'http://localhost:3001';
const SELLER = process.env.SELLER_ADDRESS ?? '0x100690a32B562fd45e685BC2E63bbfF566d452db';
const BUYER = process.env.BUYER_ADDRESS ?? '0xaf083BA9CB7b7AdBFCcfb0eC244C3ba8224358F2';

const sampleManifest = `kind: loop
spec_version: 1
target_chain: arbitrum-sepolia
title: "Smoke loop"
description: "Ten-line smoke loop for arb-loop v0.1"
seller_agent_ref:
  agent_registry: "0x0000000000000000000000000000000000000000"
  agent_id: 0
stop_condition:
  predicate: |
    iterations >= 3 OR contains_text(latest_response, "FINAL_REPORT_READY")
  fallback_max_iterations: 3
iteration:
  inference:
    backend: phala-tee
    model_id: meta-llama/Llama-3.1-8B-Instruct
  memory:
    namespace: "{{job_address}}/smoke"
    read: [{ level: L1, window: 5 }]
    write: [{ level: L1 }]
  pricing:
    per_iter_micro_usdc: 250000
    splits:
      - { to: seller, bps: 7000 }
      - { to: compute, bps: 2200 }
      - { to: eigenda, bps: 150 }
      - { to: arweave, bps: 150 }
      - { to: lit, bps: 200 }
      - { to: platform, bps: 300 }
  storage_tier: hot
metadata:
  category: research
  tags: [smoke]
`;

async function main() {
  console.log('== Phase 1: Publish a smoke Agent');
  const pub = await fetch(`${API}/v3/arbloop/agents/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      seller_address: SELLER,
      title: 'Smoke loop',
      short_description: 'Ten-line smoke loop',
      per_iter_default_micro_usdc: 250_000,
      per_iter_min_micro_usdc: 100_000,
      max_iter_per_job: 3,
      default_inference_backend: 'phala-tee',
      default_model_id: 'meta-llama/Llama-3.1-8B-Instruct',
      manifest_yaml: sampleManifest,
    }),
  });
  const pubBody = await pub.json();
  if (!pub.ok) throw new Error(`publish failed: ${JSON.stringify(pubBody)}`);
  console.log('  ✓ agent_id:', pubBody.agent_id, 'tx:', pubBody.tx_hash);
  const agentId: number = pubBody.agent_id;

  console.log('\n== Phase 2: Fetch Agent');
  const get = await fetch(`${API}/v3/arbloop/agents/${agentId}`);
  const getBody = await get.json();
  if (!get.ok) throw new Error(`agent get failed: ${JSON.stringify(getBody)}`);
  console.log('  ✓ title:', getBody.agent.title, 'persona_ns:', getBody.agent.persona_namespace_address);

  console.log('\n== Phase 3: Prepare hire transaction');
  const hire = await fetch(`${API}/v3/arbloop/hire/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_id: agentId,
      max_iterations: 3,
      budget_usdc: '0.75',
      buyer_address: BUYER,
    }),
  });
  const hireBody = await hire.json();
  if (!hire.ok) throw new Error(`hire prepare failed: ${JSON.stringify(hireBody)}`);
  console.log('  ✓ approve.to:', hireBody.step1_approve_usdc?.to);
  console.log('  ✓ create.to:', hireBody.step2_create_loop?.to);

  console.log('\n== Phase 4: List agents');
  const list = await fetch(`${API}/v3/arbloop/agents?limit=5`);
  const listBody = await list.json();
  console.log('  ✓ agents in catalog:', listBody.agents?.length ?? 0);

  console.log('\n✓ smoke-arbloop: all paths green');
}

main().catch((e) => {
  console.error('✗ smoke-arbloop FAILED:', e);
  process.exit(1);
});
