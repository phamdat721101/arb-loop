'use client';
/**
 * useArbLoop.ts — frontend hooks for the arb-loop marketplace.
 *
 * SOLID:
 *   - SRP: each hook owns one read or one write. Components never poke the
 *     network directly.
 *   - DIP: addresses + ABIs come from `lib/arbloop.ts`; backend URL from env.
 */

import { useEffect, useRef, useState } from 'react';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
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

// ─── useDocumentVisibility ───────────────────────────────────────────────
//
// Returns true while the tab is foregrounded. Used by useFetchJson to skip
// polls on hidden tabs (mobile battery + server load). Single subscription
// per page; consumers all read the same boolean.
export function useDocumentVisibility(): boolean {
  const [visible, setVisible] = useState(
    typeof document === 'undefined' ? true : document.visibilityState === 'visible',
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

// ─── useFetchJson<T> ─────────────────────────────────────────────────────
//
// One generic JSON-poll hook for every new Studio surface. Replaces the
// useState/useEffect/fetch triplet that older hooks (useAgentList,
// useIterationLog, useJobMetadata) each open-coded. Existing hooks are
// left untouched per the "do not edit too much" mandate; new code adopts
// this from day one.
//
//   - SRP: fetch + state + interval lifecycle, nothing else.
//   - DIP: caller passes the URL (already DI'd via ARBLOOP_API_URL).
//   - Battery: skips ticks when document.visibilityState !== 'visible'.
//   - Cancellation: AbortController + a mounted guard so a slow response
//     after unmount cannot setState on a dead component.
export function useFetchJson<T>(
  url: string | null,
  opts: { intervalMs?: number; enabled?: boolean; headers?: Record<string, string> } = {},
): { data: T | null; loading: boolean; error: string | null; refetch: () => void } {
  const { intervalMs, enabled = true, headers } = opts;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const visible = useDocumentVisibility();
  // Stable string key so a freshly-allocated headers object on each render
  // does not retrigger the fetch effect. The effect captures `headers` via
  // closure, so the actual request always sees the latest values.
  const headersKey = JSON.stringify(headers ?? null);

  useEffect(() => {
    if (!enabled || !url) return;
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    fetch(url, { signal: ctrl.signal, headers })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { if (!cancelled) { setData(j as T); setError(null); } })
      .catch((e) => { if (!cancelled && (e as Error).name !== 'AbortError') setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, enabled, tick, headersKey]);

  useEffect(() => {
    if (!enabled || !url || !intervalMs || !visible) return;
    const t = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [url, enabled, intervalMs, visible]);

  return { data, loading, error, refetch: () => setTick((n) => n + 1) };
}

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

// ─── On-chain settlement tx hashes per iter ──────────────────────────────
//
// On-chain truth: every iter advance for mode-B (loop hire) emits
// `IterAdvanced(uint256 iterN, bytes32 attestationUid, uint256 newSpentMicroUsdc)`
// from the LoopJob contract. The transactionHash that emitted that event IS
// the settlement tx (the same call also performs the 70/25/5 USDC split via
// `advanceIterWithSplit`). We read it directly from the chain rather than
// caching in DB so the link is always trustworthy and we never have a
// backfill problem for older rows.
//
// SRP: this hook owns one read — Map<iterN, txHash>. UI components consume.
// Cost: one viem getLogs per mount (the cache is wagmi's PublicClient).
export function useIterationTxs(jobAddress: `0x${string}` | null) {
  const publicClient = usePublicClient();
  const [txByIter, setTxByIter] = useState<Record<number, `0x${string}`>>({});
  useEffect(() => {
    if (!jobAddress || !publicClient) return;
    let cancelled = false;
    (async () => {
      try {
        const logs = await publicClient.getLogs({
          address: jobAddress,
          event: {
            type: 'event',
            name: 'IterAdvanced',
            inputs: [
              { name: 'iterN', type: 'uint256', indexed: true },
              { name: 'attestationUid', type: 'bytes32' },
              { name: 'newSpentMicroUsdc', type: 'uint256' },
            ],
          },
          fromBlock: 'earliest',
          toBlock: 'latest',
        });
        if (cancelled) return;
        const next: Record<number, `0x${string}`> = {};
        for (const lg of logs) {
          const iterN = Number((lg as { args: { iterN: bigint } }).args.iterN);
          if (!Number.isFinite(iterN)) continue;
          next[iterN] = lg.transactionHash as `0x${string}`;
        }
        setTxByIter(next);
      } catch { /* RPC may be flaky; fall back to no-link UX */ }
    })();
    return () => { cancelled = true; };
  }, [jobAddress, publicClient]);
  return txByIter;
}

/** Per-network block-explorer base URL — used by tx and address links. */
export function explorerTxUrl(txHash: string): string {
  const network = (process.env.NEXT_PUBLIC_ARBLOOP_NETWORK as 'arbitrum' | 'arbitrum-sepolia') ?? 'arbitrum-sepolia';
  const base = network === 'arbitrum' ? 'https://arbiscan.io' : 'https://sepolia.arbiscan.io';
  return `${base}/tx/${txHash}`;
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

// ─── Buyer portfolio (Studio) ────────────────────────────────────────────
//
// Polls /v3/arbloop/buyer/:address/jobs every 5s while any job is RUNNING,
// every 30s otherwise. The cadence is computed inside the component from
// the returned rows, then fed back into useFetchJson via opts.intervalMs.
import type { BuyerJobDto, SellerJobDto } from '@/lib/arbloop';

export function useBuyerJobs(buyerAddress: `0x${string}` | null | undefined, intervalMs: number) {
  const url = buyerAddress
    ? `${ARBLOOP_API_URL}/v3/arbloop/buyer/${buyerAddress.toLowerCase()}/jobs`
    : null;
  const r = useFetchJson<{ jobs: BuyerJobDto[] }>(url, { intervalMs });
  return { jobs: r.data?.jobs ?? [], loading: r.loading, error: r.error, refetch: r.refetch };
}

// Seller "Hires" portfolio — same shape as useBuyerJobs but with earnings.
export function useSellerJobs(sellerAddress: `0x${string}` | null | undefined, intervalMs: number) {
  const url = sellerAddress
    ? `${ARBLOOP_API_URL}/v3/arbloop/seller/${sellerAddress.toLowerCase()}/jobs`
    : null;
  const r = useFetchJson<{ jobs: SellerJobDto[] }>(url, { intervalMs });
  return { jobs: r.data?.jobs ?? [], loading: r.loading, error: r.error, refetch: r.refetch };
}

// ─── On-chain job actions: pause / resume / cancel ───────────────────────
//
// Three thin wagmi-write hooks. Same shape as useApproveCheckpoint so the
// caller story is uniform: `await action(jobAddress)` → tx hash or null.
// The contract enforces status guards; UI hides each button when it would
// revert, but a stale UI state still cannot corrupt on-chain state.
function useJobAction(fn: 'pause' | 'resume' | 'cancel') {
  const { writeContractAsync, isPending } = useWriteContract();
  async function call(jobAddress: `0x${string}`): Promise<`0x${string}` | null> {
    try {
      return await writeContractAsync({
        address: jobAddress,
        abi: LOOP_JOB_ABI,
        functionName: fn,
        args: [],
      });
    } catch {
      return null;
    }
  }
  return { call, isPending };
}
export const usePauseJob = () => useJobAction('pause');
export const useResumeJob = () => useJobAction('resume');
export const useCancelJob = () => useJobAction('cancel');

// ─── Change requests (off-chain thread) ──────────────────────────────────
//
// One pair of hooks: list (poll 10s, visibility-gated by useFetchJson) +
// post. The POST sends `x-wallet-address` so the API can authorize the
// caller as either buyer or seller of the job.
export interface ChangeRequestDto {
  id: number;
  job_contract_address: string;
  body: string;
  direction: 'buyer_to_seller' | 'seller_to_buyer';
  sender_address: string;
  created_at: string;
}

export function useChangeRequests(jobAddress: string | null) {
  const { address } = useAccount();
  // GET /change-requests is auth-gated by the API (x-wallet-address must be
  // buyer or seller of the job). Don't even attempt the call when no wallet
  // is connected — the UI shows the empty-state placeholder instead of a
  // user-hostile "HTTP 401" error.
  const url = jobAddress && address
    ? `${ARBLOOP_API_URL}/v3/arbloop/jobs/${jobAddress.toLowerCase()}/change-requests`
    : null;
  const r = useFetchJson<{ requests: ChangeRequestDto[] }>(url, {
    intervalMs: 10_000,
    headers: address ? { 'x-wallet-address': address } : undefined,
  });
  return { requests: r.data?.requests ?? [], loading: r.loading, error: r.error, refetch: r.refetch };
}

export function useSendChangeRequest(jobAddress: string | null) {
  const { address } = useAccount();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send(body: string): Promise<boolean> {
    if (!jobAddress || !address) { setError('connect a wallet first'); return false; }
    const trimmed = body.trim();
    if (!trimmed) return false;
    if (trimmed.length > 2000) { setError('message too long (max 2000 chars)'); return false; }
    setSending(true); setError(null);
    try {
      const r = await fetch(
        `${ARBLOOP_API_URL}/v3/arbloop/jobs/${jobAddress.toLowerCase()}/change-requests`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-wallet-address': address },
          body: JSON.stringify({ body: trimmed }),
        },
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSending(false);
    }
  }
  return { send, sending, error };
}
