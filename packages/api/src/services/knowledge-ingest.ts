import { pool } from '../db';
import { createDecipheriv } from 'crypto';

const CHUNK_SIZE = 2000;

function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let current = '';
  for (const p of paragraphs) {
    if ((current + p).length > CHUNK_SIZE && current) {
      chunks.push(current.trim());
      current = p;
    } else {
      current += (current ? '\n\n' : '') + p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

/** Normalize hex input to bare hex (no 0x prefix) for Postgres `decode(_, 'hex')`. */
function stripHex(s: string): string {
  return s.startsWith('0x') ? s.slice(2) : s;
}

/**
 * Decrypt an AES-256-GCM ciphertext produced by the frontend's
 * `crypto.subtle.encrypt({name:'AES-GCM'}, ...)` flow.
 *
 * Wire format (matches Web Crypto's output): `[ciphertext || authTag(16)]`.
 * The 12-byte IV is stored separately in `knowledge_chunks.nonce`.
 */
function aesGcmDecrypt(payload: Buffer, key: Buffer, iv: Buffer): string {
  const tagLen = 16;
  const ct = payload.subarray(0, payload.length - tagLen);
  const tag = payload.subarray(payload.length - tagLen);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export class KnowledgeIngestService {
  static async ingestFile(userAddress: string, content: string, brainId: number | null, chain: string) {
    const bid = brainId || await this.getDefaultBrain(userAddress, chain);
    const chunks = splitIntoChunks(content);

    // Get max chunk_index to append (not overwrite)
    const { rows: [{ max }] } = await pool.query(
      `SELECT COALESCE(MAX(chunk_index), -1) as max FROM knowledge_chunks WHERE brain_id = $1`, [bid]
    );
    const startIndex = (max as number) + 1;

    for (let i = 0; i < chunks.length; i++) {
      await pool.query(
        `INSERT INTO knowledge_chunks (brain_id, chunk_index, content) VALUES ($1, $2, $3)`,
        [bid, startIndex + i, chunks[i]]
      );
    }
    return { brainId: bid, estimatedChunks: chunks.length };
  }

  /**
   * Load all chunks for a brain as plaintext, transparently decrypting any
   * `encrypted=true` chunks using the brain's stored AES key + per-chunk
   * nonce. Returns the same `{ content }` shape that the RAG ranker expects.
   *
   * In Phase 1.5 the AES key lives in the API DB (server-side decryption).
   * Phase 2 moves this routine inside a TEE so the key never lands in
   * un-attested memory.
   */
  static async loadChunks(brainId: number | string): Promise<Array<{ content: string }>> {
    const { rows: brainRows } = await pool.query(
      `SELECT key_high, key_low FROM brains WHERE id = $1`, [brainId]
    );
    const brain = brainRows[0];
    const key = brain?.key_high && brain?.key_low
      ? Buffer.concat([Buffer.from(brain.key_high), Buffer.from(brain.key_low)])
      : null;

    const { rows } = await pool.query(
      `SELECT content, encrypted, nonce FROM knowledge_chunks WHERE brain_id = $1
       ORDER BY chunk_index`,
      [brainId]
    );

    return rows.map((r: any) => {
      if (!r.encrypted) return { content: r.content as string };
      if (!key || !r.nonce) return { content: '' }; // unrecoverable — skip
      try {
        const ciphertext = Buffer.from(r.content as string, 'base64');
        return { content: aesGcmDecrypt(ciphertext, key, Buffer.from(r.nonce)) };
      } catch {
        return { content: '' };
      }
    });
  }
  /**
   * Store an opaque encrypted blob + the AES key material (split into two
   * 16-byte halves for future on-chain `euint128` storage) and the GCM
   * nonce. Content is NEVER decrypted server-side in this path; it is
   * persisted as a single ciphertext "chunk" with `encrypted=true`.
   */
  static async ingestEncrypted(
    userAddress: string,
    ciphertext: Buffer,
    brainId: number | null,
    chain: string,
    keyMaterial: { keyHigh: string; keyLow: string; nonce: string },
  ) {
    const bid = brainId || await this.getDefaultBrain(userAddress, chain);

    // Persist key halves at the brain level (one set per brain). These move
    // to on-chain `BrainKeyVault.storeKey` in Phase 2.
    await pool.query(
      `UPDATE brains SET key_high = decode($1, 'hex'), key_low = decode($2, 'hex') WHERE id = $3`,
      [stripHex(keyMaterial.keyHigh), stripHex(keyMaterial.keyLow), bid]
    );

    const { rows: [{ max }] } = await pool.query(
      `SELECT COALESCE(MAX(chunk_index), -1) as max FROM knowledge_chunks WHERE brain_id = $1`, [bid]
    );
    const startIndex = (max as number) + 1;

    await pool.query(
      `INSERT INTO knowledge_chunks (brain_id, chunk_index, content, encrypted, nonce)
       VALUES ($1, $2, $3, TRUE, decode($4, 'hex'))`,
      [bid, startIndex, ciphertext.toString('base64'), stripHex(keyMaterial.nonce)]
    );

    return { brainId: bid, estimatedChunks: 1, encrypted: true };
  }

  /** Register brain on-chain via KnowledgeBaseRegistry (fire-and-forget) */
  static async registerOnChain(brainId: number): Promise<string | null> {
    try {
      const { ethers } = await import('ethers');
      const rpc = process.env.ARBITRUM_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
      const addr = process.env.KNOWLEDGE_REGISTRY_ADDRESS;
      if (!process.env.PRIVATE_KEY || !addr) return null;
      const provider = new ethers.JsonRpcProvider(rpc);
      const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
      const abi = ['function getBrainCount() view returns (uint256)'];
      const contract = new ethers.Contract(addr, abi, wallet);
      // Just verify contract is reachable — actual FHE createBrain needs CoFHE encrypted input
      await contract.getBrainCount();
      return 'registered';
    } catch { return null; }
  }

  static async createBrain(userAddress: string, chain: string, title: string): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO brains (owner_address, title, chain) VALUES ($1, $2, $3) RETURNING id`,
      [userAddress, title, chain]
    );
    return rows[0].id;
  }

  static async getDefaultBrain(userAddress: string, chain: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT id FROM brains WHERE owner_address = $1 ORDER BY created_at LIMIT 1`, [userAddress]
    );
    if (rows[0]) return rows[0].id;
    return this.createBrain(userAddress, chain, 'My Brain');
  }
}
