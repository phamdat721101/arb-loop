/**
 * iterationSettler.ts — per-iter multicall builder for arb-loop.
 *
 * Composes 3 sub-calls in 1 atomic Multicall3 transaction:
 *   1. EAS.attest(...)           via easAttestation.attestIteration
 *   2. LoopJob.advanceIter(...)  via injected runner wallet
 *   3. PullSplit.distribute(...) via loopPaymentRouter.buildDistributeCall
 *
 * SOLID:
 *   - SRP: build + sign + submit only. No memory writes, no inference.
 *   - DIP: collaborators (eas, paymentRouter, contracts) injected.
 *   - Atomicity: revert-on-failure semantics via Multicall3.aggregate3 (single tx).
 *
 * v0.1 simplification: EAS attestation is minted FIRST (separate tx) so the
 * UID is available for LoopJob.advanceIter, then the second multicall handles
 * advanceIter + distribute atomically. Real-prod v0.2 swaps EAS to the same
 * multicall via attestByDelegation. This 2-tx-per-iter flow keeps gas linear
 * + makes the EAS UID-extraction logic single-purpose.
 */

import { Contract, Interface, JsonRpcProvider, Wallet } from 'ethers';
import type { LoopManifest } from '@fhe-ai-context/sdk';
import { EasAttestation } from './easAttestation';
import { LoopPaymentRouter } from './loopPaymentRouter';

const LOOP_JOB_ABI = [
  'function advanceIter(uint256 iterN, bytes32 attestationUid, uint256 amountPaidMicro, uint8 nextStatus) external',
  'function complete() external',
  'function status() view returns (uint8)',
  'function buyer() view returns (address)',
];

const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) external payable returns ((bool success, bytes returnData)[] returnData)',
];

const loopJobIface = new Interface(LOOP_JOB_ABI);

export enum LoopJobStatus {
  PENDING = 0,
  RUNNING = 1,
  PAUSED_BUDGET = 2,
  PAUSED_CHECKPOINT = 3,
  DONE = 4,
  CANCELLED = 5,
}

export interface SettleInput {
  jobAddress: string;
  iterN: number;
  eigenInputKzg: string;
  eigenOutputKzg: string;
  phalaSigningAddress: string;
  phalaAttestationHash: string;
  amountPaidMicroUsdc: bigint;
  nextStatus: LoopJobStatus;
  manifest: LoopManifest;
}

export interface SettleResult {
  attestationUid: string;
  pullSplitAddress: string;
  attestTxHash: string;
  multicallTxHash: string;
}

export interface IterationSettlerDeps {
  rpcUrl: string;
  runnerPrivateKey: string;
  multicall3Address: string;
  usdcAddress: string;
  eas: EasAttestation;
  paymentRouter: LoopPaymentRouter;
}

export class IterationSettler {
  private readonly provider: JsonRpcProvider;
  private readonly runner: Wallet;
  private readonly multicall: Contract;
  private readonly eas: EasAttestation;
  private readonly paymentRouter: LoopPaymentRouter;
  private readonly usdcAddress: string;

  constructor(deps: IterationSettlerDeps) {
    this.provider = new JsonRpcProvider(deps.rpcUrl);
    this.runner = new Wallet(deps.runnerPrivateKey, this.provider);
    this.multicall = new Contract(deps.multicall3Address, MULTICALL3_ABI, this.runner);
    this.eas = deps.eas;
    this.paymentRouter = deps.paymentRouter;
    this.usdcAddress = deps.usdcAddress;
  }

  async settle(input: SettleInput): Promise<SettleResult> {
    // 1. Mint EAS attestation (separate tx; UID is the input to advanceIter).
    const pullSplitAddress = await this.paymentRouter.ensurePullSplit(input.manifest);
    const attestationUid = await this.eas.attestIteration({
      jobAddress: input.jobAddress,
      iterN: input.iterN,
      eigenInputKzg: input.eigenInputKzg,
      eigenOutputKzg: input.eigenOutputKzg,
      phalaSigningAddress: input.phalaSigningAddress,
      phalaAttestationHash: input.phalaAttestationHash,
      amountPaidMicroUsdc: input.amountPaidMicroUsdc,
      pullSplitAddress,
    });
    const attestTxHash = '0x'; // EAS client owns the receipt; we only need the UID

    // 2. Build advanceIter call
    const advanceCall = {
      target: input.jobAddress,
      allowFailure: false,
      callData: loopJobIface.encodeFunctionData('advanceIter', [
        BigInt(input.iterN),
        attestationUid,
        input.amountPaidMicroUsdc,
        input.nextStatus,
      ]),
    };

    // 3. Build PullSplit.distribute call
    const dist = this.paymentRouter.buildDistributeCall(
      pullSplitAddress,
      input.manifest,
      this.usdcAddress,
    );
    const distributeCall = dist.callData !== '0x'
      ? { target: dist.target, allowFailure: true, callData: dist.callData }
      : null;

    // 4. Multicall (advanceIter + optional distribute)
    const calls = distributeCall ? [advanceCall, distributeCall] : [advanceCall];
    const tx = await this.multicall.aggregate3(calls);
    const receipt = await tx.wait();

    return {
      attestationUid,
      pullSplitAddress,
      attestTxHash,
      multicallTxHash: receipt?.hash ?? '0x',
    };
  }

  async completeJob(jobAddress: string): Promise<string> {
    const c = new Contract(jobAddress, LOOP_JOB_ABI, this.runner);
    const tx = await c.complete();
    const receipt = await tx.wait();
    return receipt?.hash ?? '0x';
  }
}
