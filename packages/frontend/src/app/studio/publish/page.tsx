'use client';

/**
 * /studio/publish — soft-deprecated 2026-06-09 (PRD-17 §1b).
 *
 * The legacy two-step (draft brain → publish paid API) is superseded by
 * the unified `/seller/onboard` 5-step wizard which atomically publishes
 * brain + agent + privacy in one transaction. We keep this route only as
 * a back-compat redirect so any bookmarked URL or in-flight tab lands on
 * the new flow with the studio context preserved (`?return=/studio` makes
 * the success card "Back to Studio" CTA point home).
 *
 * The original `PublishWizard.tsx` component source is intentionally left
 * untouched for one release cycle so a single-line revert restores the
 * old UI if a regression surfaces. Removal lands in v2.1.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const TARGET = '/seller/onboard?return=/studio';

export default function StudioPublishRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace(TARGET);
  }, [router]);
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <p className="font-mono text-xs uppercase tracking-wider text-on-surface-variant">
        Redirecting to the unified publish wizard…
      </p>
      <a href={TARGET} className="mt-3 inline-block text-sm text-primary underline">
        Continue manually
      </a>
    </div>
  );
}
