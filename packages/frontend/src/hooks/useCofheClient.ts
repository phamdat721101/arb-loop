'use client';
import { useState, useEffect } from 'react';
import { getBrowserCofheClient } from '@/lib/cofhe';

export function useCofheClient() {
  const [client, setClient] = useState<Awaited<ReturnType<typeof getBrowserCofheClient>> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setClient(getBrowserCofheClient());
    setLoading(false);
  }, []);

  return { client, loading };
}
