import { Job } from 'bullmq';
import pg from 'pg';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const PINATA_JWT = process.env.PINATA_JWT;

async function pinToIPFS(content: string): Promise<string | null> {
  if (!PINATA_JWT) return null;
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PINATA_JWT}` },
    body: JSON.stringify({ pinataContent: { content } }),
  });
  const data = await res.json() as any;
  return data.IpfsHash || null;
}

export async function ipfsPinProcessor(job: Job) {
  const { brainId, chunks, userAddress } = job.data;
  for (let i = 0; i < chunks.length; i++) {
    const cid = await pinToIPFS(chunks[i]);
    await db.query(
      `INSERT INTO knowledge_chunks (brain_id, chunk_index, content, ipfs_cid) VALUES ($1, $2, $3, $4)`,
      [brainId, i, chunks[i], cid]
    );
  }
}
