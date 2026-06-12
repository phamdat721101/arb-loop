import pg from 'pg';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const CHAINS = [
  { name: 'arbitrum-sepolia', rpc: process.env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc' },
  { name: 'base-sepolia', rpc: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org' },
];

const REGISTRY_ADDRESS = process.env.KNOWLEDGE_REGISTRY_ADDRESS;

async function pollEvents(chain: typeof CHAINS[0]) {
  if (!REGISTRY_ADDRESS) return;
  try {
    const res = await fetch(chain.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
        params: [{ address: REGISTRY_ADDRESS, fromBlock: 'latest', topics: [] }],
      }),
    });
    const { result } = await res.json() as any;
    for (const log of result || []) {
      if (log.topics?.[1]) {
        const owner = '0x' + log.topics[1].slice(26);
        const brainId = parseInt(log.topics[2] || '0', 16);
        if (brainId) {
          await db.query(
            `INSERT INTO brains (id, owner_address, chain) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET owner_address=$2`,
            [brainId, owner, chain.name]
          );
        }
      }
    }
  } catch (e) {
    console.error(`[chain-sync:${chain.name}]`, e);
  }
}

export function startChainSync() {
  setInterval(() => CHAINS.forEach(pollEvents), 30_000);
  console.log('[chain-sync] started polling', CHAINS.map(c => c.name).join(', '));
}
