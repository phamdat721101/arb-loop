'use client';

/**
 * PublishWizard — 3-step flow that turns a brain into a paid public API.
 *
 * Steps drive off `?step=` URL param so refresh/back-navigation are honest.
 *   1. Pick brain
 *   2. Configure (slug + price + network + method + pay_to + private toggle)
 *   3. Preview & ship — calls /v3/agents create + publish; surfaces the URL.
 *
 * SOLID:
 *   - SRP: this component owns wizard *flow*. Each step is a pure render
 *     function returning a panel — no global store.
 *   - DIP: agent create + publish go through callers passed in via props,
 *     so the wizard is testable without a backend (see `PublishWizard`
 *     props).
 *
 * Single file by deliberate choice — three small steps + a faucet banner
 * is < 350 LOC; splitting into 4 files adds friction without modularity.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AGENT_BACKEND_URL } from '@/lib/contracts';
import { CIRCLE_FAUCET_URL, isValidEvmOrSuiAddress } from '@/lib/networks';
import { useUsdcBalance } from '@/hooks/useUsdcBalance';

interface BrainSummary {
  id: number;
  title: string;
  description?: string;
  tags?: string[];
  published?: boolean;
}

interface WizardConfig {
  brainId: number;
  slug: string;
  priceUsdc: string;     // decimal string e.g. "0.01"
  network: 'arbitrum-sepolia';
  method: 'exact' | 'fherc20';
  acceptPrivate: boolean;
  payTo: `0x${string}`;
  /** Seller-authored system prompt for the brain's API consumers (PRD-1).
   *  Empty = use the auto-generated default on the public detail page. */
  agentPrompt: string;
}

interface WizardProps {
  brains: BrainSummary[];
  defaultPayTo: `0x${string}`;
  /** Returns the new agent's id on success. */
  onPublish: (cfg: WizardConfig) => Promise<{ agentId: string; slug: string } | { error: string }>;
}

// ─── helpers ───────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9-]{3,30}$/;

// Human-friendly chain labels. Single source of truth for any UI that
// renders the wizard's selected `network` value (price hint, receipt
// page, etc.). Adding a rail = one entry; no other UI needs editing.
const NETWORK_LABEL: Record<WizardConfig['network'], string> = {
  'arbitrum-sepolia': 'Arbitrum Sepolia',
};

async function checkSlugAvailable(slug: string, walletAddress?: string): Promise<{ available: boolean; reason?: string }> {
  try {
    const r = await fetch(`${AGENT_BACKEND_URL}/v3/agents/slug-available?slug=${encodeURIComponent(slug)}`, {
      headers: walletAddress ? { 'x-wallet-address': walletAddress } : {},
    });
    if (!r.ok) return { available: false, reason: 'network' };
    return r.json();
  } catch {
    return { available: false, reason: 'network' };
  }
}

// ─── faucet banner (inline — used only here) ───────────────────────────────

function UsdcFaucetBanner({
  address,
  network,
}: {
  address: `0x${string}` | undefined;
  network: WizardConfig['network'];
}) {
  const { display, isLow, loading } = useUsdcBalance(address);
  // Banner is EVM-only (Circle USDC + the Circle faucet are Arbitrum-native).
  if (network !== 'arbitrum-sepolia') return null;
  if (loading || !isLow) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-3 rounded-lg border border-tertiary/30 bg-tertiary/10 p-3 text-sm"
    >
      <span className="material-symbols-outlined text-[18px] text-tertiary">water_drop</span>
      <div className="flex-1">
        <p className="font-medium">You'll need test USDC to receive payments.</p>
        <p className="mt-0.5 text-xs text-on-surface-variant">
          Current balance: <span className="font-mono">${display}</span> on Arbitrum Sepolia.
        </p>
      </div>
      <a
        href={`${CIRCLE_FAUCET_URL}?network=arbitrum-sepolia${address ? `&address=${address}` : ''}`}
        target="_blank"
        rel="noreferrer"
        className="rounded-full bg-tertiary px-3 py-1 text-xs font-medium text-on-tertiary hover:opacity-90"
      >
        Get test USDC →
      </a>
    </div>
  );
}

// ─── main component ────────────────────────────────────────────────────────

type Step = 1 | 2 | 3;

export function PublishWizard({ brains, defaultPayTo, onPublish }: WizardProps) {
  const router = useRouter();
  const params = useSearchParams();
  const stepRaw = Number(params?.get('step') ?? '1') as Step;
  const step: Step = stepRaw >= 1 && stepRaw <= 3 ? stepRaw : 1;
  const initialBrainId = Number(params?.get('brainId') ?? '0');

  const [brainId, setBrainId] = useState<number>(initialBrainId || brains[0]?.id || 0);
  const [slug, setSlug] = useState('');
  const [priceUsdc, setPriceUsdc] = useState('0.01');
  // Payment network — Arbitrum Sepolia by default. SOLID: one swap-point
  // for adding additional EVM rails (Base / Optimism) in v0.1+.
  const [network, setNetwork] = useState<WizardConfig['network']>('arbitrum-sepolia');
  const [acceptPrivate, setAcceptPrivate] = useState(false);
  const [payTo, setPayTo] = useState<string>(defaultPayTo);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [slugStatus, setSlugStatus] = useState<{ available: boolean; reason?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [shipped, setShipped] = useState<{ agentId: string; slug: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // URL ↔ state sync (one-way: state → URL).
  function go(next: Step, extra?: Record<string, string>) {
    const sp = new URLSearchParams();
    sp.set('step', String(next));
    if (brainId) sp.set('brainId', String(brainId));
    Object.entries(extra ?? {}).forEach(([k, v]) => sp.set(k, v));
    router.push(`/studio/publish?${sp.toString()}`);
  }

  // Slug availability check — debounced.
  useEffect(() => {
    if (!slug || step !== 2) return;
    if (!SLUG_RE.test(slug)) {
      setSlugStatus({ available: false, reason: 'invalid' });
      return;
    }
    const t = setTimeout(async () => setSlugStatus(await checkSlugAvailable(slug, defaultPayTo)), 300);
    return () => clearTimeout(t);
  }, [slug, step]);

  const selectedBrain = useMemo(() => brains.find((b) => b.id === brainId), [brains, brainId]);
  const canShip = !!selectedBrain && SLUG_RE.test(slug) && slugStatus?.available && Number(priceUsdc) > 0 && isValidEvmOrSuiAddress(payTo);

  async function handleShip() {
    if (!canShip || !selectedBrain) return;
    setBusy(true);
    setError(null);
    const cfg: WizardConfig = {
      brainId: selectedBrain.id,
      slug,
      priceUsdc,
      network,
      method: 'exact',
      acceptPrivate,
      payTo: payTo as `0x${string}`,
      agentPrompt,
    };
    const r = await onPublish(cfg);
    setBusy(false);
    if ('error' in r) {
      setError(r.error);
      return;
    }
    setShipped(r);
  }

  // ─── render branches ────────────────────────────────────────────────

  if (shipped) return <Shipped result={shipped} />;

  return (
    <div className="space-y-6">
      <Header step={step} />

      {step === 1 && (
        <Step1
          brains={brains}
          brainId={brainId}
          onPick={(id) => {
            setBrainId(id);
            go(2, { brainId: String(id) });
          }}
        />
      )}

      {step === 2 && selectedBrain && (
        <Step2
          brain={selectedBrain}
          slug={slug}
          slugStatus={slugStatus}
          priceUsdc={priceUsdc}
          payTo={payTo}
          network={network}
          acceptPrivate={acceptPrivate}
          agentPrompt={agentPrompt}
          onSlug={setSlug}
          onPrice={setPriceUsdc}
          onPayTo={setPayTo}
          onNetwork={setNetwork}
          onAcceptPrivate={setAcceptPrivate}
          onAgentPrompt={setAgentPrompt}
          onBack={() => go(1)}
          onNext={() => go(3)}
          ownerAddress={defaultPayTo}
        />
      )}

      {step === 3 && selectedBrain && (
        <Step3
          brain={selectedBrain}
          cfg={{
            brainId: selectedBrain.id,
            slug,
            priceUsdc,
            network,
            method: 'exact',
            acceptPrivate,
            payTo: payTo as `0x${string}`,
            agentPrompt,
          }}
          canShip={!!canShip}
          busy={busy}
          error={error}
          onBack={() => go(2)}
          onShip={handleShip}
        />
      )}
    </div>
  );
}

// ─── sub-renders (kept inline; each < 60 LOC) ─────────────────────────────

function Header({ step }: { step: Step }) {
  return (
    <div className="space-y-2">
      <Link
        href="/studio"
        className="inline-flex items-center gap-1 text-xs text-on-surface-variant hover:text-primary"
      >
        <span className="material-symbols-outlined text-[14px]">arrow_back</span> Studio
      </Link>
      <h1 className="font-headline text-3xl font-bold">Publish a paid API</h1>
      <p className="text-on-surface-variant">
        Turn your brain into an x402-paywalled HTTP endpoint AI agents can call.
      </p>
      <div className="flex items-center gap-2 pt-1">
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className={`h-1.5 w-12 rounded-full ${n <= step ? 'bg-primary' : 'bg-outline-variant/40'}`}
            aria-label={`Step ${n}${n === step ? ' (current)' : ''}`}
          />
        ))}
      </div>
    </div>
  );
}

function Step1({
  brains,
  brainId,
  onPick,
}: {
  brains: BrainSummary[];
  brainId: number;
  onPick: (id: number) => void;
}) {
  if (brains.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-outline-variant/40 bg-surface-container-low p-10 text-center">
        <p className="text-on-surface-variant">No brains yet — create one first.</p>
        <Link href="/brain" className="mt-3 inline-block text-sm text-primary hover:underline">
          Go to /brain →
        </Link>
      </div>
    );
  }
  return (
    <section className="space-y-3">
      <h2 className="font-headline text-lg font-semibold">1. Pick a brain</h2>
      <ul className="grid gap-2 md:grid-cols-2">
        {brains.map((b) => {
          const active = b.id === brainId;
          return (
            <li key={b.id}>
              <button
                onClick={() => onPick(b.id)}
                className={`w-full rounded-xl border p-4 text-left transition-colors ${
                  active
                    ? 'border-primary bg-primary/5'
                    : 'border-outline-variant/30 bg-surface hover:border-primary/40'
                }`}
              >
                <div className="font-headline font-semibold">{b.title}</div>
                <div className="mt-1 line-clamp-2 text-xs text-on-surface-variant">
                  {b.description || 'No description'}
                </div>
                {b.tags && b.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {b.tags.slice(0, 3).map((t) => (
                      <span key={t} className="rounded-full bg-surface-container-high px-2 py-0.5 font-mono text-[10px]">
                        #{t}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Step2(props: {
  brain: BrainSummary;
  slug: string;
  slugStatus: { available: boolean; reason?: string } | null;
  priceUsdc: string;
  payTo: string;
  network: WizardConfig['network'];
  acceptPrivate: boolean;
  agentPrompt: string;
  ownerAddress: `0x${string}`;
  onSlug: (s: string) => void;
  onPrice: (s: string) => void;
  onPayTo: (s: string) => void;
  onNetwork: (n: WizardConfig['network']) => void;
  onAcceptPrivate: (b: boolean) => void;
  onAgentPrompt: (s: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const slugMsg =
    !props.slug ? 'Lowercase letters, numbers, hyphens. 3–30 chars.'
      : !SLUG_RE.test(props.slug) ? 'Invalid format.'
      : props.slugStatus == null ? 'Checking…'
      : props.slugStatus.available ? '✓ Available'
      : props.slugStatus.reason === 'taken' ? 'Already taken'
      : props.slugStatus.reason === 'reserved' ? 'Reserved name'
      : 'Try another';
  const slugOk = props.slugStatus?.available === true;
  const priceOk = Number(props.priceUsdc) > 0 && Number(props.priceUsdc) <= 100;
  const payToOk = isValidEvmOrSuiAddress(props.payTo);
  const canNext = slugOk && priceOk && payToOk;

  return (
    <section className="space-y-5">
      <h2 className="font-headline text-lg font-semibold">2. Configure your API</h2>
      <UsdcFaucetBanner address={props.ownerAddress} network={props.network} />

      <Field label="Slug" hint={slugMsg} hintTone={slugOk ? 'ok' : props.slug && !SLUG_RE.test(props.slug) ? 'err' : 'muted'}>
        <input
          value={props.slug}
          onChange={(e) => props.onSlug(e.target.value.toLowerCase())}
          placeholder="legal-research"
          className="w-full rounded-full border border-outline-variant/40 bg-surface-container-low px-4 py-2.5 font-mono text-sm focus:border-primary/60 focus:outline-none"
          aria-invalid={!slugOk && !!props.slug}
        />
      </Field>

      <Field label="Price per call (USDC)" hint={priceOk ? '✓' : 'Enter 0 < price ≤ 100'} hintTone={priceOk ? 'ok' : 'err'}>
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-on-surface-variant">$</span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={props.priceUsdc}
            onChange={(e) => props.onPrice(e.target.value)}
            className="w-32 rounded-full border border-outline-variant/40 bg-surface-container-low px-4 py-2.5 font-mono text-sm focus:border-primary/60 focus:outline-none"
          />
          <span className="text-xs text-on-surface-variant">
            USDC · {NETWORK_LABEL[props.network]}
          </span>
        </div>
      </Field>

      <Field label="Method" hint="x402 (HTTP 402 + USDC). MPP coming soon.">
        <div className="flex gap-2">
          <span className="rounded-full bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary">exact (x402)</span>
          <span className="rounded-full border border-outline-variant/30 bg-surface-container-low px-3 py-1.5 font-mono text-xs text-on-surface-variant/60">
            tempo (MPP) · soon
          </span>
        </div>
      </Field>

      <Field label="Settlement network" hint="Where buyers' USDC payments settle for this API.">
        <select
          value={props.network}
          onChange={(e) => props.onNetwork(e.target.value as WizardConfig['network'])}
          className="w-full rounded-full border border-outline-variant/40 bg-surface-container-low px-4 py-2.5 text-sm focus:border-primary/60 focus:outline-none"
        >
          <option value="arbitrum-sepolia">Arbitrum Sepolia (USDC, x402)</option>
        </select>
      </Field>

      <Field label="Pay-to address" hint={payToOk ? '✓' : 'Must be a valid EVM 0x address (40 hex chars)'} hintTone={payToOk ? 'ok' : 'err'}>
        <input
          value={props.payTo}
          onChange={(e) => props.onPayTo(e.target.value)}
          className="w-full rounded-full border border-outline-variant/40 bg-surface-container-low px-4 py-2.5 font-mono text-xs focus:border-primary/60 focus:outline-none"
        />
      </Field>

      <Field label="Confidential payments (FHERC20)" hint="Buyer's amount stays encrypted on-chain. Same price; ~30 s settle.">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={props.acceptPrivate}
            onChange={(e) => props.onAcceptPrivate(e.target.checked)}
            className="h-4 w-4"
          />
          <span className="text-sm">Accept confidential-amount payments</span>
        </label>
      </Field>

      <Field
        label="Agent prompt (optional)"
        hint="What should AI buyers know about how to use this brain? Empty = use a derived default on the public page."
      >
        <textarea
          value={props.agentPrompt}
          onChange={(e) => props.onAgentPrompt(e.target.value)}
          rows={5}
          maxLength={4000}
          placeholder={`You answer questions about "${props.brain.title}". Reply concisely; cite the brain when its knowledge is used.`}
          className="w-full rounded-2xl border border-outline-variant/40 bg-surface-container-low px-4 py-2.5 font-mono text-xs leading-relaxed focus:border-primary/60 focus:outline-none"
        />
      </Field>

      <div className="flex justify-between">
        <button onClick={props.onBack} className="rounded-full border border-outline-variant/40 px-5 py-2 text-sm">
          ← Back
        </button>
        <button
          disabled={!canNext}
          onClick={props.onNext}
          className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
        >
          Continue →
        </button>
      </div>
    </section>
  );
}

function Step3({
  brain,
  cfg,
  canShip,
  busy,
  error,
  onBack,
  onShip,
}: {
  brain: BrainSummary;
  cfg: WizardConfig;
  canShip: boolean;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onShip: () => void;
}) {
  const apiBase = process.env.NEXT_PUBLIC_AGENT_BACKEND_URL ?? 'http://localhost:3001';
  const url = `${apiBase}/api/v1/${cfg.slug}`;
  const cardJson = {
    name: cfg.slug,
    description: brain.title,
    url,
    payTo: cfg.payTo,
    chain: cfg.network,
    tools: [{ name: 'ask', price: Math.round(Number(cfg.priceUsdc) * 1_000_000), currency: 'USDC' }],
  };
  const curl = `curl -i ${url}`;
  return (
    <section className="space-y-4">
      <h2 className="font-headline text-lg font-semibold">3. Preview & ship</h2>

      <div className="space-y-2 rounded-xl border border-outline-variant/30 bg-surface p-4">
        <div className="text-xs uppercase tracking-wider text-on-surface-variant">Public URL</div>
        <code className="block break-all font-mono text-sm">{url}</code>
      </div>

      <div className="space-y-2 rounded-xl border border-outline-variant/30 bg-surface p-4">
        <div className="text-xs uppercase tracking-wider text-on-surface-variant">agent.json</div>
        <pre className="overflow-x-auto text-xs"><code>{JSON.stringify(cardJson, null, 2)}</code></pre>
      </div>

      <div className="space-y-2 rounded-xl border border-outline-variant/30 bg-surface p-4">
        <div className="text-xs uppercase tracking-wider text-on-surface-variant">Test it (returns 402)</div>
        <code className="block font-mono text-sm">{curl}</code>
      </div>

      {error && (
        <div className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </div>
      )}

      <div className="flex justify-between">
        <button onClick={onBack} className="rounded-full border border-outline-variant/40 px-5 py-2 text-sm">
          ← Back
        </button>
        <button
          disabled={!canShip || busy}
          onClick={onShip}
          className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
        >
          {busy ? 'Publishing…' : 'Publish API'}
        </button>
      </div>
    </section>
  );
}

function Shipped({ result }: { result: { agentId: string; slug: string } }) {
  const url = `${process.env.NEXT_PUBLIC_AGENT_BACKEND_URL ?? 'http://localhost:3001'}/api/v1/${result.slug}`;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-secondary/30 bg-secondary/10 p-6">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-secondary">check_circle</span>
          <h2 className="font-headline text-lg font-semibold">Live on the marketplace</h2>
        </div>
        <p className="mt-2 break-all font-mono text-sm">{url}</p>
      </div>
      <div className="flex gap-2">
        <Link href={`/studio/${result.agentId}`} className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary">
          Manage
        </Link>
        <Link href="/marketplace" className="rounded-full border border-outline-variant/40 px-5 py-2 text-sm">
          See on marketplace
        </Link>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  hintTone = 'muted',
  children,
}: {
  label: string;
  hint?: string;
  hintTone?: 'muted' | 'ok' | 'err';
  children: React.ReactNode;
}) {
  const hintColor = hintTone === 'ok' ? 'text-secondary' : hintTone === 'err' ? 'text-error' : 'text-on-surface-variant';
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p className={`text-xs ${hintColor}`}>{hint}</p>}
    </div>
  );
}
