'use client';
/**
 * /arbloop/seller/onboard — v0.0 gasless seller publish.
 *
 * Flow: *   1. 1-question wizard (E9 from pre-mortem): "Does your agent need memory?"
 *      → Yes branch sets tags=[requires_memory], maxIter=5, mode='loop'.
 *      → No branch sets maxIter=1, mode='x402'.
 *   2. Title + description + price + persona prompt.
 *   3. Build manifest YAML inline.
 *   4. Sign EIP-712 PublishAgent typed-data via wallet.
 *   5. POST to /v3/arbloop/agents/publish with seller_signature.
 *   6. Relayer pays gas; on-chain agents[id].seller = recovered signer.
 *
 * SOLID: SRP — one page owns the wizard state machine. Crypto + EIP-712
 * builder come from @fhe-ai-context/sdk.
 */

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BrowserProvider } from 'ethers';
import { usePrivyEvmAddress, usePrivyEvmWallet } from '@/hooks/useActiveWallet';
import {
  buildPublishAgentTypedData,
  freshPublishNonce,
  cidToBytes32,
} from '@fhe-ai-context/sdk';
import { ARBLOOP_API_URL } from '@/lib/arbloop';
import { ARBITRUM_SEPOLIA_CHAIN_ID } from '@/lib/networks';

type Step = 'wizard' | 'fields' | 'review' | 'done';

// Wraps the client form in a Suspense boundary so useSearchParams (used by
// the Studio "Upgrade to loop" deeplink: ?title=&description=&return=) doesn't
// trip Next 14's CSR-bailout prerender check. Same pattern as /arbloop/compose.
export default function SellerOnboard() {
  return (
    <Suspense fallback={<p className="py-12 text-center text-on-surface-variant">Loading…</p>}>
      <SellerOnboardInner />
    </Suspense>
  );
}

function SellerOnboardInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const address = usePrivyEvmAddress();
  const evmWallet = usePrivyEvmWallet();

  const [step, setStep] = useState<Step>('wizard');
  const [needsMemory, setNeedsMemory] = useState<boolean | null>(null);
  const [title, setTitle] = useState(() => searchParams?.get('title') ?? '');
  const [shortDesc, setShortDesc] = useState(() => searchParams?.get('description') ?? '');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [perIter, setPerIter] = useState('1.50');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ agent_id: number; tx_hash: string } | null>(null);

  const maxIter = needsMemory ? 5 : 1;
  const mode: 'x402' | 'loop' = needsMemory ? 'loop' : 'x402';

  function buildManifestYaml(): string {
    const tags = needsMemory ? '[requires_memory]' : '[]';
    const category = needsMemory ? 'research' : 'other';
    // Schema requires description >= 10 chars. Concat shortDesc + system
    // prompt — both surface to the LLM as system context, so this is the
    // natural place for them. JSON.stringify handles quoting + escaping
    // (no need for YAML > 80-char wraps for this minimal manifest).
    const description = ((shortDesc?.trim() ?? '') + '. ' + (systemPrompt?.trim() ?? '')).trim();
    // Namespace must be ≥1 char; use a deterministic per-seller-per-title slug
    // (will be over-stamped by JobMemoryNamespace.{{job_address}} at hire time).
    const slug = (title || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) || 'agent';
    return `kind: loop
spec_version: 1
target_chain: arbitrum-sepolia
title: ${JSON.stringify(title)}
description: ${JSON.stringify(description)}
seller_agent_ref:
  agent_registry: "0x0000000000000000000000000000000000000000"
  agent_id: 0
stop_condition:
  predicate: "iterations >= ${maxIter}"
  fallback_max_iterations: ${maxIter}
iteration:
  inference:
    backend: bedrock
    model_id: us.anthropic.claude-opus-4-6-v1
  memory:
    namespace: ${JSON.stringify(`{{job_address}}/${slug}`)}
    read: []
    write: []
  pricing:
    per_iter_micro_usdc: ${Math.round(parseFloat(perIter) * 1e6)}
    splits:
      - { to: seller, bps: 7000 }
      - { to: compute, bps: 2500 }
      - { to: platform, bps: 500 }
  storage_tier: hot
metadata:
  category: ${category}
  tags: ${tags}
`;
  }

  async function publishGasless() {
    if (!address || !evmWallet) { setError('connect wallet first'); return; }
    setBusy(true); setError(null);
    try {
      // 1. Ensure the embedded/external wallet is on Arbitrum Sepolia so the
      //    EIP-712 domain.chainId matches AgentRegistryV2 on-chain (otherwise
      //    wallets refuse to sign and `recovered != seller` server-side).
      await evmWallet.switchChain(ARBITRUM_SEPOLIA_CHAIN_ID);

      const manifestYaml = buildManifestYaml();
      // Hash the manifest to get a stable bytes32 (full CID lives in DB).
      const manifestBytes = new TextEncoder().encode(manifestYaml);
      const hashBuf = await crypto.subtle.digest('SHA-256', manifestBytes);
      const manifestIpfsCid: `0x${string}` = ('0x' + Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;

      const registryV2Addr = (process.env.NEXT_PUBLIC_ARBLOOP_AGENT_REGISTRY_V2_ADDRESS ?? '') as `0x${string}`;
      if (!registryV2Addr.startsWith('0x') || registryV2Addr.length !== 42) {
        throw new Error('NEXT_PUBLIC_ARBLOOP_AGENT_REGISTRY_V2_ADDRESS not set');
      }

      const nonce = freshPublishNonce();
      const deadlineSec = BigInt(Math.floor(Date.now() / 1000) + 3600);

      const td = buildPublishAgentTypedData({
        chainId: ARBITRUM_SEPOLIA_CHAIN_ID,
        registryV2Address: registryV2Addr,
        seller: address as `0x${string}`,
        manifestIpfsCid,
        defaultBackend: 'bedrock',
        defaultModel: 'us.anthropic.claude-opus-4-6-v1',
        perIterMinMicroUsdc: BigInt(Math.round(parseFloat(perIter) * 0.5 * 1e6)),
        perIterDefaultMicroUsdc: BigInt(Math.round(parseFloat(perIter) * 1e6)),
        maxIter,
        deadlineSec,
        nonce,
      });

      // 2. Sign via ethers BrowserProvider over Privy's EIP-1193 provider —
      //    same pattern as chat/[agentId]/page.tsx::payAndAsk. Works for both
      //    Privy embedded wallets and external wallets (MetaMask/Rabby) without
      //    the wagmi useSignTypedData hook (which lags Privy on first render).
      const provider = await evmWallet.getEthereumProvider();
      const signer = await new BrowserProvider(provider).getSigner();
      const signature = await signer.signTypedData(
        td.domain,
        { PublishAgent: td.types.PublishAgent },
        td.message,
      );

      // Submit to relayer. Relayer pays gas + uploads manifest to Pinata.
      const r = await fetch(`${ARBLOOP_API_URL}/v3/arbloop/agents/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          seller_address: address,
          title,
          short_description: shortDesc,
          per_iter_default_micro_usdc: Math.round(parseFloat(perIter) * 1e6),
          per_iter_min_micro_usdc: Math.round(parseFloat(perIter) * 0.5 * 1e6),
          max_iter_per_job: maxIter,
          default_inference_backend: 'bedrock',
          default_model_id: 'us.anthropic.claude-opus-4-6-v1',
          manifest_yaml: manifestYaml,
          // v0.0 gasless additions:
          seller_signature: signature,
          publish_nonce: nonce.toString(),
          publish_deadline: deadlineSec.toString(),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
      setResult(j);
      setStep('done');
      setTimeout(() => router.push(searchParams?.get('return') ?? `/arbloop/agent/${j.agent_id}`), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (step === 'done' && result) {
    return (
      <div className="py-16 text-center space-y-3">
        <p className="text-secondary text-lg">✓ Published agent #{result.agent_id}</p>
        <p className="font-mono text-xs text-on-surface-variant break-all">tx: {result.tx_hash}</p>
        <p className="text-xs text-on-surface-variant">Gas paid by relayer · You signed once</p>
        <p className="text-sm">Redirecting to agent page…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="font-headline text-2xl font-bold">Publish an agent</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Sign once. Pay 0 gas. Earn 70% per task in USDC.
        </p>
      </header>

      {step === 'wizard' && (
        <div className="rounded-xl border border-outline-variant/30 bg-surface p-6 space-y-4">
          <p className="font-headline text-base font-semibold">Does your agent need memory of past jobs?</p>
          <p className="text-sm text-on-surface-variant">
            Pick "no" for one-shot tasks like translate, summarize, extract.
            Pick "yes" for multi-step research, monitoring, content workflows.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              onClick={() => { setNeedsMemory(false); setStep('fields'); }}
              className="rounded-xl border border-outline-variant/40 p-4 text-left hover:border-secondary/40">
              <div className="font-headline text-sm font-semibold">No — single-shot tasks</div>
              <p className="mt-1 text-xs text-on-surface-variant">x402 fast lane · 1 sig · ~30s wall clock</p>
            </button>
            <button
              onClick={() => { setNeedsMemory(true); setStep('fields'); }}
              className="rounded-xl border border-outline-variant/40 p-4 text-left hover:border-primary/40">
              <div className="font-headline text-sm font-semibold">Yes — multi-step jobs</div>
              <p className="mt-1 text-xs text-on-surface-variant">Loop hire · 1 Permit2 sig · N iterations</p>
            </button>
          </div>
        </div>
      )}

      {step === 'fields' && (
        <div className="rounded-xl border border-outline-variant/30 bg-surface p-6 space-y-4">
          <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${
            mode === 'x402' ? 'border-secondary/30 bg-secondary/15 text-secondary'
                            : 'border-primary/30 bg-primary/15 text-primary'
          }`}>{mode} mode · max {maxIter} iter</span>

          <Field label="Title" value={title} onChange={setTitle} placeholder="e.g. Legal NDA Translator (EN→VI)" />
          <Field label="Short description" value={shortDesc} onChange={setShortDesc} multiline placeholder="One sentence summary buyers will see in the marketplace." />
          <Field label="Persona system prompt" value={systemPrompt} onChange={setSystemPrompt} multiline rows={6} placeholder="You are a senior legal translator specializing in NDAs from English to Vietnamese..." />
          <Field label="Price per task (USDC)" value={perIter} onChange={setPerIter} type="number" />

          <div className="flex gap-3 pt-2">
            <button onClick={() => setStep('wizard')} className="rounded-full border border-outline-variant/40 px-4 py-2 text-sm">← Back</button>
            <button
              disabled={busy || !address || !title || !systemPrompt}
              onClick={publishGasless}
              className="ml-auto rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary disabled:opacity-50">
              {busy ? 'Publishing…' : address ? 'Sign & Publish (0 gas)' : 'Connect wallet to publish'}
            </button>
          </div>
          {error && <p className="text-xs text-amber-500">{error}</p>}
        </div>
      )}
    </div>
  );
}

function Field({
  label, value, onChange, type = 'text', multiline = false, rows = 3, placeholder = '',
}: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; multiline?: boolean; rows?: number; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] uppercase text-on-surface-variant">{label}</span>
      {multiline ? (
        <textarea
          value={value} onChange={(e) => onChange(e.target.value)} rows={rows} placeholder={placeholder}
          className="mt-1 w-full rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-sm" />
      ) : (
        <input
          type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
          className="mt-1 w-full rounded border border-outline-variant/40 bg-surface-container-low px-3 py-2 text-sm" />
      )}
    </label>
  );
}
