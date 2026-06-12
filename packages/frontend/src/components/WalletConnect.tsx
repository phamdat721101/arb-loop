'use client';
import { useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { usePrivyEvmAddress } from '@/hooks/useActiveWallet';

export function WalletConnect() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const privyEvmAddress = usePrivyEvmAddress();
  const [copied, setCopied] = useState(false);

  function copyAddress(addr: string) {
    navigator.clipboard.writeText(addr).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (!ready) {
    return (
      <button
        disabled
        className="rounded-full bg-surface-container-high px-4 py-2 text-sm text-on-surface-variant"
      >
        Loading…
      </button>
    );
  }

  if (authenticated) {
    const addr = privyEvmAddress;
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={() => addr && copyAddress(addr)}
          title={addr ?? 'Copy address'}
          className="flex items-center gap-2 rounded-full border border-outline-variant/40 bg-surface-container-high px-3 py-1.5 font-mono text-xs text-primary transition-colors hover:border-primary/40"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-secondary" />
          {copied ? 'Copied' : addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—'}
        </button>
        <button
          onClick={logout}
          className="hidden rounded-full border border-outline-variant/30 px-3 py-1.5 text-xs text-on-surface-variant transition-colors hover:border-error/40 hover:text-error sm:inline"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={login}
      className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary/90"
    >
      Start
    </button>
  );
}
