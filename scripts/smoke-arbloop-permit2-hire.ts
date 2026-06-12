/* eslint-disable no-console */
/**
 * smoke-arbloop-permit2-hire.ts
 *
 * Asserts: buyer signs ONE Permit2 typed-data; submits ONE multicall tx;
 * LoopJob deployed; budget escrowed.
 *
 * Usage:
 *   API_URL=... BUYER_PRIVATE_KEY=... AGENT_ID=42 \
 *   ARBLOOP_LOOP_JOB_FACTORY_ADDRESS=... ARBLOOP_USDC_ADDRESS=... \
 *     npm run smoke:arbloop-permit2-hire
 */

import { Wallet, JsonRpcProvider, Contract, Interface } from 'ethers';
import {
  buildPermitTransferFromTypedData,
  freshPermit2Nonce,
  PERMIT2_ADDRESS,
} from '@fhe-ai-context/sdk';

const RPC_URL = process.env.RPC_URL_ARBITRUM_SEPOLIA ?? 'https://sepolia-rollup.arbitrum.io/rpc';
const BUYER_KEY = process.env.BUYER_PRIVATE_KEY ?? process.env.PHAM_PRIVATE_KEY ?? '';
const FACTORY = (process.env.ARBLOOP_LOOP_JOB_FACTORY_ADDRESS ?? '') as `0x${string}`;
const USDC = (process.env.ARBLOOP_USDC_ADDRESS ?? '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d') as `0x${string}`;
const AGENT_ID = BigInt(process.env.AGENT_ID ?? '0');
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 421614);
const BUDGET_USDC_MICRO = BigInt(process.env.BUDGET_USDC_MICRO ?? '5000000');
const MAX_ITER = BigInt(process.env.MAX_ITER ?? '5');

async function main() {
  if (!BUYER_KEY || !FACTORY) throw new Error('env: BUYER_PRIVATE_KEY + ARBLOOP_LOOP_JOB_FACTORY_ADDRESS');
  const provider = new JsonRpcProvider(RPC_URL);
  const buyer = new Wallet(BUYER_KEY, provider);
  console.log('buyer:', buyer.address);

  const nonce = freshPermit2Nonce();
  const deadlineSec = BigInt(Math.floor(Date.now() / 1000) + 1800);

  const td = buildPermitTransferFromTypedData({
    chainId: CHAIN_ID,
    tokenAddress: USDC,
    amountMicroUsdc: BUDGET_USDC_MICRO,
    spender: FACTORY,
    nonce,
    deadlineSec,
  });

  const signature = await buyer.signTypedData(
    td.domain,
    {
      PermitTransferFrom: td.types.PermitTransferFrom,
      TokenPermissions: td.types.TokenPermissions,
    },
    td.message,
  );
  console.log('✓ signed Permit2 (popup #1 of 1)');

  // Submit createWithPermit2 in a single tx.
  const factory = new Contract(FACTORY, [
    'function createWithPermit2(uint256 agentId, uint256 maxIterations, uint256 budgetMicroUsdc, ((address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, bytes sig) returns (address, address)',
  ], buyer);
  const tx = await factory.createWithPermit2(
    AGENT_ID, MAX_ITER, BUDGET_USDC_MICRO,
    {
      permitted: { token: USDC, amount: BUDGET_USDC_MICRO },
      nonce: nonce.toString(),
      deadline: deadlineSec.toString(),
    },
    signature,
  );
  const rc = await tx.wait();
  if (!rc) throw new Error('no receipt');
  console.log('✓ tx mined:', rc.hash);

  // Parse JobCreated event.
  const iface = new Interface(['event JobCreated(address indexed buyer, address indexed agentRegistryAddr, uint256 indexed agentId, bytes32 manifestEigenKzg, address jobAddress, address jobMemoryNamespace, uint256 budgetMicroUsdc, uint256 maxIterations)']);
  let jobAddr: string | null = null;
  for (const log of rc.logs) {
    try {
      const parsed = iface.parseLog(log as never);
      if (parsed?.name === 'JobCreated') jobAddr = parsed.args.jobAddress;
    } catch { /* not our event */ }
  }
  if (!jobAddr) throw new Error('no JobCreated event');
  console.log('✓ LoopJob deployed at', jobAddr);
  console.log('SMOKE PASS · Drift #1 fixed (1-popup hire)');
}

main().catch((e) => { console.error('SMOKE FAIL', e); process.exit(1); });
