/**
 * agent-kya.ts — ERC-8004 "Know Your Agent" identity resolution middleware.
 *
 * Per `geterc8004.com`, ERC-8004 went mainnet on Jan 29, 2026 with three
 * lightweight registries (Identity, Reputation, Validation) deployed as one
 * canonical contract per chain. This middleware reads the Identity registry
 * and surfaces a verified agent identity on req.agent.
 *
 * SOLID:
 *   - Single responsibility: resolve an inbound agent header to an on-chain
 *     identity. Does NOT gate access — that's a separate decision per route.
 *   - Open for extension: more chains via env (ERC8004_RPC_URL_<CHAIN>) without
 *     touching the core read path.
 *   - Dependency-inverted: viem PublicClient is created lazily, cached, and
 *     wrapped with a soft-failure path so the API stays bootable offline.
 *
 * Behaviour:
 *   - Header `x-erc8004-agent-id` (uint) → registry.getAgent(id) → {owner, agentURI}
 *   - Optional `x-erc8004-chain` selects RPC. Default = "base".
 *   - On any failure, sets req.agent.verified=false and lets the request through;
 *     downstream gates decide what to do (free pricing, stricter quota, etc.).
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib';

// Registry ABI — read-only fragment, the standardised function shape from EIP-8004.
const REGISTRY_READ_ABI = [
  {
    type: 'function',
    name: 'getAgent',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [
      { name: 'owner', type: 'address' },
      { name: 'agentURI', type: 'string' },
    ],
  },
] as const;

export interface AgentIdentity {
  agentId: string;
  owner: string;
  agentURI: string;
  /** Resolved successfully on chain. */
  verified: boolean;
  /** Optional reputation score 0..100; omitted in v0 (Reputation registry not read yet). */
  reputation?: number;
  reason?: 'no_header' | 'rpc_unavailable' | 'not_found' | 'config_missing';
}

declare module 'express' {
  interface Request {
    agent?: AgentIdentity;
  }
}

// Cache the viem client across requests; created on first hit.
let _publicClient: any = null;
async function getClient() {
  if (_publicClient) return _publicClient;
  const rpc = process.env.ERC8004_RPC_URL;
  const registry = process.env.ERC8004_REGISTRY_ADDRESS;
  if (!rpc || !registry) return null;
  try {
    const { createPublicClient, http } = await import('viem');
    _publicClient = createPublicClient({ transport: http(rpc) });
    return _publicClient;
  } catch (e: any) {
    logger.warn({ err: e.message }, 'erc8004:client:init-failed');
    return null;
  }
}

/** Optional middleware. Always calls next(); never blocks on its own. */
export const agentKya = async (req: Request, _res: Response, next: NextFunction) => {
  const headerId = req.headers['x-erc8004-agent-id'];
  if (!headerId || typeof headerId !== 'string') {
    return next();
  }

  const registry = process.env.ERC8004_REGISTRY_ADDRESS;
  if (!registry) {
    req.agent = { agentId: headerId, owner: '', agentURI: '', verified: false, reason: 'config_missing' };
    return next();
  }

  const client = await getClient();
  if (!client) {
    req.agent = { agentId: headerId, owner: '', agentURI: '', verified: false, reason: 'rpc_unavailable' };
    return next();
  }

  try {
    const result = (await client.readContract({
      address: registry as `0x${string}`,
      abi: REGISTRY_READ_ABI,
      functionName: 'getAgent',
      args: [BigInt(headerId)],
    })) as [string, string];
    const [owner, agentURI] = result;
    if (!owner || owner === '0x0000000000000000000000000000000000000000') {
      req.agent = { agentId: headerId, owner: '', agentURI: '', verified: false, reason: 'not_found' };
    } else {
      req.agent = { agentId: headerId, owner, agentURI, verified: true };
      logger.info({ agentId: headerId, owner }, 'erc8004:agent:resolved');
    }
  } catch (e: any) {
    logger.warn({ agentId: headerId, err: e.message }, 'erc8004:read:failed');
    req.agent = { agentId: headerId, owner: '', agentURI: '', verified: false, reason: 'rpc_unavailable' };
  }
  next();
};
