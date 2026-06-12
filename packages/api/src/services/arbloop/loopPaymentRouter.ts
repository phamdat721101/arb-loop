/**
 * loopPaymentRouter.ts — Permit2 + 0xSplits v2 PullSplit + 6-recipient split logic.
 *
 * SOLID:
 *   - SRP: own "compute splits + ensure PullSplit exists + build distribute call".
 *   - DIP: provider/signer + addresses injected.
 *   - OCP: adding a recipient kind = one entry in `resolveRecipient`.
 *
 * v0.1 is mock-friendly: when PULLSPLIT_FACTORY isn't configured, the router
 * returns a stub PullSplit address and a no-op distribute call (so the
 * iter settler still produces a valid multicall).
 */

import { Contract, Interface, JsonRpcProvider, Wallet, keccak256, AbiCoder, getAddress } from 'ethers';
import type { LoopManifest } from '@fhe-ai-context/sdk';

// ─── Permit2 typed data (EIP-712) ────────────────────────────────────────

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

export const PERMIT2_DOMAIN = (chainId: number) => ({
  name: 'Permit2',
  chainId,
  verifyingContract: PERMIT2_ADDRESS,
} as const);

export const PERMIT2_TYPES = {
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

export interface PermitData {
  permitted: { token: string; amount: bigint };
  spender: string;
  nonce: bigint;
  deadline: bigint;
}

export function buildPermit2TypedData(chainId: number, data: PermitData) {
  return {
    domain: PERMIT2_DOMAIN(chainId),
    types: PERMIT2_TYPES,
    primaryType: 'PermitTransferFrom' as const,
    message: data,
  };
}

// ─── 6-recipient split computation ───────────────────────────────────────

export type RecipientKind = 'seller' | 'compute' | 'eigenda' | 'arweave' | 'lit' | 'platform';

export interface ResolvedSplit {
  recipients: Array<{ address: string; bps: number }>;
  totalBps: number;
}

export interface RecipientAddresses {
  seller: string;
  compute: string;
  eigenda: string;
  arweave: string;
  lit: string;
  platform: string;
}

export function computeSplit(manifest: LoopManifest, addrs: RecipientAddresses): ResolvedSplit {
  const recipients = manifest.iteration.pricing.splits.map((s) => ({
    address: getAddress(addrs[s.to]),
    bps: s.bps,
  }));
  const totalBps = recipients.reduce((sum, r) => sum + r.bps, 0);
  if (totalBps !== 10000) {
    throw new Error(`arbloop:payment:splits_bps_total=${totalBps}`);
  }
  return { recipients, totalBps };
}

// ─── 0xSplits v2 PullSplit (minimal ABI; gracefully no-ops when factory unset) ─

const PULL_SPLIT_FACTORY_ABI = [
  'function createSplit((address[] recipients, uint256[] allocations, uint256 totalAllocation, uint16 distributionIncentive) splitParams, address owner, address creator) external returns (address split)',
  'function predictSplitAddress((address[] recipients, uint256[] allocations, uint256 totalAllocation, uint16 distributionIncentive) splitParams, address owner, address creator) external view returns (address)',
];

const PULL_SPLIT_ABI = [
  'function distribute((address[] recipients, uint256[] allocations, uint256 totalAllocation, uint16 distributionIncentive) splitParams, address token, address distributor) external',
];

const pullSplitIface = new Interface(PULL_SPLIT_ABI);

export interface PullSplitConfig {
  factory: string | null;          // PULL_SPLIT_FACTORY address; null → no-op stub
  ownerAddress: string;            // platform treasury (admin of split, never receives funds)
  distributorIncentive: number;    // bps; v0.1 uses 0
}

export class LoopPaymentRouter {
  private readonly provider: JsonRpcProvider;
  private readonly runner: Wallet;
  private readonly factory: Contract | null;

  constructor(
    rpcUrl: string,
    runnerPrivateKey: string,
    private readonly cfg: PullSplitConfig,
    private readonly recipientAddresses: RecipientAddresses,
  ) {
    this.provider = new JsonRpcProvider(rpcUrl);
    this.runner = new Wallet(runnerPrivateKey, this.provider);
    this.factory = cfg.factory
      ? new Contract(cfg.factory, PULL_SPLIT_FACTORY_ABI, this.runner)
      : null;
  }

  /** Idempotent — if a PullSplit already exists for this recipient set, return its address. */
  async ensurePullSplit(manifest: LoopManifest): Promise<string> {
    if (!this.factory) {
      // Mock-mode: deterministic stub address so iteration_log + receipts persist.
      const split = computeSplit(manifest, this.recipientAddresses);
      const seed = keccak256(
        AbiCoder.defaultAbiCoder().encode(
          ['address[]', 'uint256[]'],
          [split.recipients.map((r) => r.address), split.recipients.map((r) => BigInt(r.bps))],
        ),
      );
      return getAddress('0x' + seed.slice(26)); // last 20 bytes
    }
    const params = this.toSplitParams(manifest);
    const predicted = await this.factory.predictSplitAddress(
      params,
      this.cfg.ownerAddress,
      this.runner.address,
    );
    const code = await this.provider.getCode(predicted);
    if (code !== '0x') return predicted;
    const tx = await this.factory.createSplit(params, this.cfg.ownerAddress, this.runner.address);
    await tx.wait();
    return predicted;
  }

  /**
   * Build the encoded `distribute()` call for the per-iter multicall. Caller
   * (iterationSettler) batches it with EAS attest + LoopJob.advanceIter.
   */
  buildDistributeCall(
    pullSplitAddress: string,
    manifest: LoopManifest,
    usdcAddress: string,
  ): { target: string; callData: string } {
    if (!this.cfg.factory) {
      // No-op call when factory is unset — settler still includes EAS + advanceIter.
      return { target: pullSplitAddress, callData: '0x' };
    }
    const params = this.toSplitParams(manifest);
    const callData = pullSplitIface.encodeFunctionData('distribute', [
      params,
      getAddress(usdcAddress),
      this.runner.address,
    ]);
    return { target: pullSplitAddress, callData };
  }

  private toSplitParams(manifest: LoopManifest) {
    const split = computeSplit(manifest, this.recipientAddresses);
    return {
      recipients: split.recipients.map((r) => r.address),
      allocations: split.recipients.map((r) => BigInt(r.bps)),
      totalAllocation: BigInt(10000),
      distributionIncentive: this.cfg.distributorIncentive,
    };
  }
}
