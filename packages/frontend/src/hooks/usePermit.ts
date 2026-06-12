'use client';
import { useState, useEffect, useCallback } from 'react';
import { BrowserProvider, Contract } from 'ethers';
import { BRAIN_KEY_VAULT_ADDRESS, AGENT_BACKEND_URL } from '@/lib/contracts';
import { ARBITRUM_SEPOLIA_CHAIN_ID } from '@/lib/networks';
import { usePrivyEvmWallet } from './useActiveWallet';
import type { PermitState } from '@/types/context';

const VAULT_ABI = [
  'function authorize(address platform)',
  'function revoke(address platform)',
  'function isAuthorized(address user, address platform) view returns (bool)',
];

/**
 * Mirrors the API's PermitReason union. Defined here so the frontend has
 * no compile-time dependency on the API package while staying in sync.
 */
export type PermitReason =
  | 'cache_hit'
  | 'onchain_authorized'
  | 'never_authorized'
  | 'permit_revoked'
  | 'cache_expired'
  | 'config_unavailable'
  | 'rpc_error';

const EMPTY: PermitState = { serializedPermit: null, permitId: null, expiresAt: null };

export function usePermit(userAddress: `0x${string}` | undefined) {
  const evmWallet = usePrivyEvmWallet();
  const [permitState, setPermitState] = useState<PermitState>(EMPTY);
  const [reason, setReason] = useState<PermitReason | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Re-check server-authoritative status; sync local state to truth. */
  const refresh = useCallback(async () => {
    if (!userAddress) return;
    try {
      const r = await fetch(`${AGENT_BACKEND_URL}/permit/status?address=${userAddress}`);
      const data = await r.json() as { authorized: boolean; reason: PermitReason };
      setReason(data.reason);
      if (data.authorized) {
        // Server says yes — keep local state if present, otherwise mark
        // authorized with a synthetic marker (caller can still call authorize
        // again to refresh tx hash if needed).
        const stored = localStorage.getItem(`fhe_permit_${userAddress}`);
        if (stored) {
          try { setPermitState(JSON.parse(stored)); return; } catch {}
        }
        setPermitState({ serializedPermit: 'on-chain', permitId: 'on-chain', expiresAt: null });
      } else {
        // Server says no — clear stale local state.
        localStorage.removeItem(`fhe_permit_${userAddress}`);
        setPermitState(EMPTY);
      }
    } catch { /* offline tolerance: keep local state */ }
  }, [userAddress]);

  /** Imperative state-clear callable on 403 from any protected route. */
  const forceUnauthorized = useCallback((newReason?: PermitReason) => {
    if (userAddress) localStorage.removeItem(`fhe_permit_${userAddress}`);
    setPermitState(EMPTY);
    if (newReason) setReason(newReason);
  }, [userAddress]);

  // Load from localStorage, then refresh from /permit/status. Stale
  // localStorage cannot grant access; server is the source of truth.
  useEffect(() => {
    if (!userAddress) return;
    const stored = localStorage.getItem(`fhe_permit_${userAddress}`);
    if (stored) {
      try { setPermitState(JSON.parse(stored)); } catch {}
    }
    refresh();
  }, [userAddress, refresh]);

  async function authorize(platformWallet: `0x${string}`) {
    if (!userAddress || !evmWallet) {
      setError('Wallet not connected'); return;
    }
    setLoading(true);
    setError(null);
    try {
      await evmWallet.switchChain(ARBITRUM_SEPOLIA_CHAIN_ID);
      const provider = await evmWallet.getEthereumProvider();
      const ethersProvider = new BrowserProvider(provider);
      const signer = await ethersProvider.getSigner();
      const contract = new Contract(BRAIN_KEY_VAULT_ADDRESS, VAULT_ABI, signer);

      // On-chain authorize — this triggers the wallet popup
      const tx = await contract.authorize(platformWallet);
      await tx.wait();

      // Notify backend — it will verify on-chain state directly
      await fetch(`${AGENT_BACKEND_URL}/permit/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userAddress, txHash: tx.hash }),
      }).catch(() => {});

      // Refresh permit status from server (server checks on-chain)
      await refresh();

      const newState = { serializedPermit: tx.hash, permitId: tx.hash, expiresAt: null };
      setPermitState(newState);
      setReason('onchain_authorized');
      localStorage.setItem(`fhe_permit_${userAddress}`, JSON.stringify(newState));
    } catch (e: any) {
      setError(e?.shortMessage || e?.message || 'Authorization failed');
    } finally {
      setLoading(false);
    }
  }

  async function revoke() {
    if (!userAddress || !evmWallet) return;
    setLoading(true);
    try {
      const provider = await evmWallet.getEthereumProvider();
      const signer = await new BrowserProvider(provider).getSigner();
      const contract = new Contract(BRAIN_KEY_VAULT_ADDRESS, VAULT_ABI, signer);
      const platform = (await fetch(`${AGENT_BACKEND_URL}/platform`).then(r => r.json())).platformWallet;
      const tx = await contract.revoke(platform);
      await tx.wait();
      await fetch(`${AGENT_BACKEND_URL}/permit/revoke`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userAddress }),
      });
      forceUnauthorized('never_authorized');
    } catch (e: any) {
      setError(e?.message ?? 'Revoke failed');
    } finally {
      setLoading(false);
    }
  }

  return { permitState, reason, authorize, revoke, refresh, forceUnauthorized, loading, error };
}
