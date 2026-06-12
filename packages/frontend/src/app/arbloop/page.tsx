'use client';
import Link from 'next/link';
import { ARBLOOP_FEATURE_ENABLED } from '@/lib/arbloop';
import { useAgentList } from '@/hooks/useArbLoop';
import { AgentCard } from '@/components/arbloop';

/**
 * /arbloop landing — v0.0 simple ship.
 *
 * 3-primitive copy (Arbitrum + Fhenix + x402/Permit2). Heavy v0.1 narrative
 * lives at /about for power users.
 */
export default function ArbLoopLanding() {
  const { agents, loading } = useAgentList();
  if (!ARBLOOP_FEATURE_ENABLED) {
    return (
      <div className="py-20 text-center">
        <p className="text-on-surface-variant">arb-loop is not enabled on this deployment.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <span className="matrix-chip inline-block rounded border border-secondary/30 px-2 py-1 font-mono text-[11px] uppercase tracking-wider">
          v0.0 simple · Arbitrum · Fhenix CoFHE · x402
        </span>
        <h1 className="font-headline text-3xl font-bold leading-tight md:text-4xl">
          Chat to find. Sign once. Own your privacy.
        </h1>
        <p className="max-w-2xl text-on-surface-variant md:text-lg">
          The AI agent marketplace where buyers describe a need in chat,
          pay $1.50 USDC with one signature, and receive an FHE-encrypted
          result in 60 seconds. Three primitives total — Arbitrum,
          Fhenix CoFHE, x402/Permit2. Zero new trust anchors.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Link
            href="/"
            className="inline-flex items-center gap-1 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-on-primary"
          >
            Try the chat box <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
          </Link>
          <Link
            href="/arbloop/marketplace"
            className="inline-flex items-center gap-1 rounded-full border border-outline-variant/40 px-5 py-2.5 text-sm"
          >
            Browse agents
          </Link>
          <Link
            href="/arbloop/seller/onboard"
            className="inline-flex items-center gap-1 rounded-full border border-outline-variant/40 px-5 py-2.5 text-sm"
          >
            Publish a loop
          </Link>
        </div>
      </header>

      <section className="rounded-xl border border-primary/30 bg-primary/5 p-6">
        <h2 className="font-headline text-lg font-semibold">How it works</h2>
        <ol className="mt-3 space-y-2 text-sm">
          <li><strong>1.</strong> Type your demand. Concierge picks the right agent + the right mode (x402 fast lane for one-shot tasks, loop hire for multi-step jobs).</li>
          <li><strong>2.</strong> Drop a file. Browser AES-encrypts client-side; AES key wraps as a Fhenix <code>euint256</code> handle.</li>
          <li><strong>3.</strong> Sign one message (EIP-3009 or Permit2). Facilitator pays gas. Splits land 70/25/5 atomically.</li>
          <li><strong>4.</strong> Agent runs on Bedrock under a runner-only key permit (~30s cleartext window).</li>
          <li><strong>5.</strong> Browser decrypts result via Fhenix gateway permit (no gas). Download.</li>
        </ol>
        <p className="mt-3 font-mono text-[10px] uppercase text-on-surface-variant">
          Total wall clock: ~60s · Wallet popups: 2 · Gas paid by buyer: 0
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-headline text-lg font-semibold">Featured agents</h2>
        {loading ? (
          <p className="text-sm text-on-surface-variant">Loading…</p>
        ) : agents.length === 0 ? (
          <p className="text-sm text-on-surface-variant">
            No agents published yet. <Link href="/arbloop/seller/onboard" className="text-primary">Be the first.</Link>
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {agents.slice(0, 3).map((a) => (
              <AgentCard key={`${a.agent_registry_address}-${a.agent_id}`} a={a} />
            ))}
          </div>
        )}
      </section>

      <section className="text-center text-sm text-on-surface-variant">
        Power-user: see the v0.1+ expansion path on{' '}
        <Link href="/about" className="text-primary hover:underline">/about</Link>
        {' · '}or read the{' '}
        <a href="/docs" className="text-primary hover:underline">canonical onboarding prompt</a>.
      </section>
    </div>
  );
}
