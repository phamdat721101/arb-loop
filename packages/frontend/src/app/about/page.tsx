'use client';
/**
 * /about — power-user explainer.
 *
 * Preserves the heavy v0.1 narrative (EigenDA + Arweave + Lit + EAS + 0xSplits)
 * for technical readers and to anchor the v0.1 expansion path. v0.0's `/`
 * and `/arbloop` use the simple-3-primitive copy.
 */

import Link from 'next/link';

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-10 py-6">
      <header className="space-y-2">
        <span className="matrix-chip rounded border border-secondary/30 px-2 py-1 font-mono text-[11px] uppercase">
          About OpenX · arb-loop
        </span>
        <h1 className="font-headline text-3xl font-bold">The architecture, in detail.</h1>
        <p className="text-on-surface-variant">
          v0.0 ships with 3 primitives — Arbitrum + Fhenix + x402/Permit2.
          What follows is the v0.1+ expansion path: 8 primitives,
          re-enabled when measured demand validates each one.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="font-headline text-xl font-semibold">v0.0 simple — what ships first</h2>
        <ul className="space-y-2 text-sm text-on-surface-variant">
          <li><strong className="text-on-surface">Arbitrum One</strong> — settlement, USDC, sub-cent gas, ~250–500ms blocks.</li>
          <li><strong className="text-on-surface">Fhenix CoFHE</strong> — non-forkable FHE substrate; AES key wrapped as <code>euint256</code>; runner decrypts under temporary <code>FHE.allow()</code>.</li>
          <li><strong className="text-on-surface">x402 + Permit2</strong> — HTTP 402 + EIP-3009 (one-shot tasks) and Permit2 + multicall (loop hire). One sig per task. Hard cap: 2 wallet popups.</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-headline text-xl font-semibold">v0.1+ expansion — what unlocks with measured demand</h2>
        <ul className="space-y-2 text-sm text-on-surface-variant">
          <li><strong className="text-on-surface">EigenDA</strong> — hot ciphertext lane (replaces Pinata IPFS at scale).</li>
          <li><strong className="text-on-surface">Arweave</strong> — permanent L4/L5 memory (Arweave bundles for cross-job pattern compounding).</li>
          <li><strong className="text-on-surface">Lit Protocol V3</strong> — multi-tier access control (replaces server-side Fhenix gateway permits at scale).</li>
          <li><strong className="text-on-surface">EAS attestations</strong> — composable per-iter receipts external apps can reference.</li>
          <li><strong className="text-on-surface">Phala TEE</strong> — attested inference backend; the second backend after AWS Bedrock.</li>
          <li><strong className="text-on-surface">0xSplits PullSplit</strong> — &gt;3-recipient split waterfalls (royalties, multi-author bundles).</li>
          <li><strong className="text-on-surface">Multicall3</strong> — atomicity beyond per-iter advance-with-split (multi-checkpoint workflows).</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-headline text-xl font-semibold">Why ship simple first</h2>
        <p className="text-sm text-on-surface-variant">
          Each deferred primitive is a real engineering surface. Shipping all 8 from
          Day-1 increases the surface area to audit, document, and demo by 8×. In
          contrast, the 3-primitive ship gets to a working buyer journey
          (chat → 1 sig → result in 60s) with one third the LOC.
        </p>
        <p className="text-sm text-on-surface-variant">
          Heavy v0.1 features stay in the codebase under{' '}
          <code>services/arbloop/_deferred/</code> behind feature flags
          (<code>FEATURE_ARBLOOP_DEFERRED_*</code>). Re-enabling each is a 1-PR change
          with explicit Gstack-frame justification.
        </p>
      </section>

      <section className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
        <h3 className="font-headline text-sm font-semibold">For builders</h3>
        <ul className="space-y-1.5 text-sm">
          <li>• <Link href="/arbloop" className="text-primary hover:underline">arb-loop landing</Link> — buyer-side product</li>
          <li>• <Link href="/arbloop/marketplace" className="text-primary hover:underline">Marketplace</Link> — power-user browse</li>
          <li>• <Link href="/arbloop/seller/onboard" className="text-primary hover:underline">Seller onboard</Link> — gasless EIP-712 publish</li>
          <li>• <Link href="/docs" className="text-primary hover:underline">Docs</Link> — MCP host config + canonical onboarding prompt</li>
          <li>• <a href="https://github.com/phamdat721701/privacy-context" className="text-primary hover:underline">GitHub</a> — MIT, single-dev, 43/45 Gstack target</li>
        </ul>
      </section>
    </div>
  );
}
