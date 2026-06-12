'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ARBLOOP_API_URL, type AgentMetadataDto } from '@/lib/arbloop';
import { AgentPersonaCard, LoopComposer } from '@/components/arbloop';

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const agentId = Number(params.id);
  const [agent, setAgent] = useState<AgentMetadataDto | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!Number.isFinite(agentId)) return;
    setLoading(true);
    fetch(`${ARBLOOP_API_URL}/v3/arbloop/agents/${agentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setAgent(j.agent as AgentMetadataDto))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [agentId]);

  if (loading) return <p className="py-12 text-center text-on-surface-variant">Loading…</p>;
  if (!agent)
    return (
      <div className="py-12 text-center space-y-2">
        <p className="text-on-surface-variant">Agent not found.</p>
        <Link href="/arbloop/marketplace" className="text-primary hover:underline">
          ← back to marketplace
        </Link>
      </div>
    );

  return (
    <div className="space-y-6">
      <Link href="/arbloop/marketplace" className="text-xs text-on-surface-variant hover:text-primary">
        ← Marketplace
      </Link>
      <div className="grid gap-6 md:grid-cols-2">
        <AgentPersonaCard a={agent} />
        <LoopComposer agent={agent} />
      </div>
    </div>
  );
}
