'use client';

import { useEffect, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { usePrivyEvmAddress } from '@/hooks/useActiveWallet';
import { useParams } from 'next/navigation';
import { AGENT_BACKEND_URL } from '@/lib/contracts';
import { createLogger } from '@/lib/clientLogger';

const log = createLogger('bundlePage');

interface BundleStep {
  agent_id: string;
  endpoint: string;
  rail: 'x402' | 'mpp';
  price_usdc: string;
  estimated_calls: number;
  description?: string;
}

interface BundleManifest {
  id: string;
  issuer: string;
  steps: BundleStep[];
  aggregate_price_usdc: string;
  expires_at: number;
  signature: string;
}

interface RunEvent { event: string; data: any }

const RAIL_LABEL: Record<string, string> = { x402: 'x402', mpp: 'MPP (Tempo)' };

export default function BundlePage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const { user, login, authenticated } = usePrivy();
  const wallet = usePrivyEvmAddress();

  const [manifest, setManifest] = useState<BundleManifest | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${AGENT_BACKEND_URL}/v3/bundles/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then(setManifest)
      .catch((e) => setError(`Bundle load failed: ${e.message}`));
    fetch(`${AGENT_BACKEND_URL}/v3/bundles/${encodeURIComponent(id)}/verify`, { method: 'POST' })
      .then((r) => r.json())
      .then(setVerify)
      .catch(() => {});
  }, [id]);

  const run = async () => {
    if (!authenticated || !wallet) return login();
    setEvents([]);
    setRunning(true);
    log.step('run:start', { bundleId: id });
    try {
      const r = await fetch(`${AGENT_BACKEND_URL}/v3/runner/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wallet-address': wallet },
        body: JSON.stringify({}),
      });
      const reader = r.body?.getReader();
      if (!reader) throw new Error('no body');
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const p of parts) {
          const ev = p.match(/^event: (.+)$/m)?.[1];
          const data = p.match(/^data: (.+)$/m)?.[1];
          if (ev && data) {
            try {
              setEvents((prev) => [...prev, { event: ev, data: JSON.parse(data) }]);
            } catch {/* ignore */}
          }
        }
      }
      log.info('run:done');
    } catch (e: any) {
      log.error('run:failed', e);
      setError(e?.message ?? String(e));
    } finally {
      setRunning(false);
    }
  };

  if (error && !manifest) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <h1 className="text-2xl font-semibold">Bundle</h1>
        <p className="mt-3 text-sm text-error">{error}</p>
      </div>
    );
  }
  if (!manifest) return <div className="p-8">Loading…</div>;

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-8">
      <header>
        <h1 className="font-headline text-3xl font-bold">Bundle</h1>
        <p className="mt-1 font-mono text-xs text-on-surface-variant">{manifest.id}</p>
        <p className="mt-1 text-sm text-on-surface-variant">
          Issued by {manifest.issuer} · expires {new Date(manifest.expires_at).toLocaleString()}
        </p>
        {verify && (
          <p className={`mt-1 text-sm ${verify.ok ? 'text-secondary' : 'text-error'}`}>
            {verify.ok ? '✅ Signature valid' : `❌ ${verify.reason}`}
          </p>
        )}
      </header>

      <section className="rounded-xl border border-outline-variant/30 bg-surface p-6">
        <div className="flex justify-between">
          <div className="text-xs uppercase text-on-surface-variant">Total</div>
          <div className="text-2xl font-semibold">${Number(manifest.aggregate_price_usdc).toFixed(4)}</div>
        </div>
        <ol className="mt-3 space-y-2">
          {manifest.steps.map((s, i) => (
            <li
              key={i}
              className="flex items-center justify-between rounded-lg border border-outline-variant/40 bg-surface-container px-3 py-2 text-sm"
            >
              <span>
                <span className="mr-2 font-mono text-xs uppercase text-primary">{RAIL_LABEL[s.rail]}</span>
                Agent <code className="font-mono text-xs">{s.agent_id.slice(0, 8)}…</code>
              </span>
              <span className="font-mono text-xs">${Number(s.price_usdc).toFixed(4)} × {s.estimated_calls}</span>
            </li>
          ))}
        </ol>
      </section>

      <button
        onClick={run}
        disabled={running || !verify?.ok}
        className="w-full rounded-full bg-primary px-5 py-3 font-medium text-on-primary transition-colors hover:opacity-90 disabled:opacity-50"
      >
        {running ? 'Running…' : 'Run bundle (hosted)'}
      </button>

      {error && <div className="rounded-lg border border-error/40 bg-error/5 p-3 text-sm text-error">{error}</div>}

      {events.length > 0 && (
        <section className="rounded-lg bg-slate-900 p-4 font-mono text-xs text-slate-100">
          {events.map((e, i) => (
            <div key={i}>
              <span className="text-emerald-400">{e.event}</span>{' '}
              {JSON.stringify(e.data)}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
