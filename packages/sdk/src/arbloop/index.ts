/**
 * @fhe-ai-context/sdk/arbloop — public surface for the arb-loop marketplace.
 *
 * Imported by api, frontend, scripts, openx-mcp. Single source of truth for
 * loop manifest schema, predicate evaluator, and storage envelope types.
 */

export * from './loopManifest';
export * from './stopCondition';

// ─── v0.0 simple ship surfaces (FEATURE_ARBLOOP_SIMPLE) ──────────────────

export * from './x402';
export * from './clientCrypto';
export * from './sellerPublish';
export * from './permit2';

// ─── Storage client interfaces (real impls live in packages/api/src/services) ─

export interface IEigenDaClient {
  /** Upload a blob; returns 32-byte KZG commitment as hex `0x…`. */
  put(blob: Uint8Array): Promise<string>;
  /** Fetch a blob by KZG commitment. Throws if not found. */
  fetch(kzg: string): Promise<Uint8Array>;
}

export interface IArweaveClient {
  /** Upload a permanent bundle; returns 43-char Arweave tx-id. */
  put(bundle: Uint8Array): Promise<string>;
  /** Fetch a bundle by tx-id. Throws if not found. */
  fetch(txId: string): Promise<Uint8Array>;
}

export interface ILitEncryption {
  /** Encrypt for a wallet-based owner using a named access policy. */
  encryptForOwner(
    plaintext: unknown,
    ownerAddress: string,
    policyName: LitPolicyName,
  ): Promise<string>;
  /** Decrypt; throws on policy violation or missing key share. */
  decryptForReader(
    envelope: string,
    sessionSig: string,
    policyName: LitPolicyName,
    opts?: { filter?: string; contractAddress?: string },
  ): Promise<unknown>;
}

export type LitPolicyName =
  | 'job-memory-l1'
  | 'job-memory-l2'
  | 'job-memory-l4'
  | 'agent-memory-l3'
  | 'agent-memory-l5'
  | 'agent-memory-l3-public-read';

// ─── EAS attestation envelope shape ───────────────────────────────────────

export interface IterationReceiptDataArb {
  jobAddress: string;
  iterN: number;
  eigenInputKzg: string;
  eigenOutputKzg: string;
  phalaSigningAddress: string;
  phalaAttestationHash: string;
  amountPaidMicroUsdc: bigint;
  pullSplitAddress: string;
}

export interface L5ReflectionDataArb {
  agentContract: string;
  jobAddress: string;
  arweaveTxId: string;
  reflectiveAtMs: bigint;
}

// ─── Convenience type aliases (re-exported for consumers) ─────────────────

export type EvmMemoryBinding = {
  l1?: unknown;
  l2?: unknown;
  l3?: unknown;
  l4?: unknown;
};
