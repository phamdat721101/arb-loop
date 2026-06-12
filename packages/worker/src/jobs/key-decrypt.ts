import { Job } from 'bullmq';
import pg from 'pg';
import { createDecipheriv } from 'crypto';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const PINATA_GATEWAY = process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud/ipfs';

/**
 * Decrypts brain content using platform's FHE-permitted key access.
 * In production, this calls CoFHE SDK to decrypt the euint128 key handles.
 * For now, key halves are passed directly from the upload flow (pre-decrypted by platform).
 */
export async function keyDecryptProcessor(job: Job) {
  const { brainId, keyHigh, keyLow, ipfsCid } = job.data;

  // Reconstruct AES key from halves
  const key = Buffer.concat([Buffer.from(keyHigh, 'hex'), Buffer.from(keyLow, 'hex')]);

  // Fetch encrypted content from IPFS
  const res = await fetch(`${PINATA_GATEWAY}/${ipfsCid}`);
  if (!res.ok) throw new Error(`IPFS fetch failed: ${res.status}`);
  const encrypted = Buffer.from(await res.arrayBuffer());

  // Decrypt: [12-byte IV][16-byte tag][ciphertext]
  const iv = encrypted.subarray(0, 12);
  const tag = encrypted.subarray(12, 28);
  const data = encrypted.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = decipher.update(data, undefined, 'utf8') + decipher.final('utf8');

  // Chunk and store in Postgres for RAG
  const chunks = chunkText(plaintext, 2000);
  for (let i = 0; i < chunks.length; i++) {
    await db.query(
      `INSERT INTO knowledge_chunks (brain_id, chunk_index, content) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [brainId, i, chunks[i]]
    );
  }
}

function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let current = '';
  for (const p of paragraphs) {
    if ((current + p).length > maxLen && current) {
      chunks.push(current.trim());
      current = p;
    } else {
      current += (current ? '\n\n' : '') + p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}
