'use client';

/**
 * /brain/new — Tier-aware new-brain entry page.
 *
 * Step 1: tier picker (Standard vs Trustless) — see `TierPicker.tsx`.
 * Step 2: hand off to the existing publish flow (`/studio/publish` or
 * `/launch`), with `?tier=…` baked into the URL by `useTier`.
 *
 * Per option 6=b: explicit picker (not auto-by-wallet) — institutional
 * buyers want to see the trade-offs surfaced before they commit.
 */

import { useRouter } from 'next/navigation';
import { TierPicker } from '@/components/TierPicker';

export default function NewBrainPage() {
  const router = useRouter();
  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-semibold text-gray-900">Pick a storage tier</h1>
      <p className="mt-1 text-sm text-gray-600">
        OpenX runs two tiers in parallel. Your brain stays on the tier you pick;
        you can migrate between them later from <span className="font-mono">/settings</span>.
      </p>
      <div className="mt-8">
        <TierPicker onPick={(t) => router.push(`/launch?tier=${t}`)} />
      </div>
    </main>
  );
}
