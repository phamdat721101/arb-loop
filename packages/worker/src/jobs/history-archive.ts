import { Job } from 'bullmq';
import pg from 'pg';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const PINATA_JWT = process.env.PINATA_JWT;

export async function historyArchiveProcessor(job: Job) {
  const { userAddress, brainId, messages } = job.data;

  // Archive to IPFS if configured
  if (PINATA_JWT && messages.length > 0) {
    const summary = messages.map((m: any) => `${m.role}: ${m.content.slice(0, 100)}`).join('\n');
    await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PINATA_JWT}` },
      body: JSON.stringify({ pinataContent: { summary, brainId, userAddress, timestamp: Date.now() } }),
    }).catch(() => {});
  }
}
