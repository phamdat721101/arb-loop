'use client';

/**
 * useEncryptedBalance — three-state hook for the one-tap private-payment UI.
 *
 * States derived from /v4/billing/balance:
 *   - 'preview'           freeCallsRemaining[brainId] > 0 → 🎁 N free questions left
 *   - 'needs-activation'  free quota exhausted, balanceHandle == ZeroHash → 🔒 Activate
 *   - 'active'            free quota exhausted, balanceHandle != ZeroHash → 🔒 $X left
 *   - 'unknown'           pre-fetch / FEATURE_FHE_PAY=false on server (404) → fallback label
 *
 * SOLID:
 *   - SRP: this file owns only the freemium + encrypted-balance state. Pay
 *     itself is delegated to useFherc20Pay (already exists).
 *   - DIP: ABI/contract addresses come from env via the API; the hook never
 *     instantiates a viem client. Single round-trip to /v4/billing/balance.
 *   - I1: bundles the tiny usePrivacyDisclosure helper (single boolean) so
 *     we don't add a second hook file.
 */

import { useCallback, useEffect, useState } from 'react';
import { AGENT_BACKEND_URL } from '@/lib/contracts';

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000';

export type PaymentMode = 'preview' | 'needs-activation' | 'active' | 'unknown';

export interface EncryptedBalanceState {
  mode: PaymentMode;
  freeLeft: number;
  /** Decimal USDC the user has on the agent. null = handle present but not yet decrypted. */
  balanceUsdc: number | null;
  balanceHandle: string;
  loading: boolean;
  /** Re-fetch /v4/billing/balance — call after each settled chat turn or top-up. */
  refresh: () => Promise<void>;
}

export function useEncryptedBalance(
  user?: `0x${string}`,
  brainId?: string,
  agent?: `0x${string}`,
): EncryptedBalanceState {
  const [mode, setMode] = useState<PaymentMode>('unknown');
  const [freeLeft, setFreeLeft] = useState(0);
  const [balanceUsdc, setBalanceUsdc] = useState<number | null>(null);
  const [balanceHandle, setBalanceHandle] = useState<string>(ZERO_HASH);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user || !brainId) {
      setMode('unknown');
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ brain_id: brainId });
      if (agent) params.set('agent', agent);
      const r = await fetch(
        `${AGENT_BACKEND_URL}/v4/billing/balance/${user}?${params.toString()}`,
        { headers: { 'x-wallet-address': user } },
      );
      // 404 means FEATURE_FHE_PAY is off on the server — silently degrade.
      if (r.status === 404) {
        setMode('unknown');
        return;
      }
      if (!r.ok) throw new Error(`balance request failed (${r.status})`);
      const data = await r.json();
      const left = Number(data.freeCallsRemaining?.[brainId] ?? 0);
      const handle: string = data.balanceHandle ?? ZERO_HASH;
      setFreeLeft(left);
      setBalanceHandle(handle);
      // For mode purposes we treat any non-zero handle as having balance.
      // Decrypting the actual amount happens client-side via permit; null
      // until that succeeds (the chat page can render without a number).
      if (left > 0) setMode('preview');
      else if (handle === ZERO_HASH) setMode('needs-activation');
      else setMode('active');
    } catch {
      // Server unavailable / transient: fall back to unknown so UI degrades.
      setMode('unknown');
    } finally {
      setLoading(false);
    }
  }, [user, brainId, agent]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Lightweight optimistic update on each chat response (server returns header X-Free-Preview-Remaining). */
  // The chat page applies this via setFreeLeft if the header is present —
  // exposed on the hook to avoid a `/v4/billing/balance` round-trip per Q.
  return { mode, freeLeft, balanceUsdc, balanceHandle, loading, refresh };
}

// ── Privacy disclosure (single boolean, localStorage-backed) ────────────────
//
// Co-located here because it's part of the same private-payment surface:
// when the toggle is on, /chat exposes settlement IDs + FHE handles per
// assistant message. Off → byte-identical default chat.

const STORAGE_KEY = 'openx.disclose';

export function usePrivacyDisclosure() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    try {
      setEnabled(localStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      /* SSR / sandbox — no-op */
    }
  }, []);

  const toggle = useCallback((v: boolean) => {
    setEnabled(v);
    try {
      localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
    } catch {
      /* no-op */
    }
  }, []);

  return { enabled, toggle };
}
