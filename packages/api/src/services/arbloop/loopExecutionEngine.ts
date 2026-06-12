/**
 * loopExecutionEngine.ts — single-iteration orchestrator for arb-loop.
 *
 * Flow per iter:
 *   1. Load LoopJob state from Arbitrum (status, iterationsDone, agentRegistry, agentId)
 *   2. Load Agent metadata from AgentRegistry
 *   3. Fetch manifest YAML from EigenDA + parse via Zod
 *   4. Build memory context via EvmMemoryService.buildMemoryContext
 *   5. Compose prompt (persona + memory + task) and invoke InferenceFanout
 *   6. Encrypt+persist memory via EvmMemoryService.writeMemory
 *   7. Evaluate stop_condition predicate
 *   8. Settle via IterationSettler (multicall: EAS + advanceIter + distribute)
 *   9. If DONE: trigger reflective writeback
 *
 * SOLID:
 *   - SRP: orchestration only. No Solidity ABIs beyond LoopJob view + AgentRegistry view.
 *   - DIP: every collaborator injected (memory, inference, settler, eigenDa).
 *   - OCP: adding a manifest field = one map entry; engine is unchanged.
 */

import { Contract, JsonRpcProvider } from 'ethers';
import yaml from 'js-yaml';
import {
  evaluateStopCondition,
  parseLoopManifest,
  type LoopManifest,
  type IEigenDaClient,
} from '@fhe-ai-context/sdk';
import { EvmMemoryService, type InferenceResultLike } from './evmMemoryService';
import { IterationSettler, LoopJobStatus } from './iterationSettler';

const LOOP_JOB_ABI = [
  'function status() view returns (uint8)',
  'function buyer() view returns (address)',
  'function agentRegistry() view returns (address)',
  'function agentId() view returns (uint256)',
  'function manifestEigenKzg() view returns (bytes32)',
  'function jobMemoryNamespace() view returns (address)',
  'function maxIterations() view returns (uint256)',
  'function budgetMicroUsdc() view returns (uint256)',
  'function iterationsDone() view returns (uint256)',
  'function spentMicroUsdc() view returns (uint256)',
];

const AGENT_REGISTRY_ABI = [
  `function getAgent(uint256 agentId) view returns (tuple(
    address seller,
    bytes32 manifestEigenKzg,
    bytes32 manifestArweaveTxId,
    string defaultInferenceBackend,
    string defaultModelId,
    uint256 perIterMinMicroUsdc,
    uint256 perIterDefaultMicroUsdc,
    uint256 maxIterPerJob,
    address personaNamespaceAddress,
    uint256 reputationScore,
    uint256 completedJobs,
    uint256 totalIterCount,
    uint256 publishedAtMs,
    bool revoked
  ))`,
];

// ─── Inference fanout interface — Phase 6 implements ─────────────────────

export interface InferenceInvokeRequest {
  backend: string;
  modelId: string;
  prompt: string;
  fallbackBackends?: Array<{ backend: string; modelId: string }>;
}

export interface InferenceInvokeResponse {
  text: string;
  backend: string;             // actual backend used (after fallback)
  modelId: string;
  phalaSigningAddress: string; // 0x... when backend yields TEE attestation; ZeroAddress otherwise
  phalaAttestationHash: string; // 32-byte hex; ZeroHash when no attestation
  inputBytes: Uint8Array;       // raw prompt bytes for EigenDA pinning
  outputBytes: Uint8Array;      // raw response bytes for EigenDA pinning
  latencyMs: number;
}

export interface IInferenceFanout {
  invoke(req: InferenceInvokeRequest): Promise<InferenceInvokeResponse>;
}

// ─── Engine ──────────────────────────────────────────────────────────────

export interface LoopExecutionEngineDeps {
  rpcUrl: string;
  agentRegistryAddress: string;
  memoryService: EvmMemoryService;
  inference: IInferenceFanout;
  settler: IterationSettler;
  eigenDa: IEigenDaClient;
}

export interface ExecutionStepResult {
  iterN: number;
  stopFires: boolean;
  nextStatus: LoopJobStatus;
  attestationUid: string;
  multicallTxHash: string;
  amountPaidMicroUsdc: bigint;
}

export class LoopExecutionEngine {
  private readonly provider: JsonRpcProvider;
  private readonly agentRegistry: Contract;

  constructor(private readonly deps: LoopExecutionEngineDeps) {
    this.provider = new JsonRpcProvider(deps.rpcUrl);
    this.agentRegistry = new Contract(deps.agentRegistryAddress, AGENT_REGISTRY_ABI, this.provider);
  }

  async executeIteration(jobAddress: string): Promise<ExecutionStepResult | null> {
    // 1. Load LoopJob state
    const job = new Contract(jobAddress, LOOP_JOB_ABI, this.provider);
    const status = Number(await job.status()) as LoopJobStatus;
    if (status !== LoopJobStatus.RUNNING) return null;

    const iterationsDone = Number(await job.iterationsDone());
    const maxIterations = Number(await job.maxIterations());
    const spent = BigInt(await job.spentMicroUsdc());
    const budget = BigInt(await job.budgetMicroUsdc());
    const nextIter = iterationsDone + 1;
    if (nextIter > maxIterations) return null;

    const agentId = Number(await job.agentId());
    const manifestKzg = (await job.manifestEigenKzg()) as string;
    const jobNamespace = (await job.jobMemoryNamespace()) as string;

    // 2. Load Agent
    const agent = await this.agentRegistry.getAgent(agentId);
    const agentNamespace = agent.personaNamespaceAddress as string;

    // 3. Fetch + parse manifest
    const manifestBytes = await this.deps.eigenDa.fetch(manifestKzg);
    const manifestObj = yaml.load(Buffer.from(manifestBytes).toString('utf8')) as unknown;
    const manifest: LoopManifest = parseLoopManifest(manifestObj);

    // 4. Build memory context
    const memCtx = await this.deps.memoryService.buildMemoryContext(
      jobNamespace,
      agentNamespace,
      manifest,
    );

    // 5. Build prompt
    const prompt = this.composePrompt(manifest, memCtx, nextIter);

    // 6. Invoke inference (with fallback chain)
    const inf = await this.deps.inference.invoke({
      backend: manifest.iteration.inference.backend,
      modelId: manifest.iteration.inference.model_id,
      prompt,
      fallbackBackends: manifest.iteration.inference.fallback_backends.map((f) => ({
        backend: f.backend,
        modelId: f.model_id,
      })),
    });

    // 7. Pin input/output blobs to EigenDA
    const eigenInputKzg = await this.deps.eigenDa.put(inf.inputBytes);
    const eigenOutputKzg = await this.deps.eigenDa.put(inf.outputBytes);

    // 8. Compute amount + check budget
    const amount = BigInt(manifest.iteration.pricing.per_iter_micro_usdc);
    if (spent + amount > budget) {
      // Budget exhausted — settler will set status PAUSED_BUDGET
      // (we still mint attestation + advanceIter for audit trail)
    }

    // 9. Persist memory writes (L1+L2+L4 per manifest)
    const result: InferenceResultLike = {
      text: inf.text,
      inputKzg: eigenInputKzg,
      outputKzg: eigenOutputKzg,
      episodeSummary: this.makeEpisodeSummary(inf.text),
      signals: { backend_used: inf.backend, latency_ms: inf.latencyMs },
    };
    await this.deps.memoryService.writeMemory(jobNamespace, nextIter, result, manifest);

    // 10. Evaluate stop_condition
    const stopFires = evaluateStopCondition(manifest.stop_condition.predicate, {
      iterations: nextIter,
      latest_response: inf.text,
      spent_micro_usdc: Number(spent + amount),
      budget_micro_usdc: Number(budget),
    });

    // 11. Determine next status
    const checkpointHere = (manifest.checkpoints ?? []).some((c) => c.after_iter === nextIter);
    const nextStatus = stopFires
      ? LoopJobStatus.DONE
      : spent + amount >= budget
        ? LoopJobStatus.PAUSED_BUDGET
        : checkpointHere
          ? LoopJobStatus.PAUSED_CHECKPOINT
          : LoopJobStatus.RUNNING;

    // 12. Settle (EAS attest + advanceIter + PullSplit distribute)
    const settle = await this.deps.settler.settle({
      jobAddress,
      iterN: nextIter,
      eigenInputKzg,
      eigenOutputKzg,
      phalaSigningAddress: inf.phalaSigningAddress,
      phalaAttestationHash: inf.phalaAttestationHash,
      amountPaidMicroUsdc: amount,
      nextStatus,
      manifest,
    });

    // 13. If stopFires → reflective writeback + complete
    if (stopFires) {
      await this.deps.memoryService.reflectiveWriteback(jobNamespace, agentNamespace, manifest);
      await this.deps.settler.completeJob(jobAddress);
    }

    return {
      iterN: nextIter,
      stopFires,
      nextStatus,
      attestationUid: settle.attestationUid,
      multicallTxHash: settle.multicallTxHash,
      amountPaidMicroUsdc: amount,
    };
  }

  private composePrompt(manifest: LoopManifest, mem: unknown, iterN: number): string {
    return [
      `# arb-loop iteration ${iterN}`,
      `Title: ${manifest.title}`,
      `Description: ${manifest.description}`,
      `## Memory context`,
      JSON.stringify(mem, null, 2),
      `## Stop condition (DSL)`,
      manifest.stop_condition.predicate,
      `## Instructions`,
      `Continue work toward stop condition. Emit FINAL_REPORT_READY when complete.`,
    ].join('\n\n');
  }

  private makeEpisodeSummary(text: string): string {
    return text.length > 200 ? text.slice(0, 200) + '…' : text;
  }
}
