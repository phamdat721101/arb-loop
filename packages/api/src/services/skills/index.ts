/**
 * skills/index.ts — Pham-authored bootstrap skills for the tri-marketplace.
 *
 * Three deterministic, small (~50 LOC each) handlers that the
 * marketing-7-step workflow invokes via its WorkflowStep.skillRef.url
 * pointing back at this server.
 *
 * SOLID:
 *   - SRP: each function does one thing — fetch HTML, return SEO keywords,
 *     return a deterministic schedule. No external dependencies beyond
 *     Node's built-in `fetch` and a 30-line HTML stripper.
 *   - DIP: handlers are pure async functions; the route layer wraps them.
 *
 * For Sui Overflow / Tatum × Walrus demo: deterministic outputs are the
 * point — judges can replay and verify. No flaky third-party APIs.
 */

import { createHash } from 'node:crypto';

// ─── ingest-url ────────────────────────────────────────────────────────────

export interface IngestUrlInput {
  url: string;
}

export interface IngestUrlOutput {
  url: string;
  title: string;
  /** Plain-text body (HTML tags stripped, whitespace collapsed, ≤4 KB). */
  text: string;
  /** sha256 of the raw HTML (for buyer audit). */
  contentHash: string;
}

export async function ingestUrl(input: IngestUrlInput): Promise<IngestUrlOutput> {
  if (!input?.url || !/^https?:\/\//.test(input.url)) {
    throw new Error('ingestUrl: url must be http(s)');
  }
  const resp = await fetch(input.url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`ingestUrl: fetch ${resp.status}`);
  const html = await resp.text();
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = (titleMatch?.[1] ?? '').trim().slice(0, 200);
  const text = stripTags(html).replace(/\s+/g, ' ').trim().slice(0, 4096);
  return {
    url: input.url,
    title,
    text,
    contentHash: createHash('sha256').update(html).digest('hex'),
  };
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

// ─── seo-keywords ──────────────────────────────────────────────────────────

export interface SeoKeywordsInput {
  text: string;
  /** Defaults to 10. */
  limit?: number;
}

export interface SeoKeywordsOutput {
  keywords: Array<{ phrase: string; weight: number }>;
}

const SEO_STOPWORDS = new Set([
  'the','a','an','and','or','but','if','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','should','could','may','might',
  'this','that','these','those','i','you','he','she','it','we','they','them','their',
  'in','on','at','to','from','with','by','for','of','as','about','into','over',
]);

export function seoKeywords(input: SeoKeywordsInput): SeoKeywordsOutput {
  const text = (input?.text ?? '').toLowerCase();
  const tokens = text
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !SEO_STOPWORDS.has(w));
  const counts = new Map<string, number>();
  // Bigrams (better SEO signal than unigrams).
  for (let i = 0; i < tokens.length - 1; i++) {
    const bg = `${tokens[i]} ${tokens[i + 1]}`;
    counts.set(bg, (counts.get(bg) ?? 0) + 1);
  }
  // Unigrams as fallback.
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const limit = input.limit ?? 10;
  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  return {
    keywords: sorted.map(([phrase, count]) => ({ phrase, weight: count })),
  };
}

// ─── buffer-schedule ───────────────────────────────────────────────────────

export interface BufferScheduleInput {
  posts: Array<{ id: string; channel: 'linkedin' | 'x' | 'twitter'; body: string }>;
  /** Optional anchor unix-ms; defaults to now. Determinism comes from caller passing this. */
  anchorMs?: number;
}

export interface BufferScheduleOutput {
  scheduled: Array<{
    postId: string;
    channel: string;
    bufferId: string;
    sendAt: string; // ISO
  }>;
}

/**
 * Mock Buffer scheduling — produces a deterministic schedule starting at
 * `anchorMs` and stepping +90 minutes per post. `bufferId` is a stable hash
 * over (postId|channel|sendAt) so the smoke test can assert exact output.
 */
export function bufferSchedule(input: BufferScheduleInput): BufferScheduleOutput {
  const anchor = input?.anchorMs ?? 1_717_500_000_000; // fixed default → reproducible demo
  const STEP = 90 * 60 * 1000;
  const out: BufferScheduleOutput['scheduled'] = [];
  const posts = Array.isArray(input?.posts) ? input.posts : [];
  posts.forEach((p, i) => {
    const sendAt = new Date(anchor + i * STEP).toISOString();
    const bufferId = createHash('sha256')
      .update(`${p.id}|${p.channel}|${sendAt}`)
      .digest('hex')
      .slice(0, 16);
    out.push({ postId: p.id, channel: p.channel, bufferId, sendAt });
  });
  return { scheduled: out };
}

// ─── invocation router ────────────────────────────────────────────────────

/**
 * dispatchSkill — looks up a bootstrap skill by `ref` (e.g. "ingest-url")
 * and invokes it with the given input. Returned as the canonical handler
 * for `WorkflowStep.skillRef.url` values that point back at this server.
 *
 * URL convention: `internal:<ref>` → dispatched here (no real HTTP call).
 * Real external skills use full https:// URLs and bypass this dispatcher.
 */
export async function dispatchSkill(
  ref: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (ref) {
    case 'ingest-url':
      return ingestUrl(input as unknown as IngestUrlInput);
    case 'seo-keywords':
      return seoKeywords(input as unknown as SeoKeywordsInput);
    case 'buffer-schedule':
      return bufferSchedule(input as unknown as BufferScheduleInput);
    default:
      throw new Error(`dispatchSkill: unknown ref "${ref}"`);
  }
}
