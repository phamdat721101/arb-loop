import { Router } from 'express';
import { auth, AuthRequest } from '../middleware/auth';
import { pool } from '../db';
import { ethers } from 'ethers';

const router = Router();
router.use(auth);

const DURATIONS: Record<string, number> = { week: 7, month: 30, quarter: 90 };
const TIER_IDS: Record<string, number> = { week: 1, month: 2, quarter: 3 };

router.post('/', async (req: AuthRequest, res) => {
  try {
    const { tier } = req.body;
    if (!DURATIONS[tier]) return res.status(400).json({ error: 'Invalid tier: week, month, quarter' });

    const chain = (req.headers['x-chain'] as string) || 'arbitrum-sepolia';
    const days = DURATIONS[tier];
    const expiresAt = new Date(Date.now() + days * 86400000);
    const expiryUnix = Math.floor(expiresAt.getTime() / 1000);

    // On-chain: call SubscriptionController.subscribe()
    let txHash = '0x0';
    const rpcUrl = chain === 'base-sepolia'
      ? (process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org')
      : (process.env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc');
    const contractAddr = process.env.SUBSCRIPTION_CONTROLLER_ADDRESS;

    if (process.env.PRIVATE_KEY && contractAddr) {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
      const abi = ['function subscribe(address user, uint8 tier, uint64 expiry) external'];
      const contract = new ethers.Contract(contractAddr, abi, wallet);
      const tx = await contract.subscribe(ethers.getAddress(req.user!.address), TIER_IDS[tier], expiryUnix);
      txHash = tx.hash;
    }

    // Cache in Postgres
    await pool.query(
      `INSERT INTO subscriptions (user_address, tier, chain, tx_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_address) DO UPDATE SET tier=$2, chain=$3, tx_hash=$4, expires_at=$5`,
      [req.user!.address, tier, chain, txHash, expiresAt]
    );

    res.json({ txHash, expiresAt, tier });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
