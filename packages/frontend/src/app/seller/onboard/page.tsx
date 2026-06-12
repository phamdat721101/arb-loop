'use client';

/**
 * /seller/onboard — 5-step seller-first wizard (PRD-14 + 15 + 16).
 *
 *   Step 1 · Listing core (title, short_description, domain, tags)
 *   Step 2 · Seller profile (display_name, bio, identity, contact_email)
 *   Step 3 · Privacy posture (auto-detected from connected network)
 *   Step 4 · Sub-step picker — API · Workflow · Skill — each with its own form
 *   Step 5 · Pricing + persona + Publish
 *   →  Success card with "Spawn another agent" CTA (returns to Step 4 with
 *      profile + privacy + listing pre-filled).
 *
 * Feature-flagged on the server side. When FEATURE_MARKETPLACE_V1_SELLER_FIRST
 * is off, the publish endpoint accepts the v1 (kind=api, no privacy block)
 * payload byte-identically — this wizard sends the v2 payload regardless,
 * which the service tolerates via defaults.
 *
 * SOLID:
 *  - SRP: this file owns the wizard state machine. Composers and badges
 *    are imported; the page never reaches into their internals.
 *  - DIP: the privacy detection algorithm comes from the SDK
 *    (`detectPrivacyMode` via `useConnectedPrivacyMode`), not from this file.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useActiveWallet } from '@/hooks/useActiveWallet';
import { useConnectedPrivacyMode } from '@/hooks/useConnectedPrivacyMode';
import { AGENT_BACKEND_URL } from '@/lib/contracts';
import { createLogger } from '@/lib/clientLogger';
import type { PrivacyMode } from '@fhe-ai-context/sdk';
import {
  WorkflowComposer,
  type WorkflowDraft,
} from './composers/WorkflowComposer';
import { SkillComposer, type SkillDraft } from './composers/SkillComposer';

const log = createLogger('seller-onboard');

const DOMAINS = [
  { id: 'marketing', label: 'Marketing' },
  { id: 'finance', label: 'Finance' },
  { id: 'research', label: 'Research' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'generalist', label: 'Generalist' },
  { id: 'other', label: 'Other' },
] as const;

type DomainId = (typeof DOMAINS)[number]['id'];

const RAILS = [
  { id: 'x402', label: 'x402 USDC (default — fastest, public)' },
  { id: 'mpp', label: 'MPP voucher' },
] as const;

type RailId = (typeof RAILS)[number]['id'];

const KINDS = [
  {
    id: 'api',
    label: 'API listing',
    desc: 'I have an HTTP API or want to wrap a third-party API as my own.',
  },
  {
    id: 'workflow',
    label: 'Workflow listing',
    desc: 'A multi-step recipe — research → write → post → track — that composes existing tools.',
  },
  {
    id: 'skill',
    label: 'Skill listing',
    desc: 'A single fast tool (ingest-URL, SEO-keywords) that other workflows compose.',
  },
] as const;

type KindId = (typeof KINDS)[number]['id'];

interface PublishResult {
  agent_id: string;
  brain_id: number;
  seller_id: number;
  slug: string;
  domain: DomainId;
  kind: KindId;
  verification_tier: 'basic' | 'verified' | 'tee_attested';
  chain: string;
  privacy_mode: 'fhe' | 'metadata-only' | 'off';
  privacy_source: 'auto' | 'manual';
  listing_url: string;
  knowledge_url: string | null;
  mcp_invoke_snippet: string;
}

interface SellerProfile {
  display_name: string;
  bio: string;
  contact_email: string;
  support_url: string;
  identity_handle: string;
}

interface FormState {
  // Step 1 — listing core
  title: string;
  short_description: string;
  domain: DomainId;
  tags: string;
  // Step 2 — seller profile
  profile: SellerProfile;
  // Step 3 — privacy override (undefined = auto-detect)
  privacy_override: PrivacyMode | undefined;
  // Step 4 — listing kind + per-kind drafts
  kind: KindId;
  workflow_draft: WorkflowDraft | null;
  skill_draft: SkillDraft | null;
  // Step 5 — pricing + persona (api/skill use these directly; workflow uses
  // the composer's own pricing — these fields stay sane defaults).
  persona_system_prompt: string;
  persona_tools: string;
  pricing_amount_usdc: string;
  pricing_rails: RailId[];
  accept_private_payment: boolean;
}

const INITIAL: FormState = {
  title: '',
  short_description: '',
  domain: 'generalist',
  tags: '',
  profile: { display_name: '', bio: '', contact_email: '', support_url: '', identity_handle: '' },
  privacy_override: undefined,
  kind: 'api',
  workflow_draft: null,
  skill_draft: null,
  persona_system_prompt: '',
  persona_tools: '',
  pricing_amount_usdc: '0.05',
  pricing_rails: ['x402'],
  accept_private_payment: false,
};

/**
 * Read `?return=` from the current URL and validate it's an internal path.
 * Returns null when missing, malformed, or attempting an open-redirect
 * (anything not starting with a single `/`). PRD-17 §1b.
 */
function getInternalReturnPath(): string | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('return');
  if (!v) return null;
  if (!v.startsWith('/') || v.startsWith('//')) return null;
  return v;
}

function isStepValid(s: number, f: FormState): boolean {
  if (s === 1) {
    return (
      f.title.trim().length >= 3 &&
      f.short_description.trim().length >= 10 &&
      DOMAINS.some((d) => d.id === f.domain)
    );
  }
  if (s === 2) return f.profile.display_name.trim().length >= 2;
  if (s === 3) return true; // privacy auto-detected; never blocks
  if (s === 4) {
    if (f.kind === 'api') return f.persona_system_prompt.trim().length >= 10;
    if (f.kind === 'workflow') return (f.workflow_draft?.steps.length ?? 0) >= 1;
    if (f.kind === 'skill') return (f.skill_draft?.persona_system_prompt.trim().length ?? 0) >= 10;
  }
  if (s === 5) {
    return Number(f.pricing_amount_usdc) > 0 && f.pricing_rails.length >= 1;
  }
  return false;
}


// ─── Main component ──────────────────────────────────────────────────────

export default function SellerOnboardPage() {
  const wallet = useActiveWallet();
  const privacy = useConnectedPrivacyMode();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [form, setForm] = useState<FormState>(INITIAL);

  function update<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((s) => ({ ...s, [k]: v }));
  }
  function patchProfile(patch: Partial<SellerProfile>) {
    setForm((s) => ({ ...s, profile: { ...s.profile, ...patch } }));
  }
  function toggleRail(r: RailId) {
    setForm((s) => ({
      ...s,
      pricing_rails: s.pricing_rails.includes(r)
        ? s.pricing_rails.filter((x) => x !== r)
        : [...s.pricing_rails, r],
    }));
  }

  async function submit() {
    if (!wallet?.address) {
      setErr('Connect a wallet to publish.');
      return;
    }
    setBusy(true);
    setErr(null);

    // Build kind-specific publish payload. Skills/workflows reuse the same
    // pricing+persona fields the API expects, populated from the composers
    // when relevant.
    const kind: KindId = form.kind;
    const persona_system_prompt =
      kind === 'skill' && form.skill_draft?.persona_system_prompt
        ? form.skill_draft.persona_system_prompt
        : form.persona_system_prompt;
    const persona_tools =
      kind === 'skill' && form.skill_draft?.persona_tools ? form.skill_draft.persona_tools : form.persona_tools;
    const pricing_amount_usdc =
      kind === 'workflow' && form.workflow_draft
        ? form.workflow_draft.default_price_usdc
        : kind === 'skill' && form.skill_draft
          ? form.skill_draft.price_usdc
          : form.pricing_amount_usdc;

    try {
      const r = await fetch(`${AGENT_BACKEND_URL}/v3/marketplace/seller/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-wallet-address': wallet.address },
        body: JSON.stringify({
          title: form.title.trim(),
          short_description: form.short_description.trim(),
          domain: form.domain,
          tags: form.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 10),
          persona_system_prompt: persona_system_prompt.trim() || form.title.trim(),
          persona_tools: persona_tools
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 10),
          pricing_amount_usdc,
          pricing_rails: form.pricing_rails,
          accept_private_payment: form.accept_private_payment,
          kind,
          workflow:
            kind === 'workflow' && form.workflow_draft
              ? {
                  workflow_key: form.workflow_draft.workflow_key,
                  name: form.workflow_draft.name || form.title.trim(),
                  description: form.workflow_draft.description,
                  steps: form.workflow_draft.steps,
                  default_price_usdc: form.workflow_draft.default_price_usdc,
                  author_bps: form.workflow_draft.author_bps,
                  platform_bps: form.workflow_draft.platform_bps,
                }
              : undefined,
          seller_profile: {
            display_name: form.profile.display_name,
            bio: form.profile.bio || undefined,
            identity_handle: form.profile.identity_handle || undefined,
            contact_email: form.profile.contact_email || undefined,
            support_url: form.profile.support_url || undefined,
          },
          privacy: {
            mode: privacy.detected.mode,
            source: privacy.detected.source,
            chain_id: privacy.chainId,
          },
        }),
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) throw new Error((j?.error as string) ?? `HTTP ${r.status}`);
      setResult(j as unknown as PublishResult);
      log.info('publish:ok', { slug: (j as { slug?: string }).slug });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      log.warn('publish:failed', { err: msg });
    } finally {
      setBusy(false);
    }
  }

  // "Spawn another" — keep profile + privacy + kind, reset listing fields.
  function spawnAnother() {
    setResult(null);
    setForm((s) => ({
      ...INITIAL,
      profile: s.profile,
      privacy_override: s.privacy_override,
      kind: s.kind,
    }));
    setStep(1);
  }

  if (result) return <SuccessCard result={result} onSpawnAnother={spawnAnother} returnPath={getInternalReturnPath()} />;

  const stepLabels = ['Listing', 'Profile', 'Privacy', 'Kind', 'Pricing'];

  return (
    <div className="mx-auto max-w-2xl space-y-7 py-6 md:py-10">
      <header className="space-y-2">
        <span className="matrix-chip inline-block rounded border border-secondary/20 px-2 py-1 font-mono text-[11px] uppercase tracking-wider">
          Sell on OpenX
        </span>
        <h1 className="font-headline text-3xl font-bold leading-tight md:text-4xl">
          Publish your agent in 5 steps
        </h1>
        <p className="text-sm text-on-surface-variant md:text-base">
          One human, many agents. Privacy via Fhenix CoFHE on Arbitrum — the
          buyer's input never leaves ciphertext.
        </p>
        {/* PRD-18 — symmetric callout to /docs Section E. Sellers who prefer
            an MCP-driven workflow can mint a single-use Fhenix permit at /docs
            and let their agent (Claude / Cursor / Codex) call the same
            /v3/marketplace/seller/publish endpoint via the openx_seller_publish
            tool. Same backend, same atomic transaction, zero form. */}
        <p className="rounded-lg border border-outline-variant/20 bg-surface-container-low px-3 py-2 text-xs text-on-surface-variant">
          Prefer to onboard via your AI agent?{' '}
          <a href="/docs" className="text-primary hover:underline">
            Open /docs
          </a>{' '}
          to mint a one-prompt Fhenix permit and let Claude or Cursor publish for you.
        </p>
      </header>

      <ol role="list" className="grid grid-cols-5 gap-2 text-xs">
        {stepLabels.map((label, idx) => {
          const n = idx + 1;
          const stateClass =
            step === n
              ? 'border-primary text-primary'
              : step > n
                ? 'border-secondary/40 text-secondary'
                : 'border-outline-variant/30 text-on-surface-variant';
          return (
            <li
              key={n}
              aria-current={step === n ? 'step' : undefined}
              className={`flex items-center gap-2 rounded border px-2 py-1.5 ${stateClass}`}
            >
              <span className="font-mono">{step > n ? '✓' : n}</span>
              <span className="truncate">{label}</span>
            </li>
          );
        })}
      </ol>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!isStepValid(step, form)) return;
          if (step < 5) setStep((s) => (s + 1) as 1 | 2 | 3 | 4 | 5);
          else submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            (e.currentTarget.querySelector('button[type=submit]') as HTMLButtonElement | null)?.click();
          }
        }}
        className="space-y-5 rounded-xl border border-outline-variant/30 bg-surface p-5 md:p-6"
      >
        {step === 1 && <Step1 form={form} update={update} />}
        {step === 2 && <Step2 profile={form.profile} patch={patchProfile} />}
        {step === 3 && (
          <Step3
            tier={privacy.detected.tier}
            reason={privacy.detected.reason}
            override={form.privacy_override}
            setOverride={(m) => {
              update('privacy_override', m);
              privacy.setOverride(m);
            }}
          />
        )}
        {step === 4 && (
          <Step4
            kind={form.kind}
            setKind={(k) => update('kind', k)}
            form={form}
            update={update}
          />
        )}
        {step === 5 && <Step5 form={form} update={update} toggleRail={toggleRail} />}

        {!wallet?.address && (
          <p role="alert" className="text-sm text-amber-500">
            Sign in to publish. Your account is secured automatically — no wallet, gas, or seed
            phrase needed.
          </p>
        )}
        {wallet?.address && (
          <p className="flex items-center gap-2 text-xs text-secondary">
            <span className="material-symbols-outlined text-[14px]" aria-hidden>
              verified_user
            </span>
            <span>Account secured</span>
            <details className="ml-auto cursor-pointer text-on-surface-variant">
              <summary className="text-[11px] hover:text-on-surface">Advanced</summary>
              <div className="mt-1 font-mono text-[11px]">{wallet.address}</div>
            </details>
          </p>
        )}
        {err && (
          <p role="alert" className="text-sm text-amber-500">
            {err}
          </p>
        )}

        <div className="flex justify-between gap-2">
          <button
            type="button"
            disabled={step === 1 || busy}
            onClick={() => setStep((s) => Math.max(1, s - 1) as 1 | 2 | 3 | 4 | 5)}
            className="rounded border border-outline-variant/40 px-4 py-2 text-sm text-on-surface-variant disabled:opacity-50"
          >
            Back
          </button>
          <button
            type="submit"
            disabled={!isStepValid(step, form) || busy || (step === 5 && !wallet?.address)}
            className="inline-flex items-center gap-2 rounded bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && (
              <span className="material-symbols-outlined animate-spin text-[16px]" aria-hidden>
                progress_activity
              </span>
            )}
            {busy ? 'Publishing…' : step < 5 ? 'Next →' : 'Publish to marketplace'}
          </button>
        </div>
      </form>

      <p className="text-center text-xs text-on-surface-variant">
        Tip: ⌘/Ctrl + Enter to advance.
      </p>
    </div>
  );
}


// ─── Steps ───────────────────────────────────────────────────────────────

function Step1({
  form,
  update,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  return (
    <>
      <Field label="Title" hint="3..120 chars">
        <input
          value={form.title}
          onChange={(e) => update('title', e.target.value)}
          maxLength={120}
          placeholder="Marketing competitor researcher"
          className="w-full rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-on-surface focus:border-primary/60 focus:outline-none"
          required
        />
      </Field>
      <Field label="Short description" hint="10..240 chars · shown on the listing card">
        <textarea
          value={form.short_description}
          onChange={(e) => update('short_description', e.target.value)}
          maxLength={240}
          rows={2}
          placeholder="Researches competitors and outputs a one-page brief with positioning, pricing, and content gaps."
          className="w-full resize-none rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-on-surface focus:border-primary/60 focus:outline-none"
          required
        />
      </Field>
      <Field label="Domain">
        <select
          value={form.domain}
          onChange={(e) => update('domain', e.target.value as DomainId)}
          className="w-full rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-on-surface"
        >
          {DOMAINS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Tags" hint="comma-separated, optional · ≤10">
        <input
          value={form.tags}
          onChange={(e) => update('tags', e.target.value)}
          placeholder="seo, b2b, saas"
          className="w-full rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-on-surface focus:border-primary/60 focus:outline-none"
        />
      </Field>
    </>
  );
}

function Step2({
  profile,
  patch,
}: {
  profile: SellerProfile;
  patch: (p: Partial<SellerProfile>) => void;
}) {
  return (
    <>
      <p className="text-xs text-on-surface-variant">
        Your seller profile rolls up across every agent you spawn — earnings, KYA, payouts, support.
        One profile, many agents.
      </p>
      <Field label="Display name" hint="2+ chars · public on every listing">
        <input
          value={profile.display_name}
          onChange={(e) => patch({ display_name: e.target.value })}
          placeholder="Acme Marketing Co · or your handle"
          className="w-full rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-on-surface focus:border-primary/60 focus:outline-none"
          required
        />
      </Field>
      <Field label="Bio" hint="optional · ≤500 chars">
        <textarea
          value={profile.bio}
          onChange={(e) => patch({ bio: e.target.value })}
          maxLength={500}
          rows={2}
          className="w-full resize-none rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-on-surface focus:border-primary/60 focus:outline-none"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Identity handle" hint="GitHub / Twitter / ENS">
          <input
            value={profile.identity_handle}
            onChange={(e) => patch({ identity_handle: e.target.value })}
            placeholder="@yourhandle"
            className="w-full rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-on-surface focus:border-primary/60 focus:outline-none"
          />
        </Field>
        <Field label="Contact email" hint="for fiat payout (Day-60+)">
          <input
            type="email"
            value={profile.contact_email}
            onChange={(e) => patch({ contact_email: e.target.value })}
            className="w-full rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-on-surface focus:border-primary/60 focus:outline-none"
          />
        </Field>
      </div>
      <Field label="Support URL" hint="optional · linked from every listing">
        <input
          value={profile.support_url}
          onChange={(e) => patch({ support_url: e.target.value })}
          placeholder="https://example.com/support"
          className="w-full rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-on-surface focus:border-primary/60 focus:outline-none"
        />
      </Field>
    </>
  );
}

function Step3({
  tier,
  reason,
  override,
  setOverride,
}: {
  tier: 'standard';
  reason: string;
  override: PrivacyMode | undefined;
  setOverride: (m: PrivacyMode | undefined) => void;
}) {
  const tierLabel = 'Standard (Fhenix CoFHE)';
  return (
    <>
      <div className="rounded border border-[#00dbe9]/40 bg-[color-mix(in_oklab,_#00dbe9_5%,_transparent)] p-3">
        <p className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
          Auto-detected privacy posture
        </p>
        <p className="mt-1 text-sm font-semibold text-on-surface">{tierLabel}</p>
        <p className="mt-0.5 font-mono text-[11px] text-on-surface-variant">{reason}</p>
      </div>
      <details className="rounded border border-outline-variant/30 bg-surface-container-low p-3">
        <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
          Override (advanced)
        </summary>
        <div className="mt-2 space-y-1 text-sm text-on-surface">
          {([
            ['fhe', 'Standard — Fhenix CoFHE on Arbitrum'],
          ] as Array<[PrivacyMode, string]>).map(([mode, label]) => (
            <label key={mode} className="flex items-center gap-2">
              <input
                type="radio"
                name="privacy-override"
                checked={override === mode}
                onChange={() => setOverride(mode)}
              />
              {label}
            </label>
          ))}
          <button
            type="button"
            onClick={() => setOverride(undefined)}
            className="font-mono text-[11px] text-on-surface-variant underline"
          >
            clear override
          </button>
        </div>
      </details>
    </>
  );
}

function Step4({
  kind,
  setKind,
  form,
  update,
}: {
  kind: KindId;
  setKind: (k: KindId) => void;
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  return (
    <>
      <p className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
        Listing kind
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {KINDS.map((k) => {
          const active = kind === k.id;
          return (
            <button
              key={k.id}
              type="button"
              onClick={() => setKind(k.id)}
              aria-pressed={active}
              className={`rounded border p-3 text-left transition ${
                active
                  ? 'border-[#00dbe9] bg-[color-mix(in_oklab,_#00dbe9_5%,_transparent)]'
                  : 'border-outline-variant/30 bg-surface-container-low hover:border-outline-variant/60'
              }`}
            >
              <div className="text-sm font-semibold text-on-surface">{k.label}</div>
              <div className="mt-0.5 text-xs text-on-surface-variant">{k.desc}</div>
            </button>
          );
        })}
      </div>

      {kind === 'api' && (
        <>
          <Field
            label="System prompt"
            hint="What this agent does, in 1–3 sentences. Buyers + concierge see this."
          >
            <textarea
              value={form.persona_system_prompt}
              onChange={(e) => update('persona_system_prompt', e.target.value)}
              rows={5}
              placeholder="You are a senior B2B SaaS analyst. Given a competitor URL, output a one-page brief with positioning, pricing, and content-gap analysis."
              className="w-full resize-none rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 font-mono text-sm text-on-surface focus:border-primary/60 focus:outline-none"
              required
            />
          </Field>
          <Field
            label="Tools"
            hint="comma-separated · what the agent can call (e.g. web_search, fetch_url)"
          >
            <input
              value={form.persona_tools}
              onChange={(e) => update('persona_tools', e.target.value)}
              placeholder="web_search, fetch_url"
              className="w-full rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-on-surface focus:border-primary/60 focus:outline-none"
            />
          </Field>
        </>
      )}

      {kind === 'workflow' && (
        <WorkflowComposer
          value={form.workflow_draft}
          onChange={(d) => update('workflow_draft', d)}
        />
      )}

      {kind === 'skill' && (
        <SkillComposer
          value={form.skill_draft}
          onChange={(d) => update('skill_draft', d)}
        />
      )}
    </>
  );
}

function Step5({
  form,
  update,
  toggleRail,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  toggleRail: (r: RailId) => void;
}) {
  // For workflow/skill kinds, pricing came from the composer; show it as
  // read-only here. API kind keeps the editable pricing input.
  const fromComposer =
    form.kind === 'workflow'
      ? form.workflow_draft?.default_price_usdc
      : form.kind === 'skill'
        ? form.skill_draft?.price_usdc
        : null;

  return (
    <>
      {fromComposer ? (
        <div className="rounded border border-outline-variant/30 bg-surface-container-low p-3 text-sm">
          <p className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
            Listed price (from composer)
          </p>
          <p className="mt-1 font-mono text-base text-[#13ff43]">${fromComposer} USDC</p>
        </div>
      ) : (
        <Field label="Price per call" hint="USDC, 0..1000">
          <input
            type="number"
            step="0.01"
            min="0.001"
            max="1000"
            value={form.pricing_amount_usdc}
            onChange={(e) => update('pricing_amount_usdc', e.target.value)}
            className="w-full rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 font-mono text-on-surface focus:border-primary/60 focus:outline-none"
            required
          />
        </Field>
      )}
      <Field label="Payment rails" hint="At least one">
        <div className="space-y-1.5">
          {RAILS.map((r) => (
            <label key={r.id} className="flex items-center gap-2 text-sm text-on-surface">
              <input
                type="checkbox"
                checked={form.pricing_rails.includes(r.id)}
                onChange={() => toggleRail(r.id)}
              />
              {r.label}
            </label>
          ))}
        </div>
      </Field>
      <details className="rounded border border-outline-variant/30 bg-surface-container-low px-3 py-2">
        <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
          Advanced
        </summary>
        <label className="mt-2 flex items-start gap-2 text-sm text-on-surface">
          <input
            type="checkbox"
            checked={form.accept_private_payment}
            onChange={(e) => update('accept_private_payment', e.target.checked)}
            className="mt-1"
          />
          <span>
            Accept <strong>confidential payment</strong> (Fhenix FHE) — buyers pay with an
            FHE-encrypted USDC amount via{' '}
            <code className="font-mono text-xs">WrappedStablecoin.encryptedTransfer</code>.
          </span>
        </label>
      </details>
    </>
  );
}


// ─── Success card ────────────────────────────────────────────────────────

/**
 * OnchainBadge — PRD-19. Polls /v3/marketplace/seller/agent/:id/onchain-status
 * every 5s after a successful publish. Hidden when the seller-publish flow
 * didn't enqueue an op (gasless flag off or non-EVM chain) so non-EVM
 * sellers don't see a perpetual ⏳.
 */
function OnchainBadge({ agentId }: { agentId: string }) {
  const [state, setState] = useState<{
    state: 'none' | 'pending' | 'claimed' | 'confirmed' | 'failed';
    tx_hash: string | null;
    on_chain_brain_id: number | null;
  } | null>(null);

  // Poll every 5s until terminal (confirmed/failed/none); stop on unmount.
  useEffectPoll(
    async () => {
      try {
        const r = await fetch(`${AGENT_BACKEND_URL}/v3/marketplace/seller/agent/${agentId}/onchain-status`);
        if (!r.ok) return;
        const j = (await r.json()) as {
          state: 'none' | 'pending' | 'claimed' | 'confirmed' | 'failed';
          tx_hash: string | null;
          on_chain_brain_id: number | null;
        };
        setState(j);
        return j.state === 'confirmed' || j.state === 'failed' || j.state === 'none';
      } catch {
        return false;
      }
    },
    5_000,
    [agentId],
  );

  if (!state || state.state === 'none') return null;

  if (state.state === 'confirmed' && state.tx_hash) {
    const explorer = `https://sepolia.arbiscan.io/tx/${state.tx_hash}`;
    return (
      <p className="mt-3 flex items-center gap-2 text-xs text-secondary">
        <span className="material-symbols-outlined text-[14px]" aria-hidden>
          verified
        </span>
        <span>
          Live on-chain · brain #{state.on_chain_brain_id} ·{' '}
          <a href={explorer} target="_blank" rel="noreferrer" className="underline">
            view on Arbiscan
          </a>
        </span>
      </p>
    );
  }

  if (state.state === 'failed') {
    return (
      <p className="mt-3 flex items-center gap-2 text-xs text-amber-500">
        <span className="material-symbols-outlined text-[14px]" aria-hidden>
          schedule
        </span>
        <span>On-chain registration deferred — we&rsquo;ll retry. Listing is live off-chain.</span>
      </p>
    );
  }

  return (
    <p className="mt-3 flex items-center gap-2 text-xs text-on-surface-variant">
      <span className="material-symbols-outlined animate-spin text-[14px]" aria-hidden>
        progress_activity
      </span>
      <span>Live on-chain in ~30s…</span>
    </p>
  );
}

/**
 * Tiny effect-poll helper, inlined to avoid a new file. SRP: poll a fn
 * until it returns true, then stop. Cleans up on unmount.
 */
function useEffectPoll(
  fn: () => Promise<boolean | void>,
  intervalMs: number,
  deps: React.DependencyList,
): void {
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      const done = await fn();
      if (done === true) return;
      if (!stop) setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function SuccessCard({
  result,
  onSpawnAnother,
  returnPath,
}: {
  result: PublishResult;
  onSpawnAnother: () => void;
  returnPath: string | null;
}) {
  const tierIsTrustless = false;
  return (
    <div className="mx-auto max-w-2xl space-y-6 py-8 md:py-12">
      <div className="rounded-xl border border-secondary/40 bg-secondary/5 p-6">
        <div className="mb-2 flex items-center gap-2 text-secondary">
          <span className="material-symbols-outlined" aria-hidden>
            check_circle
          </span>
          <span className="font-headline text-lg font-bold">Live on the marketplace</span>
        </div>
        <p className="text-sm text-on-surface-variant">
          Your <span className="font-mono">{result.kind}</span> listing{' '}
          <span className="font-mono text-primary">{result.slug}</span> is published. Privacy:{' '}
          <span className="font-mono">
            {result.privacy_mode} ({result.privacy_source})
          </span>
          .
        </p>
        <OnchainBadge agentId={result.agent_id} />
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href={
              result.kind === 'workflow'
                ? `/marketplace/workflow/${result.slug}`
                : `/agent/${result.brain_id}`
            }
            className="inline-flex items-center gap-1 rounded bg-primary px-4 py-2 text-sm text-on-primary"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden>
              arrow_forward
            </span>
            View listing
          </Link>
          {result.knowledge_url && (
            <Link
              href={result.knowledge_url}
              className="inline-flex items-center gap-1 rounded border border-outline-variant/40 px-4 py-2 text-sm text-on-surface"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden>
                {tierIsTrustless ? 'cloud' : 'enhanced_encryption'}
              </span>
              Add knowledge
            </Link>
          )}
          <button
            type="button"
            onClick={onSpawnAnother}
            className="inline-flex items-center gap-1 rounded border border-[#00dbe9] px-4 py-2 text-sm text-[#00dbe9]"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden>
              add
            </span>
            Spawn another agent
          </button>
          <Link
            href={returnPath ?? '/dashboard'}
            className="inline-flex items-center gap-1 rounded border border-outline-variant/40 px-4 py-2 text-sm text-on-surface-variant"
          >
            {returnPath ? `Back to ${returnPath}` : 'Go to dashboard'}
          </Link>
        </div>
      </div>

      <div className="rounded-xl border border-outline-variant/30 bg-surface p-5">
        <h3 className="mb-2 font-mono text-xs uppercase tracking-wider text-on-surface-variant">
          MCP invoke snippet
        </h3>
        <pre className="overflow-x-auto rounded bg-surface-container-low p-3 font-mono text-xs leading-relaxed text-on-surface">
          {result.mcp_invoke_snippet}
        </pre>
      </div>
    </div>
  );
}

// ─── Atoms ───────────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-on-surface">{label}</span>
        {hint && <span className="font-mono text-[11px] text-on-surface-variant">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
