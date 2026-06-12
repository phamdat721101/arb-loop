'use client';
import { useRef, useState, useCallback, useEffect } from 'react';
import { PermitUtils } from '@cofhe/sdk/permits';
import { usePrivyEvmWallet } from './useActiveWallet';

/**
 * useFheClient — singleton React hook wrapping @cofhe/sdk/web.
 *
 * Lifecycle: createCofheConfig → createCofheClient → connect(publicClient, walletClient)
 * Lazy-loads the WASM module only when first called (saves ~3MB on initial page load).
 *
 * Exposes:
 *   - client: the connected CofheClient (null until ready)
 *   - ready: boolean
 *   - error: string | null
 *   - ensurePermit(): creates self-permit if not already present
 */

type CofheClient = any; // SDK types are complex; we use `any` for the hook surface

let _clientPromise: Promise<CofheClient> | null = null;
let _client: CofheClient | null = null;

export function useFheClient() {
  const evmWallet = usePrivyEvmWallet();
  const [ready, setReady] = useState(!!_client);
  const [error, setError] = useState<string | null>(null);
  const initRef = useRef(false);

  const init = useCallback(async (): Promise<CofheClient | null> => {
    // Already connected → return module-level singleton (covers cross-component reuse).
    if (_client) return _client;
    // Init in flight → join it instead of starting a second WASM load.
    if (_clientPromise) return _clientPromise;
    // No EVM wallet → caller should prompt sign-in; we don't auto-fail here.
    if (!evmWallet) return null;
    initRef.current = true;

    _clientPromise = (async () => {
      try {
        // Dynamic import — WASM only loads when needed
        const { createCofheConfig, createCofheClient } = await import('@cofhe/sdk/web');
        const { chains } = await import('@cofhe/sdk/chains');
        const { createPublicClient, createWalletClient, custom, http } = await import('viem');
        const { arbitrumSepolia } = await import('viem/chains');

        const config = createCofheConfig({ supportedChains: [chains.arbSepolia] });
        const client = createCofheClient(config);

        const provider = await evmWallet.getEthereumProvider();
        const account = evmWallet.address as `0x${string}`;
        const publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http() });
        const walletClient = createWalletClient({ account, chain: arbitrumSepolia, transport: custom(provider) });

        await client.connect(publicClient as any, walletClient as any);
        _client = client;
        setReady(true);
        return client;
      } catch (e: any) {
        setError(e.message);
        _clientPromise = null;
        throw e;
      }
    })();

    return _clientPromise;
  }, [evmWallet]);

  useEffect(() => {
    if (evmWallet && !_client && !initRef.current) {
      init();
    }
  }, [evmWallet, init]);

  const ensurePermit = useCallback(async () => {
    const c = _client ?? (await _clientPromise);
    if (!c) throw new Error('FHE client not initialized');
    // SDK's getOrCreateSelfPermit returns expired self-permits as-is. Evict
    // the stale entry so the create-new branch fires and the wallet signs a
    // fresh permit (single popup, then cached for the SDK's default TTL).
    const active = c.permits.getActivePermit();
    if (active && PermitUtils.isExpired(active)) {
      await c.permits.removePermit(active.hash);
    }
    await c.permits.getOrCreateSelfPermit();
  }, []);

  return { client: _client, ready, error, ensurePermit, init };
}
