'use client';
import { useState } from 'react';
import Link from 'next/link';
import type { PermitState } from '@/types/context';
import type { PermitReason } from '@/hooks/usePermit';
import { BRAIN_KEY_VAULT_ADDRESS, AGENT_BACKEND_URL } from '@/lib/contracts';

const REASON_TEXT: Record<PermitReason, string> = {
  cache_hit: 'Authorized via cached permit.',
  onchain_authorized: 'Authorized — verified on-chain.',
  never_authorized: 'You have not authorized the platform yet.',
  permit_revoked: 'Your permit was revoked. Re-authorize to continue.',
  cache_expired: 'Your permit cache expired. Re-authorize to continue.',
  config_unavailable: 'Server misconfigured (missing vault address).',
  rpc_error: 'Network issue checking on-chain state. Please retry.',
};

const STEPS = [
  { label: 'Sign transaction', desc: 'BrainKeyVault.authorize() on Arbitrum Sepolia' },
  { label: 'Confirm on-chain', desc: 'Waiting for block confirmation...' },
  { label: 'Verify permit', desc: 'Platform confirms FHE access grant' },
];

interface Props {
  permitState: PermitState;
  authorize: (platformWallet: `0x${string}`) => Promise<void>;
  revoke: () => Promise<void>;
  loading: boolean;
  error: string | null;
  reason?: PermitReason | null;
}

export function PermitManager({ permitState, authorize, revoke, loading, error, reason }: Props) {
  const [step, setStep] = useState(0);
  const [platformWallet, setPlatformWallet] = useState<string | null>(null);

  async function handleAuthorize() {
    // Fetch platform wallet from API (source of truth)
    let wallet = platformWallet;
    if (!wallet) {
      try {
        const r = await fetch(`${AGENT_BACKEND_URL}/platform`);
        const data = await r.json();
        wallet = data.platformWallet;
        setPlatformWallet(wallet);
      } catch {
        return; // will show error from usePermit
      }
    }
    if (!wallet) return;
    setStep(1);
    await authorize(wallet as `0x${string}`);
  }

  if (permitState.serializedPermit) {
    return (
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>verified_user</span>
          </div>
          <div>
            <p className="font-semibold text-on-surface">FHE Permit Active</p>
            <p className="text-xs text-on-surface-variant">
              Platform can decrypt your brain via Fhenix CoFHE threshold network
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-on-surface-variant bg-surface-container-low rounded-lg px-3 py-2">
          <span className="material-symbols-outlined text-[14px]">link</span>
          <span className="font-mono">Vault: {BRAIN_KEY_VAULT_ADDRESS.slice(0, 10)}...{BRAIN_KEY_VAULT_ADDRESS.slice(-6)}</span>
          <a href={`https://sepolia.arbiscan.io/address/${BRAIN_KEY_VAULT_ADDRESS}`} target="_blank" rel="noopener" className="text-primary hover:underline ml-auto">View ↗</a>
        </div>
        {error && <p className="text-error text-sm">{error}</p>}
        <button onClick={revoke} disabled={loading} className="text-sm text-error hover:text-error/80 underline">
          {loading ? 'Revoking...' : 'Revoke permit (cuts access cryptographically)'}
        </button>
      </div>
    );
  }

  const reasonText = reason ? REASON_TEXT[reason] : null;

  return (
    <div className="rounded-xl border border-outline-variant/40 bg-surface-container-low p-5 space-y-4">
      {/* Fhenix explainer */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-tertiary/10 flex items-center justify-center shrink-0">
          <span className="material-symbols-outlined text-tertiary">key</span>
        </div>
        <div>
          <p className="font-semibold text-on-surface">Sign in to your encrypted brain</p>
          <p className="text-sm text-on-surface-variant">
            Your brain&apos;s AES key is encrypted on-chain via Fhenix CoFHE. This one-time signature
            lets the platform decrypt it via the Fhenix threshold network — revocable any time.
          </p>
        </div>
      </div>

      {/* Steps indicator */}
      {loading && (
        <div className="space-y-2 pl-2">
          {STEPS.map((s, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                i < step ? 'bg-primary text-on-primary' :
                i === step ? 'bg-primary/20 text-primary animate-pulse' :
                'bg-surface-container-high text-on-surface-variant'
              }`}>
                {i < step ? '✓' : i + 1}
              </div>
              <div>
                <p className={`text-sm font-medium ${i <= step ? 'text-on-surface' : 'text-on-surface-variant'}`}>{s.label}</p>
                <p className="text-xs text-on-surface-variant">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {reasonText && !loading && (
        <p className="text-sm text-on-surface-variant bg-surface-container-high rounded-lg px-3 py-2">{reasonText}</p>
      )}

      {error && <p className="text-error text-sm">{error}</p>}

      <button
        onClick={handleAuthorize}
        disabled={loading}
        className="w-full py-3 px-4 bg-primary text-on-primary rounded-full font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {loading ? (
          <><span className="animate-spin material-symbols-outlined text-[18px]">progress_activity</span> Signing in…</>
        ) : (
          <><span className="material-symbols-outlined text-[18px]">lock_open</span> Sign in to your encrypted brain</>
        )}
      </button>

      <p className="text-xs text-center text-on-surface-variant">
        Requires 1 wallet signature (on-chain transaction).{' '}
        <Link href="/docs" className="text-primary hover:underline">Learn more →</Link>
      </p>
    </div>
  );
}
