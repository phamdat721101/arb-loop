'use client';
import { useEffect, useState } from 'react';
import { listMyAgents } from '@/lib/agents';

export type Role = 'producer' | 'consumer' | 'unknown';

const cacheKey = (addr: string) => `openx_role_${addr}`;

/**
 * Determines the user's role based on whether they own any agents.
 * Cached in sessionStorage to avoid re-fetching on every navigation;
 * the cache lives for the tab lifetime so manual reload re-evaluates.
 */
export function useRole(walletAddress: string | undefined) {
  const [role, setRole] = useState<Role>('unknown');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!walletAddress) {
      setRole('unknown');
      return;
    }

    const cached =
      typeof window !== 'undefined' ? sessionStorage.getItem(cacheKey(walletAddress)) : null;
    if (cached === 'producer' || cached === 'consumer') {
      setRole(cached);
      return;
    }

    let cancelled = false;
    setLoading(true);
    listMyAgents(walletAddress)
      .then((agents) => {
        if (cancelled) return;
        const next: Role = agents.length > 0 ? 'producer' : 'consumer';
        setRole(next);
        try {
          sessionStorage.setItem(cacheKey(walletAddress), next);
        } catch {
          /* storage may be disabled in private mode — non-fatal */
        }
      })
      .catch(() => {
        if (!cancelled) setRole('consumer');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  return { role, loading };
}
