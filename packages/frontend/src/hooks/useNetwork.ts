'use client';

/**
 * useNetwork — single source of truth for the user's selected network.
 *
 * Before this hook landed, network state was duplicated:
 *   - `NetworkSwitcher.tsx` owned its own URL+localStorage persistence.
 *   - `useTier.ts` owned a separate `openx:tier` localStorage key.
 *   - The two never synced — selecting "Trustless" never updated the
 *     network pill, and switching to Sui never set tier='trustless'.
 *
 * This module collapses both into one canonical key (`openx:network`).
 * `useTier` is now a derived selector — see hooks/useTier.ts.
 *
 * SOLID:
 *  - SRP: persistence + URL sync only. UI lives in NetworkSwitcher.
 *  - DIP: callers consume named lookups; no chain literals leak in.
 *  - OCP: adding a new network = one entry in lib/networks.ts.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  SUPPORTED_NETWORKS,
  getNetworkByKey,
  type Network,
  type NetworkKey,
} from '@/lib/networks';

const STORAGE_KEY = 'openx:network';
const URL_PARAM = 'network';
/** Default network when nothing is persisted. Matches the historical default
 *  before this hook existed (Arbitrum Sepolia for the standard Fhenix tier). */
const DEFAULT_KEY: NetworkKey = 'arbitrum-sepolia';

function isNetworkKey(v: unknown): v is NetworkKey {
  return typeof v === 'string' && SUPPORTED_NETWORKS.some((n) => n.key === v);
}

function readPersistedKey(): NetworkKey | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get(URL_PARAM);
    if (isNetworkKey(fromUrl)) return fromUrl;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isNetworkKey(stored)) return stored;
  } catch {
    /* SSR */
  }
  return null;
}

function persistKey(key: NetworkKey) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, key);
    const url = new URL(window.location.href);
    url.searchParams.set(URL_PARAM, key);
    window.history.replaceState({}, '', url.toString());
  } catch {
    /* SSR */
  }
}

export interface UseNetworkResult {
  /** The currently selected network — never undefined after first paint. */
  network: Network;
  /** Stable shorthand for callers that just need the key. */
  networkKey: NetworkKey;
  /** Set the active network. Persists to URL + localStorage atomically. */
  setNetworkKey: (key: NetworkKey) => void;
  /** True after the first hydration pass — gate UI that depends on real state. */
  ready: boolean;
}

export function useNetwork(): UseNetworkResult {
  const [networkKey, setKey] = useState<NetworkKey>(DEFAULT_KEY);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const persisted = readPersistedKey();
    if (persisted) setKey(persisted);
    setReady(true);
  }, []);

  const setNetworkKey = useCallback((key: NetworkKey) => {
    setKey(key);
    persistKey(key);
  }, []);

  return {
    network: getNetworkByKey(networkKey),
    networkKey,
    setNetworkKey,
    ready,
  };
}
