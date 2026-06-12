import crypto from 'crypto';
import { pool } from '../db';

/**
 * bundleService — issue + verify BundlePrompt manifests.
 *
 * v1 signs with HMAC-SHA256 (same family as paymentGate challenges) for
 * deploy simplicity. Real-prod upgrade to ed25519 (`tweetnacl` already in
 * the dep tree) is a one-function swap of `signBody`/`verifyBody`; the
 * signature field is a string, schema unchanged.
 */

export interface BundleStep {
  agent_id: string;
  endpoint: string;
  rail: 'x402' | 'mpp' | 'sui_usdc';
  price_usdc: string;
  estimated_calls: number;
  description?: string;
}

export interface BundleManifestBody {
  id: string;                       // bundle:0x… (sha256 of canonical body)
  issuer: string;
  steps: BundleStep[];
  aggregate_price_usdc: string;
  expires_at: number;               // unix-ms
  metadata?: Record<string, unknown>;
}

export interface BundleManifest extends BundleManifestBody {
  signature: string;
}

const BUNDLE_SECRET = process.env.BUNDLE_SECRET ?? process.env.PAYMENT_SECRET ?? 'dev-only-bundle-secret';
const ISSUER = process.env.BUNDLE_ISSUER ?? 'openx.market';

function canonical(body: BundleManifestBody): string {
  // Stable JSON: sort top-level keys, then steps already in array order.
  return JSON.stringify(body, Object.keys(body).sort());
}

function signBody(body: BundleManifestBody): string {
  return crypto.createHmac('sha256', BUNDLE_SECRET).update(canonical(body)).digest('base64url');
}

function bundleId(body: Omit<BundleManifestBody, 'id'>): string {
  const c = JSON.stringify(body, Object.keys(body).sort());
  return 'bundle:0x' + crypto.createHash('sha256').update(c).digest('hex').slice(0, 32);
}

export interface IssueBundleInput {
  steps: BundleStep[];
  ttl_ms?: number;
  metadata?: Record<string, unknown>;
}

export async function issueBundle(input: IssueBundleInput): Promise<BundleManifest> {
  if (!input.steps?.length) throw new Error('bundleService:steps:required');
  const aggregate = input.steps
    .reduce((acc, s) => acc + Number(s.price_usdc) * (s.estimated_calls || 1), 0)
    .toFixed(6)
    .replace(/\.?0+$/, '');
  const expires_at = Date.now() + (input.ttl_ms ?? 24 * 60 * 60 * 1000);
  const partial = {
    issuer: ISSUER,
    steps: input.steps,
    aggregate_price_usdc: aggregate,
    expires_at,
    metadata: input.metadata ?? {},
  };
  const id = bundleId(partial);
  const body: BundleManifestBody = { id, ...partial };
  const signature = signBody(body);
  const manifest: BundleManifest = { ...body, signature };

  await pool.query(
    `INSERT INTO bundles (id, issuer, body, signature, expires_at)
     VALUES ($1, $2, $3::jsonb, $4, to_timestamp($5 / 1000.0))
     ON CONFLICT (id) DO NOTHING`,
    [id, ISSUER, JSON.stringify(body), signature, expires_at],
  );
  return manifest;
}

export function verifyManifest(manifest: BundleManifest): { ok: true } | { ok: false; reason: string } {
  if (!manifest?.signature) return { ok: false, reason: 'missing-signature' };
  if (manifest.expires_at < Date.now()) return { ok: false, reason: 'expired' };
  const { signature, ...body } = manifest;
  const expected = signBody(body);
  if (signature !== expected) return { ok: false, reason: 'signature-mismatch' };
  return { ok: true };
}

export async function getBundle(id: string): Promise<BundleManifest | null> {
  const r = await pool.query(`SELECT id, body, signature FROM bundles WHERE id = $1`, [id]);
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return { ...(row.body as BundleManifestBody), signature: row.signature };
}
