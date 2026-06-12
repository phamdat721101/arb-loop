import { pool } from '../db';

const DURATIONS: Record<string, number> = { week: 7, month: 30, quarter: 90 };

export class SubscriptionService {
  static async create(userAddress: string, tier: string, chain: string) {
    const days = DURATIONS[tier];
    const expiresAt = new Date(Date.now() + days * 86400000);
    const txHash = `0x${Buffer.from(Date.now().toString()).toString('hex')}`;

    await pool.query(
      `INSERT INTO subscriptions (user_address, tier, chain, tx_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_address) DO UPDATE SET tier=$2, chain=$3, tx_hash=$4, expires_at=$5`,
      [userAddress, tier, chain, txHash, expiresAt]
    );
    return { txHash, expiresAt };
  }

  static async check(userAddress: string) {
    const { rows } = await pool.query(
      `SELECT tier, expires_at FROM subscriptions WHERE user_address=$1 AND expires_at > NOW()`,
      [userAddress]
    );
    if (!rows[0]) return { active: false, tier: null, expiresAt: null };
    return { active: true, tier: rows[0].tier, expiresAt: rows[0].expires_at };
  }
}
