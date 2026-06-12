'use client';

/**
 * /docs — agent-onboarding console.
 *
 * One canonical copy-paste prompt that any MCP-aware host (Claude Desktop,
 * Cursor, Codex, Bedrock AgentCore) can run to publish a marketplace listing
 * on the seller's behalf via the shipped /v3/marketplace/seller/publish
 * endpoint.
 *
 * PRD-18: when the seller is logged in, the page mints a *scoped, single-use*
 * Fhenix onboard permit and bakes it into the prompt as the
 * `x-fhenix-permit` header value. The agent has zero placeholders to fill —
 * one click to generate, one click to copy, one paste to publish.
 *
 * SOLID:
 *   - SRP: this file owns docs rendering. The permit mint is a thin local
 *          adapter around the SDK's `mintOnboardPermit` — no new hook.
 *   - OCP: adding a host = one HostTab entry; adding a step = one Section.
 *   - DIP: the SDK function takes a viem WalletClient; we build it from the
 *          Privy provider exactly the same way `usePayments` does. Single
 *          source of truth for the wallet-client recipe stays in viem.
 *
 * The manual wizard at /seller/onboard is preserved unchanged and linked
 * from Section D as a fallback.
 */

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { usePrivyEvmAddress, usePrivyEvmWallet } from '@/hooks/useActiveWallet';
import { createWalletClient, custom } from 'viem';
import { arbitrumSepolia as viemArbitrumSepolia } from 'viem/chains';
import {
  arbitrumSepolia,
  mintOnboardPermit,
  type OnboardPermit,
} from '@fhe-ai-context/sdk';
import { ARBITRUM_SEPOLIA_CHAIN_ID } from '@/lib/networks';
import { BRAIN_KEY_VAULT_ADDRESS, AGENT_BACKEND_URL } from '@/lib/contracts';

// ─── The canonical onboarding prompt ─────────────────────────────────────
//
// `buildPrompt` returns the prompt with placeholders or live values
// substituted. The agent's behaviour is identical either way — only the
// auth section changes shape. Server-side `verifyPermit()` enforces the
// onboard scope and the single-use jti at publish time.

function buildPrompt(args: { wallet?: string; permit?: OnboardPermit | null }): string {
  const wallet = args.wallet ?? '<PASTE_YOUR_WALLET_HERE>';
  const apiBase = AGENT_BACKEND_URL;
  const authBlock = args.permit
    ? `Authentication (DO NOT MODIFY):
  - Header:  x-fhenix-permit: ${args.permit.serialized}
  - Wallet:  ${args.permit.walletAddress}
  - Expires: ${new Date(args.permit.expiresAtSec * 1000).toISOString()}  (single-use, 15 min)`
    : `Authentication (sign in at ${apiBase}/docs to mint a token):
  - Header:  x-fhenix-permit: <PASTE_ONBOARD_TOKEN_HERE>
  - Wallet:  ${wallet}`;

  return `You are helping me publish an AI agent listing on OpenX
(${apiBase}), the AI agent marketplace with cognitive memory.

The OpenX MCP server is connected and exposes (among others):
  • openx_marketplace_search(query, domain?, max?) — free, returns
    LLM-ranked existing listings so we can avoid duplicates and pick a
    price band.
  • openx_seller_publish(listing, onboard_permit) — free, atomic publish.
    Pass the onboard_permit value from the auth block below verbatim.
  • openx_agent_invoke(slug | agent_id, input)    — paid, calls a
    published agent (used after onboarding to verify).

${authBlock}

Your task is to publish ONE new listing on my behalf. Prefer the MCP tool;
fall back to direct HTTP only if the MCP server is unavailable:

  POST ${apiBase}/v3/marketplace/seller/publish
  Headers: { 'content-type': 'application/json',
             'x-fhenix-permit': '<value from the Authentication block>' }

Steps:
  1. Ask me ONE round of clarifying questions if and only if the listing
     topic is ambiguous. Otherwise infer from context.
  2. Call openx_marketplace_search to see adjacent listings in the same
     domain. Pick a price 10–30% above the median for the domain unless
     I specify.
  3. Construct a JSON body matching this exact schema:

     {
       "title": string (3..120 chars),
       "short_description": string (10..240 chars),
       "domain": one of:
         marketing | finance | research | engineering | generalist | other,
       "tags": string[] (≤10),
       "persona_system_prompt": string (≥10 chars),
       "persona_tools": string[] (≤10),
       "pricing_amount_usdc": string (e.g. "0.05"; > 0, ≤ 1000),
       "pricing_rails": (subset of)
                       ["x402","mpp","fherc20"],
       "accept_private_payment": boolean
                       (true → also expose Fhenix \`fherc20\` rail),
       "slug": string (optional, lowercase, [a-z0-9-], 3..40),
       "verification_tier": "basic"
     }

  4. Call openx_seller_publish({ listing, onboard_permit }). SHOW ME the
     listing JSON BEFORE calling so I can approve. Do not modify the
     onboard_permit string.
  5. On success the response will be:
       { agent_id, slug, listing_url, knowledge_url,
         mcp_invoke_snippet, manifest_yaml }
     Print listing_url, knowledge_url, and mcp_invoke_snippet.
     Tell me knowledge upload is OPTIONAL — the persona alone is enough
     and the listing is already callable.
  6. Run openx_agent_invoke({ slug, input: { q: "ping" } }) once to
     confirm the listing is reachable. Expect a -32402 envelope on first
     try (paymentGate enforces 402 before payment); that proves the
     listing is live and gated correctly.

Constraints:
  - Do NOT publish anything I have not approved.
  - Default rails to ["x402"] unless I explicitly ask for more.
  - Default accept_private_payment to false. Ask if I want
    confidential-amount payments via Fhenix.
  - The onboard_permit is single-use. If publish returns 409
    "onboard token already used", ask me to mint a new one at /docs.
  - Never invent the onboard_permit value; treat it as opaque.

My listing topic is:  <PASTE_TOPIC_HERE>
`;
}

// ─── Host configurations ────────────────────────────────────────────────

interface HostConfig {
  id: 'claude' | 'cursor' | 'curl';
  label: string;
  blurb: string;
  config: string;
}

const HOSTS: HostConfig[] = [
  {
    id: 'claude',
    label: 'Claude Desktop',
    blurb:
      'Add this to your Claude Desktop config (Settings → Developer → Edit Config). Quit and relaunch Claude Desktop afterwards so the openx_* tools appear.',
    config: `{
  "mcpServers": {
    "openx": {
      "url": "${AGENT_BACKEND_URL}/mcp"
    }
  }
}`,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    blurb:
      'Cursor reads ~/.cursor/mcp.json. Add the OpenX entry; reload Cursor (⌘⇧P → "Reload Window").',
    config: `{
  "mcpServers": {
    "openx": {
      "url": "${AGENT_BACKEND_URL}/mcp"
    }
  }
}`,
  },
  {
    id: 'curl',
    label: 'Generic / curl',
    blurb:
      "No MCP host? Hit the route directly. The agent's role here is to draft the JSON body; you POST it.",
    config: `# 1. Search adjacent listings (free)
curl -X POST ${AGENT_BACKEND_URL}/v3/discover \\
  -H 'content-type: application/json' \\
  -d '{"message":"<your listing topic>","max_steps":5}'

# 2. Publish (auth via the onboard permit you minted in Section B)
curl -X POST ${AGENT_BACKEND_URL}/v3/marketplace/seller/publish \\
  -H 'content-type: application/json' \\
  -H 'x-fhenix-permit: <ONBOARD_PERMIT>' \\
  -d @listing.json

# 3. Verify the 402 gate (proves listing is live + gated)
curl -X POST ${AGENT_BACKEND_URL}/v3/agents/<agent_id>/chat \\
  -H 'content-type: application/json' \\
  -d '{"message":"ping"}'
# → expect HTTP 402 with x-payment-info envelope`,
  },
];

// ─── Page ───────────────────────────────────────────────────────────────

export default function DocsPage() {
  const { authenticated, ready, login } = usePrivy();
  const userAddress = usePrivyEvmAddress();
  const evmWallet = usePrivyEvmWallet();

  const [permit, setPermit] = useState<OnboardPermit | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);

  /**
   * Mint a scoped onboard permit via the SDK. Wallet-client recipe matches
   * `usePayments` byte-for-byte (Privy provider → viem custom transport).
   * The SDK uses BRAIN_KEY_VAULT_ADDRESS as the permit recipient (PRD-18 §B
   * fix) — a contract address can never collide with the user's wallet, so
   * the platform-wallet-as-seller case Just Works.
   */
  const generate = useCallback(async () => {
    if (!userAddress || !evmWallet) {
      setMintError('Wallet not connected');
      return;
    }
    setMintError(null);
    setMinting(true);
    try {
      await evmWallet.switchChain(ARBITRUM_SEPOLIA_CHAIN_ID);
      const provider = await evmWallet.getEthereumProvider();
      const walletClient = createWalletClient({
        chain: viemArbitrumSepolia,
        transport: custom(provider),
        account: userAddress,
      });

      const next = await mintOnboardPermit(
        { contractAddress: BRAIN_KEY_VAULT_ADDRESS },
        arbitrumSepolia,
        walletClient,
      );
      setPermit(next);
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setMintError(err?.shortMessage ?? err?.message ?? 'Mint failed');
    } finally {
      setMinting(false);
    }
  }, [userAddress, evmWallet]);

  const promptText = buildPrompt({ wallet: userAddress, permit });
  const expiresInMin = permit ? Math.max(0, Math.round((permit.expiresAtSec * 1000 - Date.now()) / 60000)) : 0;

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      {/* Hero */}
      <header className="space-y-3">
        <span className="matrix-chip inline-block rounded border border-secondary/20 px-2 py-1 font-mono text-[11px] uppercase tracking-wider">
          Agent-driven onboarding · No manual wizard needed
        </span>
        <h1 className="font-headline text-3xl font-bold leading-tight md:text-4xl">
          Onboard to OpenX in one prompt
        </h1>
        <p className="text-on-surface-variant md:text-lg">
          Paste this into Claude Desktop, Cursor, or any MCP-aware host. Your agent searches the
          marketplace for adjacent listings, drafts your persona, picks pricing, and publishes —
          all on your behalf, via the shipped endpoints.
        </p>
      </header>

      {/* PRD-19 — non-crypto sign-in callout (sits above the MCP path so
          first-time visitors see the wallet-free option first). */}
      <div className="rounded-xl border border-secondary/30 bg-secondary/5 p-5">
        <div className="mb-2 flex items-center gap-2 text-secondary">
          <span className="material-symbols-outlined" aria-hidden>
            mail
          </span>
          <span className="font-headline text-base font-bold">No crypto wallet? Use email.</span>
        </div>
        <p className="text-sm text-on-surface-variant">
          Sign in with email or Google — your account is secured automatically and the platform
          covers gas on Arbitrum Sepolia. No seed phrase, no faucet, no network switch.
        </p>
        <Link
          href="/seller/onboard"
          className="mt-3 inline-flex items-center gap-1 rounded bg-secondary px-3 py-1.5 text-xs text-on-secondary"
        >
          <span className="material-symbols-outlined text-[14px]" aria-hidden>
            arrow_forward
          </span>
          Open the wallet-free wizard
        </Link>
      </div>

      <Section
        letter="A"
        title="Connect the OpenX MCP server"
        hint="One-time, ~30 seconds. Pick your host below."
      >
        <HostTabs />
      </Section>

      <Section
        letter="B"
        title="Mint your onboard token"
        hint="One click to generate a scoped, single-use Fhenix permit (15-min TTL). Baked into the prompt below."
      >
        <div className="rounded-xl border border-outline-variant/30 bg-surface-container-low p-5">
          {!ready ? (
            <p className="text-sm text-on-surface-variant">Loading wallet…</p>
          ) : !authenticated ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={login}
                className="inline-flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-opacity hover:opacity-90"
              >
                Sign in to mint
              </button>
              <span className="text-xs text-on-surface-variant">
                Sign-in is required so the permit is bound to your wallet on-chain.
              </span>
            </div>
          ) : permit ? (
            <div className="space-y-2 text-sm">
              <p className="text-on-surface">
                <span className="material-symbols-outlined align-middle text-primary text-[16px]" aria-hidden>
                  check_circle
                </span>{' '}
                Token minted · expires in <strong>{expiresInMin} min</strong> · single-use
              </p>
              <p className="text-xs text-on-surface-variant">
                Wallet: <code className="font-mono">{permit.walletAddress}</code>
              </p>
              <button
                type="button"
                onClick={generate}
                disabled={minting}
                className="text-xs text-primary hover:underline disabled:opacity-50"
              >
                {minting ? 'Re-minting…' : 'Mint a fresh token'}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={generate}
                disabled={minting || !userAddress || !evmWallet}
                className="inline-flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {minting ? 'Minting…' : 'Generate onboard token'}
              </button>
              <span className="text-xs text-on-surface-variant">
                Requires one wallet signature. Token is single-use and expires in 15 min.
              </span>
            </div>
          )}
          {mintError && <p className="mt-3 text-xs text-error">⚠ {mintError}</p>}
        </div>
      </Section>

      <Section
        letter="C"
        title="The onboarding prompt"
        hint={
          permit
            ? 'Live wallet + onboard token are baked in. Copy → paste into your agent → done.'
            : 'Generate a token in Section B to bake live auth into the prompt.'
        }
      >
        <CodeBlock content={promptText} language="text" />
        <p className="mt-3 text-xs text-on-surface-variant">
          What the agent will do, in order: clarify topic → search adjacent listings → propose
          listing fields → request your approval → call{' '}
          <code className="font-mono text-primary">openx_seller_publish</code> with{' '}
          <code className="font-mono text-primary">x-fhenix-permit</code> auth → verify via{' '}
          <code className="font-mono text-primary">openx_agent_invoke</code> → return slug + MCP
          invoke snippet.
        </p>
      </Section>

      <Section
        letter="D"
        title="Verify the listing went live"
        hint="No agent needed for this — just curl."
      >
        <CodeBlock
          content={`curl "${AGENT_BACKEND_URL}/v3/marketplace/listings?domain=<your_domain>&limit=5"`}
          language="bash"
        />
        <p className="mt-3 text-xs text-on-surface-variant">
          The new listing should appear in the response array within a few seconds. The home
          concierge picks it up on the next 60-second corpus refresh.
        </p>
      </Section>

      <Section
        letter="E"
        title="Manual fallback"
        hint="Prefer to fill a form? Same backend, same atomic publish."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/seller/onboard"
            className="inline-flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-opacity hover:opacity-90"
          >
            Open the 3-step wizard
            <span className="material-symbols-outlined text-[16px]" aria-hidden>
              arrow_forward
            </span>
          </Link>
          <span className="text-xs text-on-surface-variant">
            Same validation, same atomic transaction, same{' '}
            <code className="font-mono">manifest_hash</code>. Publishes in 60 seconds without an
            agent.
          </span>
        </div>
      </Section>

      <Section
        letter="F"
        title="Privacy + tier reference"
        hint="Optional context. Skip unless you're attaching encrypted knowledge after publish."
      >
        <div className="space-y-3 rounded-xl border border-outline-variant/30 bg-surface-container-low p-5 text-sm text-on-surface-variant">
          <p>
            <strong className="text-on-surface">Standard tier</strong> — Fhenix on Arbitrum.
            Knowledge is AES-256-GCM-encrypted in your browser; the AES key is wrapped as a
            Fhenix CoFHE <code className="font-mono text-primary">euint128</code> in{' '}
            <code className="font-mono text-primary">BrainKeyVaultV2</code>. The platform is
            cryptographically blind to the plaintext. Add knowledge at{' '}
            <Link href="/brain" className="text-primary hover:underline">
              /brain
            </Link>
            .
          </p>
          <p>
            <strong className="text-on-surface">Confidential payment</strong> — Fhenix{' '}
            <code className="font-mono text-primary">euint64</code> via{' '}
            <code className="font-mono text-primary">WrappedStablecoin.encryptedTransfer</code>.
            Set <code className="font-mono">accept_private_payment: true</code> in the prompt to
            expose the <code className="font-mono">fherc20</code> rail; the platform never sees
            the payment amount.
          </p>
        </div>
      </Section>
    </div>
  );
}

// ─── Sub-components (inline; no new files) ──────────────────────────────

function Section({
  letter,
  title,
  hint,
  children,
}: {
  letter: string;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-3 border-b border-outline-variant/20 pb-2">
        <span className="font-mono text-xs uppercase tracking-wider text-on-surface-variant">
          Section {letter}
        </span>
        <h2 className="font-headline text-lg font-semibold text-on-surface">{title}</h2>
      </div>
      {hint && <p className="text-sm text-on-surface-variant">{hint}</p>}
      {children}
    </section>
  );
}

function HostTabs() {
  const [active, setActive] = useState<HostConfig['id']>('claude');
  const cfg = HOSTS.find((h) => h.id === active) ?? HOSTS[0];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Host configuration">
        {HOSTS.map((h) => (
          <button
            key={h.id}
            type="button"
            role="tab"
            aria-selected={active === h.id}
            onClick={() => setActive(h.id)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              active === h.id
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-outline-variant/40 text-on-surface-variant hover:border-primary/40'
            }`}
          >
            {h.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-on-surface-variant">{cfg.blurb}</p>
      <CodeBlock content={cfg.config} language={cfg.id === 'curl' ? 'bash' : 'json'} />
    </div>
  );
}

function CodeBlock({ content, language }: { content: string; language: 'json' | 'bash' | 'text' }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(content).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-xl border border-outline-variant/30 bg-surface-container-low p-4 font-mono text-[12px] leading-relaxed text-on-surface">
        {content}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${language} block`}
        className="absolute right-3 top-3 inline-flex items-center gap-1 rounded border border-outline-variant/40 bg-surface px-2 py-1 font-mono text-[10px] uppercase text-on-surface-variant transition-colors hover:border-primary/40 hover:text-on-surface"
      >
        <span className="material-symbols-outlined text-[12px]" aria-hidden>
          {copied ? 'check' : 'content_copy'}
        </span>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
