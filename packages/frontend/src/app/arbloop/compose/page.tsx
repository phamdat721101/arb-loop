'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { ARBLOOP_API_URL, type AgentMetadataDto } from '@/lib/arbloop';
import { AgentPersonaCard, LoopComposer } from '@/components/arbloop';

/**
 * Compose page — wraps the inner component in <Suspense> so Next.js can
 * statically generate the route. `useSearchParams()` requires a Suspense
 * boundary at the route level (next 14+ CSR bailout rule).
 *
 * SOLID: single-responsibility wrapper; data flow lives in `ComposeInner`.
 */
export default function ComposePage() {
  return (
    <Suspense fallback={<p className="py-12 text-center text-on-surface-variant">Loading…</p>}>
      <ComposeInner />
    </Suspense>
  );
}

function ComposeInner() {
  const params = useSearchParams();
  const router = useRouter();
  const agentIdParam = params.get('agent');
  const [agent, setAgent] = useState<AgentMetadataDto | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!agentIdParam) {
      router.replace('/arbloop/marketplace');
      return;
    }
    setLoading(true);
    fetch(`${ARBLOOP_API_URL}/v3/arbloop/agents/${agentIdParam}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setAgent(j.agent as AgentMetadataDto))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [agentIdParam, router]);

  if (loading) return <p className="py-12 text-center">Loading…</p>;
  if (!agent) return null;

  return (
    <div className="space-y-6">
      <h1 className="font-headline text-2xl font-bold">Compose a loop</h1>
      <div className="grid gap-6 md:grid-cols-2">
        <AgentPersonaCard a={agent} />
        <LoopComposer agent={agent} />
      </div>
    </div>
  );
}
