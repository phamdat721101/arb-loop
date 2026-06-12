/**
 * sdk/src/arbloop/sellerPublish.ts — EIP-712 PublishAgent typed-data builder.
 *
 * Mirrors AgentRegistryV2.PUBLISH_AGENT_TYPEHASH. The seller signs this
 * payload off-chain; the relayer submits to publishAgentFor() on-chain.
 *
 * SOLID: SRP — typed-data construction only. No signing, no submission.
 */

export interface PublishAgentTypedData {
  domain: {
    name: 'ArbLoopAgentRegistryV2';
    version: '1';
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  types: {
    EIP712Domain: { name: string; type: string }[];
    PublishAgent: { name: string; type: string }[];
  };
  primaryType: 'PublishAgent';
  message: {
    seller: `0x${string}`;
    manifestIpfsCid: `0x${string}`;        // bytes32 (truncated CID or hash)
    defaultBackend: string;
    defaultModel: string;
    perIterMin: string;                    // micro-USDC as string
    perIterDefault: string;
    maxIter: number;
    deadline: string;                      // unix seconds as string
    nonce: string;                         // monotonic per (seller); typically nextNonce()
  };
}

export interface PublishAgentArgs {
  chainId: number;                         // 421614 or 42161
  registryV2Address: `0x${string}`;
  seller: `0x${string}`;
  manifestIpfsCid: `0x${string}`;
  defaultBackend: string;
  defaultModel: string;
  perIterMinMicroUsdc: bigint;
  perIterDefaultMicroUsdc: bigint;
  maxIter: number;
  deadlineSec?: bigint;                    // default: now + 1h
  nonce: bigint;
}

export function buildPublishAgentTypedData(a: PublishAgentArgs): PublishAgentTypedData {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    domain: {
      name: 'ArbLoopAgentRegistryV2',
      version: '1',
      chainId: a.chainId,
      verifyingContract: a.registryV2Address,
    },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      PublishAgent: [
        { name: 'seller', type: 'address' },
        { name: 'manifestIpfsCid', type: 'bytes32' },
        { name: 'defaultBackend', type: 'string' },
        { name: 'defaultModel', type: 'string' },
        { name: 'perIterMin', type: 'uint256' },
        { name: 'perIterDefault', type: 'uint256' },
        { name: 'maxIter', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'PublishAgent',
    message: {
      seller: a.seller,
      manifestIpfsCid: a.manifestIpfsCid,
      defaultBackend: a.defaultBackend,
      defaultModel: a.defaultModel,
      perIterMin: a.perIterMinMicroUsdc.toString(),
      perIterDefault: a.perIterDefaultMicroUsdc.toString(),
      maxIter: a.maxIter,
      deadline: (a.deadlineSec ?? now + 3600n).toString(),
      nonce: a.nonce.toString(),
    },
  };
}

/** Generate a fresh per-seller nonce from a monotonic clock seed. */
export function freshPublishNonce(): bigint {
  return BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
}
