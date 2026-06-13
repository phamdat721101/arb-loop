/**
 * lib/arbloop.ts — frontend-side arbloop config + minimal ABIs.
 *
 * SOLID: SRP — addresses + ABI fragments only. Hooks consume; components
 * never read process.env directly.
 */

export const ARBLOOP_FEATURE_ENABLED = process.env.NEXT_PUBLIC_FEATURE_ARBLOOP !== 'false';

export const ARBLOOP_ADDRESSES = {
  agentRegistry: (process.env.NEXT_PUBLIC_ARBLOOP_AGENT_REGISTRY_ADDRESS ?? '') as `0x${string}`,
  loopJobFactory: (process.env.NEXT_PUBLIC_ARBLOOP_LOOP_JOB_FACTORY_ADDRESS ?? '') as `0x${string}`,
  iterationReceipt: (process.env.NEXT_PUBLIC_ARBLOOP_ITERATION_RECEIPT_ADDRESS ?? '') as `0x${string}`,
  checkpointApproval: (process.env.NEXT_PUBLIC_ARBLOOP_CHECKPOINT_APPROVAL_ADDRESS ?? '') as `0x${string}`,
  usdc: (process.env.NEXT_PUBLIC_ARBLOOP_USDC_ADDRESS ?? '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d') as `0x${string}`,
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as `0x${string}`,
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11' as `0x${string}`,
} as const;

export const ARBLOOP_API_URL =
  process.env.NEXT_PUBLIC_AGENT_BACKEND_URL ?? 'http://localhost:3001';

export const AGENT_REGISTRY_ABI = [
  {
    type: 'function', name: 'getAgent', stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{
      type: 'tuple', components: [
        { name: 'seller', type: 'address' },
        { name: 'manifestEigenKzg', type: 'bytes32' },
        { name: 'manifestArweaveTxId', type: 'bytes32' },
        { name: 'defaultInferenceBackend', type: 'string' },
        { name: 'defaultModelId', type: 'string' },
        { name: 'perIterMinMicroUsdc', type: 'uint256' },
        { name: 'perIterDefaultMicroUsdc', type: 'uint256' },
        { name: 'maxIterPerJob', type: 'uint256' },
        { name: 'personaNamespaceAddress', type: 'address' },
        { name: 'reputationScore', type: 'uint256' },
        { name: 'completedJobs', type: 'uint256' },
        { name: 'totalIterCount', type: 'uint256' },
        { name: 'publishedAtMs', type: 'uint256' },
        { name: 'revoked', type: 'bool' },
      ],
    }],
  },
  {
    type: 'function', name: 'nextAgentId', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }],
  },
] as const;

export const LOOP_JOB_FACTORY_ABI = [
  {
    type: 'function', name: 'create', stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'maxIterations', type: 'uint256' },
      { name: 'budgetMicroUsdc', type: 'uint256' },
    ],
    outputs: [
      { name: 'jobAddress', type: 'address' },
      { name: 'jobMemoryNamespace', type: 'address' },
    ],
  },
  {
    type: 'event', name: 'JobCreated',
    inputs: [
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'agentRegistryAddr', type: 'address', indexed: true },
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'manifestEigenKzg', type: 'bytes32' },
      { name: 'jobAddress', type: 'address' },
      { name: 'jobMemoryNamespace', type: 'address' },
      { name: 'budgetMicroUsdc', type: 'uint256' },
      { name: 'maxIterations', type: 'uint256' },
    ],
  },
] as const;

export const LOOP_JOB_ABI = [
  { type: 'function', name: 'status', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'iterationsDone', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxIterations', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'spentMicroUsdc', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'budgetMicroUsdc', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'agentId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'latestAttestationUid', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'pause', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'resume', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'cancel', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const;

export const CHECKPOINT_APPROVAL_ABI = [
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'jobAddress', type: 'address' }, { name: 'iterN', type: 'uint256' }],
    outputs: [],
  },
] as const;

export const USDC_ABI = [
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export const LOOP_JOB_STATUS = ['PENDING', 'RUNNING', 'PAUSED_BUDGET', 'PAUSED_CHECKPOINT', 'DONE', 'CANCELLED'] as const;
export type LoopJobStatusName = (typeof LOOP_JOB_STATUS)[number];

export interface AgentMetadataDto {
  agent_registry_address: string;
  agent_id: number;
  seller_address: string;
  default_inference_backend: string;
  default_model_id: string;
  per_iter_default_micro_usdc: string;
  per_iter_min_micro_usdc: string;
  max_iter_per_job: number;
  reputation_score: number;
  completed_jobs: number;
  total_iter_count: number;
  category: string | null;
  tags: string[] | null;
  title: string;
  short_description: string | null;
  persona_namespace_address: string;
  published_at: string;
  revoked: boolean;
}

export interface JobMetadataDto {
  job_contract_address: string;
  buyer_address: string;
  agent_registry_address: string;
  agent_id: number;
  status: number;
  iterations_done: number;
  max_iterations: number;
  spent_micro_usdc: string;
  budget_micro_usdc: string;
  job_memory_namespace_address: string;
  inference_backend_used: string | null;
  created_at: string;
  last_iter_at: string | null;
  completed_at: string | null;
}

export interface BuyerJobDto {
  job_contract_address: string;
  agent_id: number;
  agent_registry_address: string;
  status: number;
  iterations_done: number;
  max_iterations: number;
  spent_micro_usdc: string;
  budget_micro_usdc: string;
  created_at: string;
  last_iter_at: string | null;
  completed_at: string | null;
  agent_title: string | null;
  agent_short_description: string | null;
  last_backend: string | null;
  last_iter_completed_at: string | null;
}

export interface IterationLogDto {
  iter_n: number;
  attestation_uid: string;
  inference_backend: string;
  inference_model_id: string;
  amount_paid_micro_usdc: string;
  iter_completed_at: string;
  stop_condition_eval: boolean;
  /** v0.0 mode-B: plaintext answer for the iter (extracted from inputs_json). */
  answer?: string | null;
  /** v0.0 mode-A/B (FHE pipeline): IPFS CID of the encrypted response blob. */
  response_ipfs_cid?: string | null;
}
