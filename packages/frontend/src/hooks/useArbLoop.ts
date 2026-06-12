'use client';
/**
 * useArbLoop.ts — frontend hooks for the arb-loop marketplace.
 *
 * SOLID:
 *   - SRP: each hook owns one read or one write. Components never poke the
 *     network directly.
 *   - DIP: addresses + ABIs come from `lib/arbloop.ts`; backend URL from env.
 */

import { useEffect, useState } from 'react';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import {
  ARBLOOP_ADDRESSES,
  ARBLOOP_API_URL,
  AGENT_REGISTRY_ABI,
  LOOP_JOB_ABI,
  LOOP_JOB_FACTORY_ABI,
  CHECKPOINT_APPROVAL_ABI,
  USDC_ABI,
  LOOP_JOB_STATUS,
  type AgentMetadataDto,
  type JobMetadataDto,
  type IterationLogDto,
  type LoopJobStatusName,
} from '@/lib/arbloop';

// ─── Marketplace listings ────────────────────────────────────────────────

export function useAgentList() {
  const [agents, setAgents] = useState<AgentMetadataDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`${ARBLOOP_API_URL}/v3/arbloop/agents`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((j) => setAgents((j.agents ?? []) as AgentMetadataDto[]))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  return { agents, loading, error };
}

// ─── Single Agent (DB metadata + on-chain state hybrid) ──────────────────

export function useAgent(agentId: number | null) {
  const { data, isLoading, error } = useReadContract({
    address: ARBLOOP_ADDRESSES.agentRegistry,
    abi: AGENT_REGISTRY_ABI,
    functionName: 'getAgent',
    args: agentId !== null ? [BigInt(agentId)] : undefined,
    query: { enabled: agentId !== null && !!ARBLOOP_ADDRESSES.agentRegistry },
  });
  return {
    agent: data,
    loading: isLoading,
    error: error ? (error as Error).message : null,
  };
}

// ─── Hire-loop multicall (USDC.approve + LoopJobFactory.create) ──────────

export function useHireLoop() {
  const { address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);

  /**
   * v0.1 simplification: instead of Permit2 + Multicall3 (which would require
   * a single tx but a multi-step typed-data signature), we use the
   * conventional 2-tx pattern: USDC.approve(factory, budget) + factory.create.
   * v0.2 swap: use Permit2.permitTransferFrom in a single multicall tx.
   */
  async function hire(args: {
    agentId: bigint;
    maxIterations: bigint;
    budgetMicroUsdc: bigint;
  }): Promise<`0x${string}` | null> {
    if (!address) {
      setError('connect a wallet first');
      return null;
    }
    setError(null);
    try {
      // 1. Approve USDC
      await writeContractAsync({
        address: ARBLOOP_ADDRESSES.usdc,
        abi: USDC_ABI,
        functionName: 'approve',
        args: [ARBLOOP_ADDRESSES.loopJobFactory, args.budgetMicroUsdc],
      });
      // 2. Create LoopJob
      const hash = await writeContractAsync({
        address: ARBLOOP_ADDRESSES.loopJobFactory,
        abi: LOOP_JOB_FACTORY_ABI,
        functionName: 'create',
        args: [args.agentId, args.maxIterations, args.budgetMicroUsdc],
      });
      setTxHash(hash);
      return hash;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }

  /**
   * v0.0 simple single-popup hire. Buyer signs ONE Permit2 typed-data;
   * the resulting sig is passed to LoopJobFactory.createWithPermit2() in
   * one tx. Replaces the 2-tx approve+create pattern. Gated by
   * FEATURE_ARBLOOP_PERMIT2_HIRE; falls back to hire() when off.
   */
  async function hireWithPermit2(args: {
    agentId: bigint;
    maxIterations: bigint;
    budgetMicroUsdc: bigint;
    permit: {
      permitted: { token: `0x${string}`; amount: bigint };
      nonce: bigint;
      deadline: bigint;
    };
    signature: `0x${string}`;
  }): Promise<`0x${string}` | null> {
    if (!address) { setError('connect a wallet first'); return null; }
    setError(null);
    try {
      const hash = await writeContractAsync({
        address: ARBLOOP_ADDRESSES.loopJobFactory,
        abi: [
          {
            type: 'function', name: 'createWithPermit2', stateMutability: 'nonpayable',
            inputs: [
              { name: 'agentId', type: 'uint256' },
              { name: 'maxIterations', type: 'uint256' },
              { name: 'budgetMicroUsdc', type: 'uint256' },
              {
                name: 'permit', type: 'tuple', components: [
                  {
                    name: 'permitted', type: 'tuple', components: [
                      { name: 'token', type: 'address' },
                      { name: 'amount', type: 'uint256' },
                    ],
                  },
                  { name: 'nonce', type: 'uint256' },
                  { name: 'deadline', type: 'uint256' },
                ],
              },
              { name: 'sig', type: 'bytes' },
            ],
            outputs: [
              { name: 'jobAddress', type: 'address' },
              { name: 'jobMemoryNamespace', type: 'address' },
            ],
          },
        ] as const,
        functionName: 'createWithPermit2',
        args: [
          args.agentId, args.maxIterations, args.budgetMicroUsdc,
          args.permit, args.signature,
        ],
      });
      setTxHash(hash);
      return hash;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }

  return { hire, hireWithPermit2, txHash, isPending, error };
}

// ─── Live LoopJob state ──────────────────────────────────────────────────

export function useLoopJob(jobAddress: `0x${string}` | null) {
  const enabled = !!jobAddress;
  const status = useReadContract({
    address: jobAddress ?? undefined,
    abi: LOOP_JOB_ABI,
    functionName: 'status',
    query: { enabled, refetchInterval: 5000 },
  });
  const iter = useReadContract({
    address: jobAddress ?? undefined,
    abi: LOOP_JOB_ABI,
    functionName: 'iterationsDone',
    query: { enabled, refetchInterval: 5000 },
  });
  const max = useReadContract({
    address: jobAddress ?? undefined,
    abi: LOOP_JOB_ABI,
    functionName: 'maxIterations',
    query: { enabled },
  });
  const spent = useReadContract({
    address: jobAddress ?? undefined,
    abi: LOOP_JOB_ABI,
    functionName: 'spentMicroUsdc',
    query: { enabled, refetchInterval: 5000 },
  });
  const budget = useReadContract({
    address: jobAddress ?? undefined,
    abi: LOOP_JOB_ABI,
    functionName: 'budgetMicroUsdc',
    query: { enabled },
  });

  const statusName: LoopJobStatusName | null =
    status.data !== undefined ? LOOP_JOB_STATUS[Number(status.data)] : null;

  return {
    statusName,
    iterationsDone: iter.data ? Number(iter.data) : 0,
    maxIterations: max.data ? Number(max.data) : 0,
    spentMicroUsdc: spent.data ?? 0n,
    budgetMicroUsdc: budget.data ?? 0n,
    isLoading: status.isLoading || iter.isLoading,
  };
}

// ─── Iteration log (DB-backed, off-chain summary) ────────────────────────

export function useIterationLog(jobAddress: string | null) {
  const [log, setLog] = useState<IterationLogDto[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!jobAddress) return;
    setLoading(true);
    const tick = () =>
      fetch(`${ARBLOOP_API_URL}/v3/arbloop/jobs/${jobAddress}/iterations`)
        .then((r) => (r.ok ? r.json() : { iterations: [] }))
        .then((j) => setLog((j.iterations ?? []) as IterationLogDto[]))
        .catch(() => undefined)
        .finally(() => setLoading(false));
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [jobAddress]);
  return { log, loading };
}

// ─── Job metadata (DB-backed) ────────────────────────────────────────────

export function useJobMetadata(jobAddress: string | null) {
  const [meta, setMeta] = useState<JobMetadataDto | null>(null);
  useEffect(() => {
    if (!jobAddress) return;
    fetch(`${ARBLOOP_API_URL}/v3/arbloop/jobs/${jobAddress}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setMeta(j.job as JobMetadataDto))
      .catch(() => undefined);
  }, [jobAddress]);
  return meta;
}

// ─── Approve checkpoint ─────────────────────────────────────────────────

export function useApproveCheckpoint() {
  const { writeContractAsync, isPending } = useWriteContract();
  async function approve(jobAddress: `0x${string}`, iterN: number): Promise<`0x${string}` | null> {
    try {
      const hash = await writeContractAsync({
        address: ARBLOOP_ADDRESSES.checkpointApproval,
        abi: CHECKPOINT_APPROVAL_ABI,
        functionName: 'approve',
        args: [jobAddress, BigInt(iterN)],
      });
      return hash;
    } catch {
      return null;
    }
  }
  return { approve, isPending };
}
