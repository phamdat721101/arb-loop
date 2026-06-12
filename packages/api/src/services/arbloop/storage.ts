/**
 * storage.ts — mock EigenDA + Arweave clients backed by Postgres for v0.1.
 *
 * Real SDK clients (`@layr/eigenda-client`, `@irys/sdk`) drop in via the
 * factory in `index.ts` when `RUNTIME_STORAGE_MODE=real` (v0.2).
 *
 * SOLID:
 *   - SRP: each class owns one substrate (eigenda OR arweave). Same interface.
 *   - DIP: callers depend on `IEigenDaClient` / `IArweaveClient`, not these.
 *   - LSP: real impls return identical envelope shapes (32-byte hex KZG, 43-char tx-id).
 *   - OCP: switch to real impl = one factory branch.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { randomBytes } from 'crypto';
import type { IEigenDaClient, IArweaveClient } from '@fhe-ai-context/sdk';
import { pool } from '../../db';

const ARWEAVE_TX_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function bytesToHex(b: Uint8Array): string {
  return '0x' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Encode an arbitrary 32 bytes as a deterministic 43-char Arweave-shaped tx-id.
 * Real Arweave tx-ids are URL-safe base64 of 32-byte hashes; this mock matches
 * the character set + length so frontends/typings don't need to know.
 */
function bytesToArweaveId(b: Uint8Array): string {
  let out = '';
  let acc = 0n;
  for (const x of b) acc = (acc << 8n) | BigInt(x);
  while (out.length < 43) {
    out += ARWEAVE_TX_CHARS[Number(acc % 64n)];
    acc /= 64n;
    if (acc === 0n) {
      // Pad with seeded characters from the original bytes
      const seed = b[out.length % b.length] ?? 0;
      out += ARWEAVE_TX_CHARS[seed & 63];
    }
  }
  return out.slice(0, 43);
}

// ─── EigenDA mock ─────────────────────────────────────────────────────────

export class MockEigenDaClient implements IEigenDaClient {
  async put(blob: Uint8Array): Promise<string> {
    // Real EigenDA returns a KZG commitment; we use keccak256(blob) as the
    // deterministic 32-byte hex stand-in. Real clients return the same shape.
    const kzg = bytesToHex(keccak_256(blob));
    await pool.query(
      `INSERT INTO arbloop_mock_blobs (id, kind, payload)
       VALUES ($1, 'eigenda', $2)
       ON CONFLICT (id) DO NOTHING`,
      [kzg, Buffer.from(blob)],
    );
    return kzg;
  }

  async fetch(kzg: string): Promise<Uint8Array> {
    const r = await pool.query(
      `SELECT payload FROM arbloop_mock_blobs WHERE id = $1 AND kind = 'eigenda'`,
      [kzg],
    );
    if (r.rowCount === 0) throw new Error(`eigenda:not_found:${kzg}`);
    return new Uint8Array(r.rows[0].payload as Buffer);
  }
}

// ─── Arweave mock (Irys L1 stand-in) ──────────────────────────────────────

export class MockArweaveClient implements IArweaveClient {
  async put(bundle: Uint8Array): Promise<string> {
    // Real Arweave/Irys returns a 43-char base64url tx-id; we generate one
    // deterministically from a content-hash + a random salt to mirror
    // pay-once-store-forever semantics (each upload is a new tx).
    const salt = randomBytes(8);
    const composite = new Uint8Array(bundle.length + salt.length);
    composite.set(bundle, 0);
    composite.set(salt, bundle.length);
    const txId = bytesToArweaveId(keccak_256(composite));
    await pool.query(
      `INSERT INTO arbloop_mock_blobs (id, kind, payload)
       VALUES ($1, 'arweave', $2)
       ON CONFLICT (id) DO NOTHING`,
      [txId, Buffer.from(bundle)],
    );
    return txId;
  }

  async fetch(txId: string): Promise<Uint8Array> {
    const r = await pool.query(
      `SELECT payload FROM arbloop_mock_blobs WHERE id = $1 AND kind = 'arweave'`,
      [txId],
    );
    if (r.rowCount === 0) throw new Error(`arweave:not_found:${txId}`);
    return new Uint8Array(r.rows[0].payload as Buffer);
  }
}
