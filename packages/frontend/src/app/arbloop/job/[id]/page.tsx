'use client';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useAccount } from 'wagmi';
import { useIterationLog, useIterationTxs, useJobMetadata, useLoopJob } from '@/hooks/useArbLoop';
import {
  ChangeRequestThread,
  CheckpointGate,
  IterationReceiptList,
  JobActionBar,
  JobDashboard,
  MemoryTraceViewer,
} from '@/components/arbloop';

export default function JobPage() {
  const params = useParams<{ id: string }>();
  const jobAddress = (params.id ?? '') as `0x${string}`;
  const { address } = useAccount();
  const meta = useJobMetadata(jobAddress);
  const job = useLoopJob(jobAddress);
  const { log } = useIterationLog(jobAddress);
  const txByIter = useIterationTxs(jobAddress);

  const showCheckpoint = job.statusName === 'PAUSED_CHECKPOINT';
  const nextIter = job.iterationsDone;

  return (
    <div className="space-y-6">
      <Link href="/arbloop/marketplace" className="text-xs text-on-surface-variant hover:text-primary">
        ← Marketplace
      </Link>

      <div className="grid gap-6 md:grid-cols-2">
        <JobDashboard
          jobAddress={jobAddress}
          statusName={job.statusName}
          iterationsDone={job.iterationsDone}
          maxIterations={job.maxIterations}
          spentMicroUsdc={job.spentMicroUsdc}
          budgetMicroUsdc={job.budgetMicroUsdc}
        />
        <div className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface p-6">
          <h3 className="font-headline text-lg font-semibold">Iterations</h3>
          <IterationReceiptList log={log} txByIter={txByIter} />
          {showCheckpoint && nextIter > 0 && (
            <CheckpointGate jobAddress={jobAddress} iterN={nextIter} />
          )}
        </div>
      </div>

      <section>
        <JobActionBar jobAddress={jobAddress} statusName={job.statusName} />
      </section>

      <section>
        <ChangeRequestThread jobAddress={jobAddress} selfAddress={address ?? null} />
      </section>

      <section>
        <h3 className="font-headline text-lg font-semibold mb-3">Memory trace</h3>
        <MemoryTraceViewer jobAddress={jobAddress} />
      </section>

      {meta && (
        <p className="font-mono text-[11px] text-on-surface-variant">
          buyer: {meta.buyer_address} · agent #{meta.agent_id} · created {new Date(meta.created_at).toLocaleString()}
        </p>
      )}
    </div>
  );
}
