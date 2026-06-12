'use client';
import { useState } from 'react';
import { AGENT_BACKEND_URL } from '@/lib/contracts';
import type { ChatMessage } from '@/types/context';
import type { PermitReason } from './usePermit';
import { useBrainChunks } from './useBrainChunks';

/**
 * useChat — privacy-preserving chat hook (v2 path).
 *
 * Flow per message (mode='learn'):
 *   1) Browser fetches opaque ciphertext from API
 *   2) Browser asks Fhenix threshold network for AES key halves (gasless)
 *   3) Browser AES-GCM decrypts, TF-IDF picks top-K
 *   4) POST top-K chunks + question to /v2/inference (server never sees the key)
 *
 * For mode='store' (owner-only, legacy plaintext add) we still POST /chat. The
 * v2 surface for adding encrypted knowledge has been removed; the active
 * surface for user-owned memory is the FHE-encrypted /brain page.
 *
 * SOLID: single responsibility (chat round-trip); composes useBrainChunks;
 * caller-owned auth-error callback so the hook stays decoupled from <Permit/>.
 */
export function useChat(
  userAddress: `0x${string}` | undefined,
  onAuthError?: (reason: PermitReason) => void,
) {
  const { decryptAndRank } = useBrainChunks(userAddress);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsPayment, setNeedsPayment] = useState<{
    payTo?: string;
    amountUsdc?: string;
    network?: string;
  } | null>(null);
  // T6/PRD-C: the API returns X-Free-Preview-Remaining on every freemium-pass
  // response. The chat page reads this to tick the 🎁 badge without a second
  // round-trip to /v4/billing/balance.
  const [freeRemaining, setFreeRemaining] = useState<number | null>(null);

  async function sendMessage(
    content: string,
    brainId?: string,
    mode: 'learn' | 'store' = 'learn',
  ) {
    if (!userAddress) return;
    if (mode === 'learn' && !brainId) {
      setError('Pick a brain to ask.');
      return;
    }

    const userMsg: ChatMessage = { role: 'user', content, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);
    setError(null);
    setNeedsPayment(null);

    try {
      // Store mode: legacy plaintext-add path. Owner-only.
      if (mode === 'store') {
        const r = await fetch(`${AGENT_BACKEND_URL}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-wallet-address': userAddress },
          body: JSON.stringify({ message: content, brainId, mode }),
        });
        if (r.status === 403) {
          const body = await r.json().catch(() => ({}));
          onAuthError?.(body.reason ?? 'never_authorized');
          setError('FHE permit required.');
          return;
        }
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`);
        const data = await r.json();
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: data.response ?? '', timestamp: Date.now() },
        ]);
        return;
      }

      // Learn mode: branch on on-chain ownership (V1 contract).
      // Owner has FHE.allow → browser-decrypt. Non-owner → server-mediated 402 paywall.
      const { createPublicClient, http } = await import('viem');
      const { arbitrumSepolia } = await import('viem/chains');
      const pub = createPublicClient({ chain: arbitrumSepolia, transport: http() });
      const vaultAddr = (process.env.NEXT_PUBLIC_BRAIN_KEY_VAULT_V2_ADDRESS ??
        (await import('@/lib/contracts')).BRAIN_KEY_VAULT_ADDRESS) as `0x${string}`;
      const onChainOwner = await pub.readContract({
        address: vaultAddr,
        abi: [{ name: 'brainOwner', type: 'function', stateMutability: 'view', inputs: [{ name: 'brainId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] }],
        functionName: 'brainOwner',
        args: [BigInt(brainId!)],
      }) as string;
      const isOwner = onChainOwner.toLowerCase() === userAddress.toLowerCase();

      // Owner: real decrypt (errors propagate so user sees actual issue).
      // Non-owner: send empty chunks — API loads brain content server-side for published brains.
      const chunks: string[] = isOwner
        ? (await decryptAndRank(Number(brainId), content)).topK
        : [];

      const r = await fetch(`${AGENT_BACKEND_URL}/v2/inference`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-wallet-address': userAddress },
        body: JSON.stringify({ chunks, question: content, brainId: Number(brainId) }),
      });

      if (r.status === 402) {
        // Per-call x402 challenge — non-owner without granted access or paid receipt.
        const challenge = parseChallenge(r.headers.get('payment-required'));
        setNeedsPayment(challenge);
        setError('Pay to ask this brain.');
        return;
      }
      if (r.status === 403) {
        const body = await r.json().catch(() => ({}));
        const reason: PermitReason = body.reason ?? 'never_authorized';
        onAuthError?.(reason);
        setError('FHE permit required — re-authorize to continue.');
        return;
      }
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error ?? `Inference failed (${r.status})`);
      }

      // T6/PRD-C: surface freemium-remaining for the badge.
      const remaining = r.headers.get('x-free-preview-remaining');
      if (remaining !== null) setFreeRemaining(Number(remaining));

      const data = await r.json();
      const att = data.attestation
        ? ` ·  ${data.attestation.provider}${data.attestation.verified ? ' ✓' : ''}`
        : '';
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: (data.answer ?? '') + att, timestamp: Date.now() },
      ]);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to send message');
    } finally {
      setLoading(false);
    }
  }

  return { messages, sendMessage, loading, error, needsPayment, clearPayment: () => setNeedsPayment(null), freeRemaining };
}

function parseChallenge(header: string | null) {
  if (!header) return {};
  try {
    const b = JSON.parse(atob(header));
    const a = b?.accepts?.[0];
    return {
      payTo: a?.payTo,
      amountUsdc: a?.maxAmountRequired ? (Number(a.maxAmountRequired) / 1e6).toFixed(2) : '0.01',
      network: a?.network,
    };
  } catch {
    return {};
  }
}
