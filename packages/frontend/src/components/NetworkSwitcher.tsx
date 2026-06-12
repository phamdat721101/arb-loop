'use client';

/**
 * components/NetworkSwitcher.tsx — top-bar EVM chain picker (Arbitrum-only).
 *
 * Renders a compact pill next to the WalletConnect button. Click → dropdown
 * with the EVM networks OpenX supports (Base Sepolia, Arbitrum Sepolia).
 *
 * Single source of truth for the *selected key* lives in `hooks/useNetwork`.
 * This component only renders + delegates.
 *
 * SOLID:
 *   - SRP: dropdown UI + delegate. No persistence here.
 *   - DIP: chain literals come from `lib/networks.ts`.
 *   - OCP: a new EVM network = a new entry in SUPPORTED_NETWORKS, nothing else.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePrivy, type ConnectedWallet } from '@privy-io/react-auth';
import { usePrivyEvmWallet } from '@/hooks/useActiveWallet';
import {
  SUPPORTED_NETWORKS,
  getNetworkById,
  type Network,
  type NetworkKey,
} from '@/lib/networks';
import { useNetwork } from '@/hooks/useNetwork';

// ─── helpers ─────────────────────────────────────────────────────────────

/** Parse Privy's CAIP-2 wallet.chainId (e.g. "eip155:421614") → decimal id. */
function parseChainId(caip2OrNumber: string | number | undefined | null): number | undefined {
  if (caip2OrNumber == null) return undefined;
  if (typeof caip2OrNumber === 'number') return caip2OrNumber;
  const tail = caip2OrNumber.split(':').pop() ?? caip2OrNumber;
  const n = Number(tail);
  return Number.isFinite(n) ? n : undefined;
}

// ─── chain switch ────────────────────────────────────────────────────────

type SwitchError = 'rejected' | 'no-wallet' | string;

async function switchTo(network: Network, evmWallet: ConnectedWallet | undefined): Promise<void> {
  if (!evmWallet) throw Object.assign(new Error('no-wallet'), { code: 'no-wallet' });
  await evmWallet.switchChain(network.id);
}

function classifyError(err: unknown): SwitchError {
  const e = err as { code?: number | string; message?: string };
  if (e.code === 4001 || /user rejected|denied/i.test(e.message ?? '')) return 'rejected';
  if (e.code === 'no-wallet') return 'no-wallet';
  return e.message ?? 'unknown';
}

// ─── component ───────────────────────────────────────────────────────────

export function NetworkSwitcher() {
  const { authenticated, ready } = usePrivy();
  const evmWallet = usePrivyEvmWallet();

  const evmChainId = parseChainId(evmWallet?.chainId);
  const evmNetwork = getNetworkById(evmChainId);

  const { network: selected, networkKey, setNetworkKey, ready: netReady } = useNetwork();

  const [open, setOpen] = useState(false);
  const [pendingKey, setPendingKey] = useState<NetworkKey | null>(null);
  const [error, setError] = useState<SwitchError | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Mirror the wallet's actual chain into our pill state when it settles.
  useEffect(() => {
    if (!netReady) return;
    if (evmNetwork && evmNetwork.key !== selected.key) {
      setNetworkKey(evmNetwork.key);
    }
  }, [evmNetwork?.key, netReady, selected.key, setNetworkKey]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const onPick = useCallback(
    async (network: Network) => {
      setError(null);
      if (network.key === networkKey && network.id === evmChainId) {
        setOpen(false);
        return;
      }
      setPendingKey(network.key);
      try {
        await switchTo(network, evmWallet);
        setNetworkKey(network.key);
        setOpen(false);
      } catch (err) {
        setError(classifyError(err));
      } finally {
        setPendingKey(null);
      }
    },
    [networkKey, evmWallet, evmChainId, setNetworkKey],
  );

  const pillLabel = useMemo(() => {
    if (!authenticated) return 'Network';
    return selected.shortName;
  }, [authenticated, selected.shortName]);

  const pillIcon = selected.icon;
  const disabled = !ready || !authenticated;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title={selected.name}
        aria-label={`Switch network. Current: ${selected.name}.`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-mono transition-colors ${
          disabled
            ? 'cursor-not-allowed border-outline-variant/20 bg-surface-container-low text-on-surface-variant/60'
            : 'border-outline-variant/40 bg-surface-container-high text-on-surface hover:border-primary/40'
        }`}
      >
        <span aria-hidden className="text-[12px] leading-none">{pillIcon}</span>
        <span className="hidden sm:inline">{pillLabel}</span>
        <span className="material-symbols-outlined text-[14px] opacity-70">
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {open && !disabled && (
        <div
          role="listbox"
          aria-label="Networks"
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-72 overflow-hidden rounded-xl border border-outline-variant/30 bg-surface shadow-xl"
        >
          <div className="border-b border-outline-variant/30 px-3 py-2 text-[10px] font-mono uppercase tracking-widest text-on-surface-variant">
            switch network
          </div>
          <ul className="py-1">
            {SUPPORTED_NETWORKS.map((n) => {
              const active = n.key === networkKey;
              const pending = pendingKey === n.key;
              const subtitle = `${n.featureHint} · chain ${n.id}`;
              return (
                <li key={n.key}>
                  <button
                    type="button"
                    onClick={() => onPick(n)}
                    role="option"
                    aria-selected={active}
                    disabled={pending}
                    className={`flex w-full items-start gap-3 px-3 py-2 text-left text-sm transition-colors ${
                      active ? 'bg-primary/10 text-primary' : 'hover:bg-surface-container-high'
                    }`}
                  >
                    <span aria-hidden className="mt-0.5 text-base leading-none">{n.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 font-medium">
                        {n.name}
                        {active && <span className="material-symbols-outlined text-[14px]">check_circle</span>}
                      </span>
                      <span className="block text-[11px] text-on-surface-variant">{subtitle}</span>
                    </span>
                    {pending && (
                      <span className="material-symbols-outlined animate-spin text-[16px] text-on-surface-variant">
                        progress_activity
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {error && <ErrorRow error={error} onDismiss={() => setError(null)} />}
        </div>
      )}
    </div>
  );
}

function ErrorRow({ error, onDismiss }: { error: SwitchError; onDismiss: () => void }) {
  const message =
    error === 'rejected'
      ? 'Switch declined in your wallet.'
      : error === 'no-wallet'
      ? 'Connect a wallet first.'
      : `Switch failed: ${error}`;
  return (
    <div className="flex items-start gap-2 border-t border-error/30 bg-error/10 px-3 py-2 text-[11px] text-error">
      <span className="material-symbols-outlined text-[14px]">error</span>
      <span className="flex-1">{message}</span>
      <button onClick={onDismiss} className="rounded p-0.5 hover:bg-error/20" aria-label="Dismiss">
        <span className="material-symbols-outlined text-[14px]">close</span>
      </button>
    </div>
  );
}
