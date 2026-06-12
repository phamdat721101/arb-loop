import { createHash } from 'node:crypto';
import { pool } from '../db';
import { consumeOnboardJti } from '../fhe/permits';
import { enqueueCreateBrain } from './chainOpsQueue';
import { indexAgent } from './discoveryService';

/**
 * sellerPublishService — atomic seller publish.
 *
 * One Postgres transaction: brain INSERT → manifest render → agent INSERT.
 * Returns slug + listing_url + tier-aware knowledge_url + mcp_invoke_snippet
 * so the wizard's success card can deeplink without a second round-trip.
 *
 * SOLID:
 *   - SRP: this module owns "create brain + agent + publish" as one unit.
 *          CRUD on individual resources stays in their existing routes.
 *   - DIP: pool is module-level (matches the rest of services/*); a
 *          transactional client is acquired via pool.connect() so the
 *          INSERTs roll back together on any failure.
 *   - OCP: adding a new manifest field = one validator entry + one renderer
 *          line; the pipeline does not change.
 */

export type Domain =
  | 'marketing'
  | 'finance'
  | 'research'
  | 'engineering'
  | 'generalist'
  | 'other';

export type Tier = 'basic' | 'verified' | 'tee_attested';

export type Rail = 'x402' | 'mpp' | 'sui_usdc' | 'fherc20';

export type Chain =
  | 'arbitrum-sepolia'
  | 'fhenix'
  | 'base-sepolia'
  | 'sui'
  | 'sui-testnet'
  | 'sui-mainnet';

/** Listing kind — PRD-15. v1 = api/brain; v2 adds workflow + skill. */
export type Kind = 'api' | 'workflow' | 'skill' | 'brain';

/** Privacy mode — PRD-16. Auto-detected from connected wallet network or
 *  manually overridden in the wizard. */
export type PrivacyModeStr = 'fhe' | 'seal_walrus' | 'metadata-only' | 'off';
export type PrivacySourceStr = 'auto' | 'manual';

export interface SellerProfileInput {
  display_name?: string;
  bio?: string;
  identity_type?: string;
  identity_handle?: string;
  contact_email?: string;
  support_url?: string;
}

export interface PrivacyInput {
  mode: PrivacyModeStr;
  source: PrivacySourceStr;
  /** Numeric EVM chain id or string Sui chain. Persisted as BIGINT for EVM. */
  chain_id?: number | string;
}

/** Optional inline workflow definition for kind='workflow' publishes.
 *  Stored in cognitive_workflows when present. */
export interface WorkflowInput {
  workflow_key: string;
  name: string;
  description?: string;
  steps: unknown; // JSONB — array of step objects per workflowRunner.ts schema
  default_price_usdc: string;
  author_bps?: number;
  platform_bps?: number;
}

export interface SellerPublishInput {
  title: string;
  short_description: string;
  long_description?: string;
  domain: Domain;
  tags?: string[];
  persona_system_prompt: string;
  persona_tools?: string[];
  pricing_amount_usdc: string;
  pricing_rails: Rail[];
  chain?: Chain;
  slug?: string;
  verification_tier?: Tier;
  /**
   * When true, also expose the `fherc20` (Fhenix confidential-amount) rail
   * at the same price. Reuses the shipped useFherc20Pay + fherc20Verifier
   * stack — no new payment infra.
   */
  accept_private_payment?: boolean;
  /** PRD-15: listing kind. Defaults to 'api'. */
  kind?: Kind;
  /** PRD-15: when kind='workflow', the cognitive_workflows row to upsert. */
  workflow?: WorkflowInput;
  /** PRD-14: optional seller profile to attach on first publish. */
  seller_profile?: SellerProfileInput;
  /** PRD-16: explicit privacy choice from the wizard. When omitted,
   *  defaults to {mode:'fhe', source:'auto'} for back-compat. */
  privacy?: PrivacyInput;
}

export interface SellerPublishResult {
  agent_id: string;
  brain_id: number;
  seller_id: number;
  slug: string;
  domain: Domain;
  kind: Kind;
  verification_tier: Tier;
  chain: Chain;
  privacy_mode: PrivacyModeStr;
  privacy_source: PrivacySourceStr;
  listing_url: string;
  /** Tier-aware deeplink to the post-publish knowledge upload page. */
  knowledge_url: string | null;
  mcp_invoke_snippet: string;
  manifest_yaml: string;
}

const DOMAINS: Domain[] = [
  'marketing',
  'finance',
  'research',
  'engineering',
  'generalist',
  'other',
];

const RAILS: Rail[] = ['x402', 'mpp', 'sui_usdc', 'fherc20'];

const TIERS: Tier[] = ['basic', 'verified', 'tee_attested'];

const KINDS: Kind[] = ['api', 'workflow', 'skill', 'brain'];
const PRIVACY_MODES: PrivacyModeStr[] = ['fhe', 'seal_walrus', 'metadata-only', 'off'];
const PRIVACY_SOURCES: PrivacySourceStr[] = ['auto', 'manual'];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;

const CHAINS: Chain[] = [
  'arbitrum-sepolia',
  'fhenix',
  'base-sepolia',
  'sui',
  'sui-testnet',
  'sui-mainnet',
];

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  );
}

/** Lift a thrown Error to carry an HTTP-style status code. */
function httpErr(message: string, status: number): Error {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  return e;
}

function validate(input: SellerPublishInput): void {
  if (!input.title || input.title.length < 3 || input.title.length > 120) {
    throw httpErr('title must be 3..120 chars', 400);
  }
  if (
    !input.short_description ||
    input.short_description.length < 10 ||
    input.short_description.length > 240
  ) {
    throw httpErr('short_description must be 10..240 chars', 400);
  }
  if (!DOMAINS.includes(input.domain)) {
    throw httpErr(`invalid domain (allowed: ${DOMAINS.join(', ')})`, 400);
  }
  if (input.tags && input.tags.length > 10) {
    throw httpErr('at most 10 tags', 400);
  }
  if (
    !input.persona_system_prompt ||
    input.persona_system_prompt.trim().length < 10
  ) {
    throw httpErr('persona_system_prompt must be ≥10 chars', 400);
  }
  if (input.persona_tools && input.persona_tools.length > 10) {
    throw httpErr('at most 10 persona_tools', 400);
  }
  const amount = Number(input.pricing_amount_usdc);
  if (!(amount > 0 && amount <= 1000)) {
    throw httpErr('pricing_amount_usdc must be in (0, 1000]', 400);
  }
  if (!Array.isArray(input.pricing_rails) || input.pricing_rails.length === 0) {
    throw httpErr('pricing_rails must be non-empty', 400);
  }
  for (const r of input.pricing_rails) {
    if (!RAILS.includes(r)) throw httpErr(`invalid rail: ${r}`, 400);
  }
  if (input.slug !== undefined && !SLUG_RE.test(input.slug)) {
    throw httpErr('slug must match ^[a-z0-9][a-z0-9-]{2,40}$', 400);
  }
  if (input.verification_tier && !TIERS.includes(input.verification_tier)) {
    throw httpErr(`invalid verification_tier (allowed: ${TIERS.join(', ')})`, 400);
  }
  if (input.chain && !CHAINS.includes(input.chain)) {
    throw httpErr(`invalid chain (allowed: ${CHAINS.join(', ')})`, 400);
  }
  const kind: Kind = input.kind ?? 'api';
  if (!KINDS.includes(kind)) {
    throw httpErr(`invalid kind (allowed: ${KINDS.join(', ')})`, 400);
  }
  if (kind === 'workflow' && !input.workflow) {
    throw httpErr('kind=workflow requires a workflow object', 400);
  }
  if (input.privacy) {
    if (!PRIVACY_MODES.includes(input.privacy.mode)) {
      throw httpErr(`invalid privacy.mode (allowed: ${PRIVACY_MODES.join(', ')})`, 400);
    }
    if (!PRIVACY_SOURCES.includes(input.privacy.source)) {
      throw httpErr(`invalid privacy.source (allowed: ${PRIVACY_SOURCES.join(', ')})`, 400);
    }
  }
}

/**
 * Render the canonical YAML manifest. Hash-stable (same input → same hash)
 * so re-publishing without changes produces an idempotent manifest_hash.
 *
 * v2 supports `type: api | workflow | skill | brain`.
 */
function renderManifest(
  input: SellerPublishInput,
  slug: string,
  owner: string,
  pricingRails: Rail[],
  kind: Kind,
): string {
  const tier = input.verification_tier ?? 'basic';
  const tags = (input.tags ?? []).map((t) => `'${t.replace(/'/g, '')}'`).join(', ');
  const tools = (input.persona_tools ?? [])
    .map((t) => `'${t.replace(/'/g, '')}'`)
    .join(', ');
  const rails = pricingRails.map((r) => `'${r}'`).join(', ');
  return [
    `manifest_version: '1.0'`,
    `listing:`,
    `  type: ${kind}`,
    `  slug: ${slug}`,
    `  title: ${JSON.stringify(input.title)}`,
    `  short: ${JSON.stringify(input.short_description)}`,
    `  domain: ${input.domain}`,
    `  tags: [${tags}]`,
    `owner:`,
    `  wallet_address: '${owner}'`,
    `pricing:`,
    `  mode: fixed`,
    `  amount_usdc: '${input.pricing_amount_usdc}'`,
    `  currency: USDC`,
    `  rails: [${rails}]`,
    `verification:`,
    `  tier: ${tier}`,
    `persona:`,
    `  system_prompt: ${JSON.stringify(input.persona_system_prompt)}`,
    `  tools: [${tools}]`,
    ``,
  ].join('\n');
}

/**
 * Tier-aware knowledge upload URL. Standard tier (Fhenix on Arbitrum/Base)
 * routes to /brain; Trustless tier (Sui + Walrus + MemWal) routes to
 * /brain-sui/<id>. Returned in the publish result so the wizard's success
 * card deeplinks without a second round-trip.
 */
function knowledgeUrlFor(chain: Chain, brainId: number, baseUrl: string): string | null {
  if (chain === 'arbitrum-sepolia' || chain === 'fhenix' || chain === 'base-sepolia') {
    return `${baseUrl}/brain?id=${brainId}`;
  }
  if (chain === 'sui' || chain === 'sui-testnet' || chain === 'sui-mainnet') {
    return `${baseUrl}/brain-sui/${brainId}`;
  }
  return null;
}

function mcpInvokeSnippet(slug: string, agentId: string, apiBaseUrl: string): string {
  return [
    `// Pay-per-call from any MCP host (Claude / Cursor / Codex / AgentCash):`,
    `await mcp.call('openx_agent_invoke', {`,
    `  slug: '${slug}',`,
    `  input: { q: 'your question here' },`,
    `});`,
    ``,
    `// Direct HTTP (raw 402 challenge):`,
    `// curl -X POST ${apiBaseUrl}/v3/agents/${agentId}/chat \\`,
    `//   -H 'content-type: application/json' \\`,
    `//   -d '{"message":"your question here"}'`,
  ].join('\n');
}

export async function publish(
  walletAddress: string,
  input: SellerPublishInput,
  opts?: {
    apiBaseUrl?: string;
    /** PRD-18 — when set, single-use jti is consumed atomically inside the
     *  publish transaction. Conflict on jti ⇒ 409 (replay). */
    permitJti?: string | null;
    /** PRD-18 — issuance ceiling (epoch seconds). Defaults to now+15min when
     *  the SDK didn't carry an explicit expiration on the permit blob. */
    permitExpSec?: number;
  },
): Promise<SellerPublishResult> {
  validate(input);

  const owner = walletAddress.toLowerCase();
  const slug = input.slug ?? slugify(input.title);
  const tier: Tier = input.verification_tier ?? 'basic';
  const chain: Chain = input.chain ?? 'arbitrum-sepolia';
  const tags = input.tags ?? [];
  const apiBase = opts?.apiBaseUrl ?? '';
  const kind: Kind = input.kind ?? 'api';

  // PRD-16 — privacy defaults to {fhe, auto} for back-compat. The wizard
  // always passes an explicit privacy block once FEATURE flag is on.
  const privacy: PrivacyInput = input.privacy ?? { mode: 'fhe', source: 'auto' };
  const connectedChainIdNum =
    typeof privacy.chain_id === 'number' ? privacy.chain_id : null;

  // Build pricing JSONB. Every rail starts null; selected rails carry the
  // single price. fherc20 (Fhenix confidential-amount) is opt-in via the
  // accept_private_payment flag OR explicit inclusion in pricing_rails.
  const railsSet = new Set<Rail>(input.pricing_rails);
  if (input.accept_private_payment) railsSet.add('fherc20');
  const railsArr = Array.from(railsSet);
  const pricing: Record<Rail, string | null> = {
    x402: null,
    mpp: null,
    sui_usdc: null,
    fherc20: null,
  };
  for (const r of railsArr) pricing[r] = input.pricing_amount_usdc;

  const persona = {
    system_prompt: input.persona_system_prompt.trim(),
    tools: input.persona_tools ?? [],
  };

  const manifestYaml = renderManifest(input, slug, owner, railsArr, kind);
  const manifestHash = createHash('sha256').update(manifestYaml).digest();

  const workflowRef = kind === 'workflow' ? input.workflow!.workflow_key : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // §0 PRD-18 — single-use onboard permit consumption. Runs FIRST inside
    // the transaction so a replay short-circuits before any writes. Skipped
    // when no jti is supplied (legacy x-wallet-address path).
    if (opts?.permitJti) {
      const expSec = opts.permitExpSec ?? Math.floor(Date.now() / 1000) + 15 * 60;
      const consumed = await consumeOnboardJti(client, opts.permitJti, owner, expSec);
      if (!consumed.ok) throw httpErr('onboard token already used', 409);
    }

    // §1 PRD-14 — find-or-create seller. Idempotent on UNIQUE(wallet_address).
    const sellerRes = await client.query(
      `INSERT INTO sellers (wallet_address, display_name, bio,
                            identity_type, identity_handle,
                            contact_email, support_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
       ON CONFLICT (wallet_address) DO UPDATE SET
         display_name    = COALESCE(EXCLUDED.display_name,    sellers.display_name),
         bio             = COALESCE(EXCLUDED.bio,             sellers.bio),
         identity_type   = COALESCE(EXCLUDED.identity_type,   sellers.identity_type),
         identity_handle = COALESCE(EXCLUDED.identity_handle, sellers.identity_handle),
         contact_email   = COALESCE(EXCLUDED.contact_email,   sellers.contact_email),
         support_url     = COALESCE(EXCLUDED.support_url,     sellers.support_url),
         updated_at      = now()
       RETURNING id`,
      [
        owner,
        input.seller_profile?.display_name ?? owner,
        input.seller_profile?.bio ?? null,
        input.seller_profile?.identity_type ?? null,
        input.seller_profile?.identity_handle ?? null,
        input.seller_profile?.contact_email ?? null,
        input.seller_profile?.support_url ?? null,
      ],
    );
    const sellerId = sellerRes.rows[0].id as number;

    // §2 PRD-15 — when kind='workflow', upsert cognitive_workflows row first
    // so the FK target exists when agents.workflow_ref is written below.
    // For Standard-tier (Fhenix) workflows the sui_object_id / signature
    // fields take placeholder values derived from the manifest hash;
    // Sui-tier workflows overwrite them via the existing /v3/workflows path.
    if (kind === 'workflow' && input.workflow) {
      const wf = input.workflow;
      const manifestHashHex = manifestHash.toString('hex');
      const placeholder = `manifest:${manifestHashHex.slice(0, 32)}`;
      await client.query(
        `INSERT INTO cognitive_workflows
           (workflow_key, author_addr, sui_object_id, manifest_blob_id,
            name, description, steps,
            default_price_usdc, author_bps, platform_bps,
            signer, signature, published)
         VALUES ($1, $2, $3, $4,
                 $5, $6, $7::jsonb,
                 $8, $9, $10,
                 $11, $12, true)
         ON CONFLICT (author_addr, workflow_key) DO UPDATE SET
           name               = EXCLUDED.name,
           description        = EXCLUDED.description,
           steps              = EXCLUDED.steps,
           default_price_usdc = EXCLUDED.default_price_usdc,
           author_bps         = EXCLUDED.author_bps,
           platform_bps       = EXCLUDED.platform_bps,
           published          = true`,
        [
          wf.workflow_key,
          owner,
          placeholder,
          placeholder,
          wf.name,
          wf.description ?? '',
          JSON.stringify(wf.steps),
          wf.default_price_usdc,
          wf.author_bps ?? 9500,
          wf.platform_bps ?? 500,
          owner,
          `0x${manifestHashHex}`,
        ],
      );
    }

    // §3 brain INSERT (existing path; brain is the knowledge backstore for
    // kind='brain'/'api' — for kind='workflow'/'skill' it's still created
    // as a placeholder so existing chat/recall paths keep working).
    const brainRes = await client.query(
      `INSERT INTO brains (owner_address, title, description, tags, published, chain)
       VALUES ($1, $2, $3, $4, true, $5)
       RETURNING id`,
      [owner, input.title, input.long_description ?? input.short_description, tags, chain],
    );
    const brainId = brainRes.rows[0].id as number;

    // §4 agents INSERT — extended with seller_id + kind + workflow_ref
    // + privacy_mode/source/connected_chain_id (PRD-14 + PRD-15 + PRD-16).
    const agentRes = await client.query(
      `INSERT INTO agents (
         brain_id, owner_address, chain, persona, pricing,
         kya_required, min_reputation, published, slug,
         domain, short_description, verification_tier, manifest_yaml, manifest_hash,
         seller_id, kind, workflow_ref,
         privacy_mode, privacy_source, connected_chain_id
       )
       VALUES (
         $1, $2, $3, $4::jsonb, $5::jsonb,
         false, 0, true, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14,
         $15, $16, $17
       )
       RETURNING id`,
      [
        brainId, owner, chain, JSON.stringify(persona), JSON.stringify(pricing),
        slug,
        input.domain, input.short_description, tier, manifestYaml, manifestHash,
        sellerId, kind, workflowRef,
        privacy.mode, privacy.source, connectedChainIdNum,
      ],
    );
    const agentId = agentRes.rows[0].id as string;

    // §5 PRD-19 — gasless on-chain registration. Enqueue a `create_brain`
    // op for the chain-relayer worker to drain. Gated by feature flag +
    // privacy_mode='fhe' + EVM-side chain so we only touch chain when a
    // registry is actually deployed. The enqueue runs INSIDE the publish
    // TX so it commits atomically with brain/agent INSERTs and the jti
    // consume — there is no window where a row exists in agents without
    // a matching queue row (or vice-versa).
    if (
      process.env.FEATURE_GASLESS_ONBOARD === 'true' &&
      privacy.mode === 'fhe' &&
      (chain === 'arbitrum-sepolia' || chain === 'fhenix' || chain === 'base-sepolia')
    ) {
      await enqueueCreateBrain(client, {
        agentId,
        sellerAddress: owner,
        chain,
        brainId,
      });
    }

    await client.query('COMMIT');

    // PRD-17 §4 — best-effort MemWal index. DB row is already persisted;
    // index failure is logged inside indexAgent() and never blocks publish.
    void indexAgent({
      agent_id: agentId,
      slug,
      title: input.title,
      short_description: input.short_description,
      domain: input.domain,
      kind,
      tags: input.tags,
      persona_system_prompt: input.persona_system_prompt,
    });

    return {
      agent_id: agentId,
      brain_id: brainId,
      seller_id: sellerId,
      slug,
      domain: input.domain,
      kind,
      verification_tier: tier,
      chain,
      privacy_mode: privacy.mode,
      privacy_source: privacy.source,
      listing_url: `${apiBase}/agent/${slug}`,
      knowledge_url: knowledgeUrlFor(chain, brainId, apiBase),
      mcp_invoke_snippet: mcpInvokeSnippet(slug, agentId, apiBase),
      manifest_yaml: manifestYaml,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    const err = e as { code?: string; constraint?: string; message?: string };
    if (
      err?.code === '23505' &&
      /agents_slug_key|agents_slug/.test(String(err?.constraint ?? err?.message ?? ''))
    ) {
      throw httpErr('slug already taken', 409);
    }
    throw e;
  } finally {
    client.release();
  }
}
