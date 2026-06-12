'use client';
import { useState, useEffect } from 'react';
import { AGENT_BACKEND_URL } from '@/lib/contracts';

interface License { skillIndex: number; licenseId: string; purchasedAt: number; expiresAt: number; }

export function useUserLicenses(userAddress: string | undefined) {
  const [licenses, setLicenses] = useState<License[]>([]);
  const [loading, setLoading] = useState(false);

  function fetchLicenses(addr: string) {
    setLoading(true);
    fetch(`${AGENT_BACKEND_URL}/skill/user/${addr}/licenses`)
      .then(r => r.json())
      .then(d => setLicenses(d.licenses ?? []))
      .catch((e) => console.warn('License fetch failed:', e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (userAddress) fetchLicenses(userAddress);
  }, [userAddress]);

  const refetch = () => { if (userAddress) fetchLicenses(userAddress); };

  return { licenses, loading, hasSkill: (idx: number) => licenses.some(l => l.skillIndex === idx), refetch };
}
