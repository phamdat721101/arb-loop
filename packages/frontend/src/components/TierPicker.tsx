'use client';

/**
 * TierPicker — single-card Standard tier picker (Arbitrum-only build).
 *
 * SOLID: Single Responsibility — this component renders + selects.
 */

import { useTier, type Tier } from '@/hooks/useTier';

interface TierFacts {
  id: Tier;
  name: string;
  chain: string;
  storage: string;
  cost: string;
  proof: string;
  payment: string;
  ecosystem: string;
}

const TIERS: TierFacts[] = [
  {
    id: 'standard',
    name: 'Standard',
    chain: 'Arbitrum (Fhenix CoFHE)',
    storage: 'Postgres + AES-256-GCM',
    cost: '~$0.115/GB/mo',
    proof: 'On-chain FHE-wrapped key (BrainKeyVaultV2)',
    payment: 'x402 + USDC on Base Sepolia',
    ecosystem: 'EVM agents, ERC-8004 KYA',
  },
];

export function TierPicker({ onPick }: { onPick?: (tier: Tier) => void }) {
  const { tier: current, setTier } = useTier();
  return (
    <div className="grid gap-4 md:grid-cols-1">
      {TIERS.map((t) => {
        const selected = current === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTier(t.id);
              onPick?.(t.id);
            }}
            aria-pressed={selected}
            className={[
              'text-left rounded-2xl border p-5 transition focus:outline-none',
              selected
                ? 'border-blue-500 bg-blue-50 shadow ring-2 ring-blue-300'
                : 'border-gray-200 bg-white hover:border-gray-400',
            ].join(' ')}
          >
            <h3 className="text-lg font-semibold text-gray-900">{t.name}</h3>
            <p className="mt-1 text-sm text-gray-500">{t.chain}</p>
            <dl className="mt-4 space-y-2 text-sm">
              <Row k="Storage" v={t.storage} />
              <Row k="Cost" v={t.cost} />
              <Row k="Trust proof" v={t.proof} />
              <Row k="Payment" v={t.payment} />
              <Row k="Ecosystem" v={t.ecosystem} />
            </dl>
          </button>
        );
      })}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-gray-500">{k}</dt>
      <dd className="text-right text-gray-900">{v}</dd>
    </div>
  );
}
