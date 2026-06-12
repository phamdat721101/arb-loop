import { redirect } from 'next/navigation';

/**
 * /arbloop/marketplace → /marketplace (permanent redirect).
 *
 * The marketplace is unified at /marketplace as of 2026-06-12. This file
 * exists only to preserve back-compat for bookmarks and external links —
 * server-side redirect, no client render, no hydration cost.
 */
export default function ArbloopMarketplaceRedirect() {
  redirect('/marketplace');
}
