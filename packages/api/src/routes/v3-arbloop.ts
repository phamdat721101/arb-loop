/**
 * routes/v3-arbloop.ts — HTTP API surface for the arb-loop marketplace.
 *
 * SOLID:
 *   - SRP: routes only. Service logic lives in services/arbloop/*.
 *   - DIP: services injected via factory; routes don't construct clients.
 *   - Feature-gate: every route returns 404 when FEATURE_ARBLOOP=false.
 */

import { Router, type Request, type Response } from 'express';
import { Contract, Interface, JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { parseLoopManifest } from '@fhe-ai-context/sdk';
import { pool } from '../db';
import {
  createArbLoopRuntime,
  type ArbLoopRuntime,
} from '../services/arbloop';
import { x402Middleware } from '../middleware/x402';
import { conciergeSearch } from '../services/arbloop/conciergeService';
import { AgentInvoker } from '../services/arbloop/agentInvoker';
import { loadFheGatewayFromEnv, loadPinataFromEnv } from '../services/arbloop/fheGateway';

const router = Router();

function isEnabled(): boolean {
  // v0.0 simple ship: arb-loop is the product. Default ON; explicit 'false'
  // is the rollback knob (preserves byte-identical heavy-v0.1 fallback).
  return process.env.FEATURE_ARBLOOP !== 'false';
}

let cachedRuntime: ArbLoopRuntime | null = null;
function runtime(): ArbLoopRuntime {
  if (!cachedRuntime) cachedRuntime = createArbLoopRuntime();
  return cachedRuntime;
}

router.use((_req, res, next) => {
  if (!isEnabled()) return res.status(404).json({ error: 'arbloop_disabled' });
  next();
});

// ─── GET /v3/arbloop/agents ──────────────────────────────────────────────

router.get('/agents', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
    const category = typeof req.query.category === 'string' ? req.query.category : null;
    const params: unknown[] = [limit];
    let where = 'WHERE revoked = FALSE';
    if (category) {
      where += ` AND category = $${params.length + 1}`;
      params.push(category);
    }
    const r = await pool.query(
      `SELECT * FROM arbloop_agents_metadata ${where} ORDER BY published_at DESC LIMIT $1`,
      params,
    );
    res.json({ agents: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'agents_query_failed', detail: String(e) });
  }
});

router.get('/agents/:agentId', async (req: Request, res: Response) => {
  try {
    const agentId = parseInt(req.params.agentId, 10);
    if (!Number.isFinite(agentId)) return res.status(400).json({ error: 'bad_agent_id' });
    // Registry-agnostic lookup: agent_id is unique within a registry version,
    // not across versions. V2 (gasless) supersedes V1 (legacy) for the same
    // on-chain id; tie-break by published_at so the most recent re-publish wins.
    // Optional ?v=1|2 query lets clients pin a specific registry version.
    const versionFilter = typeof req.query.v === 'string' ? Number(req.query.v) : null;
    const sql = versionFilter
      ? `SELECT * FROM arbloop_agents_metadata
          WHERE agent_id = $1 AND agent_registry_version = $2
          ORDER BY published_at DESC LIMIT 1`
      : `SELECT * FROM arbloop_agents_metadata
          WHERE agent_id = $1
          ORDER BY agent_registry_version DESC NULLS LAST, published_at DESC LIMIT 1`;
    const params = versionFilter ? [agentId, versionFilter] : [agentId];
    const r = await pool.query(sql, params);
    if (r.rowCount === 0) return res.status(404).json({ error: 'agent_not_found' });
    res.json({ agent: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'agent_get_failed', detail: String(e) });
  }
});

// ─── GET /v3/arbloop/jobs/:address  /jobs/:address/iterations  /jobs/:address/memory/:level ──

router.get('/jobs/:address', async (req: Request, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT * FROM arbloop_jobs_metadata WHERE job_contract_address = $1`,
      [req.params.address.toLowerCase()],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'job_not_found' });
    res.json({ job: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'job_get_failed', detail: String(e) });
  }
});

router.get('/jobs/:address/iterations', async (req: Request, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT iter_n, encode(attestation_uid, 'hex') AS attestation_uid,
              inference_backend, inference_model_id, amount_paid_micro_usdc,
              iter_completed_at, stop_condition_eval,
              inputs_json->>'answer' AS answer,
              response_ipfs_cid
         FROM arbloop_iteration_log
        WHERE job_contract_address = $1
        ORDER BY iter_n ASC`,
      [req.params.address.toLowerCase()],
    );
    const rows = r.rows.map((row) => ({
      ...row,
      attestation_uid: '0x' + row.attestation_uid,
    }));
    res.json({ iterations: rows });
  } catch (e) {
    res.status(500).json({ error: 'iterations_get_failed', detail: String(e) });
  }
});

router.get('/jobs/:address/memory/:level', async (req: Request, res: Response) => {
  try {
    const level = req.params.level;
    const job = req.params.address.toLowerCase();
    let rows: unknown[] = [];
    if (level === 'l1') {
      const r = await pool.query(
        `SELECT iter_n, role, ts_ms FROM arbloop_l1_turns
          WHERE job_contract_address = $1 AND expires_at > now()
          ORDER BY iter_n DESC, turn_idx DESC LIMIT 50`,
        [job],
      );
      rows = r.rows;
    } else if (level === 'l2') {
      const r = await pool.query(
        `SELECT iter_n, ts_ms FROM arbloop_l2_episodes
          WHERE job_contract_address = $1 ORDER BY iter_n DESC LIMIT 50`,
        [job],
      );
      rows = r.rows;
    } else if (level === 'l4') {
      // L4 lives on Arweave + JobMemoryNamespace pointer; surface only the
      // pointer + summary metadata. Full decryption requires the buyer's key.
      const r = await pool.query(
        `SELECT job_memory_namespace_address FROM arbloop_jobs_metadata
          WHERE job_contract_address = $1`,
        [job],
      );
      rows = r.rows;
    } else {
      return res.status(400).json({ error: 'bad_level' });
    }
    res.json({ level, count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ error: 'memory_get_failed', detail: String(e) });
  }
});

// ─── GET /v3/arbloop/buyer/:address/jobs ─────────────────────────────────
//
// Studio buyer portfolio: every loop the wallet has hired, newest first.
// One indexed scan on arbloop_jobs_metadata + a LATERAL join for the most
// recent iter row (latency proxy + last-seen backend). Address is lowercased
// to match the storage convention used by every other job route.
router.get('/buyer/:address/jobs', async (req: Request, res: Response) => {
  try {
    const buyer = String(req.params.address ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(buyer)) {
      return res.status(400).json({ error: 'bad_address' });
    }
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
    const r = await pool.query(
      `SELECT j.job_contract_address,
              j.agent_id,
              j.agent_registry_address,
              j.status,
              j.iterations_done,
              j.max_iterations,
              j.spent_micro_usdc,
              j.budget_micro_usdc,
              j.created_at,
              j.last_iter_at,
              j.completed_at,
              a.title              AS agent_title,
              a.short_description  AS agent_short_description,
              latest.inference_backend AS last_backend,
              latest.iter_completed_at AS last_iter_completed_at
         FROM arbloop_jobs_metadata j
         LEFT JOIN arbloop_agents_metadata a
                ON a.agent_id = j.agent_id
               AND (a.agent_registry_address = j.agent_registry_address
                    OR a.agent_registry_address IS NULL)
         LEFT JOIN LATERAL (
              SELECT inference_backend, iter_completed_at
                FROM arbloop_iteration_log il
               WHERE il.job_contract_address = j.job_contract_address
               ORDER BY iter_n DESC LIMIT 1
         ) latest ON TRUE
        WHERE LOWER(j.buyer_address) = $1
        ORDER BY j.created_at DESC
        LIMIT $2`,
      [buyer, limit],
    );
    res.json({ jobs: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'buyer_jobs_failed', detail: String(e) });
  }
});

// ─── GET /v3/arbloop/seller/:address/jobs ────────────────────────────────
//
// Studio seller "Hires" panel: every job that hired one of this wallet's
// published agents, newest first. Earnings are computed in the SQL itself
// (sum of amount_paid_micro_usdc × seller_bps / 10000 across all iters)
// so the frontend only needs to format. Default seller_bps = 7000 (70%);
// per-agent overrides will live in arbloop_agents_metadata.splits later.
router.get('/seller/:address/jobs', async (req: Request, res: Response) => {
  try {
    const seller = String(req.params.address ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(seller)) {
      return res.status(400).json({ error: 'bad_address' });
    }
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
    const r = await pool.query(
      `SELECT j.job_contract_address,
              j.agent_id,
              j.agent_registry_address,
              j.buyer_address,
              j.status,
              j.iterations_done,
              j.max_iterations,
              j.spent_micro_usdc,
              j.budget_micro_usdc,
              j.created_at,
              j.last_iter_at,
              j.completed_at,
              a.title              AS agent_title,
              a.short_description  AS agent_short_description,
              -- Seller's earned cut so far. 70% default; overrideable later
              -- by reading the job's manifest. Computed on the fly so we
              -- never store derived state.
              COALESCE((
                SELECT SUM((amount_paid_micro_usdc::numeric * 7000) / 10000)::bigint
                  FROM arbloop_iteration_log il
                 WHERE il.job_contract_address = j.job_contract_address
              ), 0)::text          AS earned_micro_usdc
         FROM arbloop_jobs_metadata j
         LEFT JOIN arbloop_agents_metadata a
                ON a.agent_id = j.agent_id
               AND (a.agent_registry_address = j.agent_registry_address
                    OR a.agent_registry_address IS NULL)
        WHERE LOWER(a.seller_address) = $1
        ORDER BY j.created_at DESC
        LIMIT $2`,
      [seller, limit],
    );
    res.json({ jobs: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'seller_jobs_failed', detail: String(e) });
  }
});

// ─── /v3/arbloop/jobs/:address/change-requests (GET, POST) ───────────────
//
// Off-chain message thread bound to a job. Auth model: caller proves a
// wallet via `x-wallet-address` (same lightweight pattern the seller
// dashboard uses). The route loads the job's buyer/seller from
// arbloop_jobs_metadata + arbloop_agents_metadata; the caller must be one
// of them, else 403. Direction is derived server-side — clients cannot
// spoof it. Body is server-validated to ≤2000 chars (the migration's
// CHECK is the second line of defence).
function lower(x: unknown): string {
  return typeof x === 'string' ? x.toLowerCase() : '';
}

async function loadJobParticipants(
  jobAddress: string,
): Promise<{ buyer: string; seller: string } | null> {
  const r = await pool.query(
    `SELECT j.buyer_address, a.seller_address
       FROM arbloop_jobs_metadata j
       LEFT JOIN arbloop_agents_metadata a
              ON a.agent_id = j.agent_id
             AND (a.agent_registry_address = j.agent_registry_address
                  OR a.agent_registry_address IS NULL)
      WHERE j.job_contract_address = $1
      LIMIT 1`,
    [jobAddress],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  if (!row.buyer_address || !row.seller_address) return null;
  return { buyer: lower(row.buyer_address), seller: lower(row.seller_address) };
}

router.get('/jobs/:address/change-requests', async (req: Request, res: Response) => {
  try {
    const job = lower(req.params.address);
    if (!/^0x[0-9a-f]{40}$/.test(job)) return res.status(400).json({ error: 'bad_address' });
    const caller = lower(req.header('x-wallet-address'));
    if (!/^0x[0-9a-f]{40}$/.test(caller)) return res.status(401).json({ error: 'missing_wallet' });
    const parts = await loadJobParticipants(job);
    if (!parts) return res.status(404).json({ error: 'job_not_found' });
    if (caller !== parts.buyer && caller !== parts.seller) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const r = await pool.query(
      `SELECT id, job_contract_address, body, direction, sender_address, created_at
         FROM arbloop_change_requests
        WHERE job_contract_address = $1
        ORDER BY created_at ASC
        LIMIT 200`,
      [job],
    );
    res.json({ requests: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'change_requests_get_failed', detail: String(e) });
  }
});

router.post('/jobs/:address/change-requests', async (req: Request, res: Response) => {
  try {
    const job = lower(req.params.address);
    if (!/^0x[0-9a-f]{40}$/.test(job)) return res.status(400).json({ error: 'bad_address' });
    const caller = lower(req.header('x-wallet-address'));
    if (!/^0x[0-9a-f]{40}$/.test(caller)) return res.status(401).json({ error: 'missing_wallet' });
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'empty_body' });
    if (body.length > 2000) return res.status(400).json({ error: 'body_too_long' });

    const parts = await loadJobParticipants(job);
    if (!parts) return res.status(404).json({ error: 'job_not_found' });

    let direction: 'buyer_to_seller' | 'seller_to_buyer';
    if (caller === parts.buyer) direction = 'buyer_to_seller';
    else if (caller === parts.seller) direction = 'seller_to_buyer';
    else return res.status(403).json({ error: 'forbidden' });

    const r = await pool.query(
      `INSERT INTO arbloop_change_requests
         (job_contract_address, buyer_address, seller_address, sender_address, direction, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, job_contract_address, body, direction, sender_address, created_at`,
      [job, parts.buyer, parts.seller, caller, direction, body],
    );
    res.status(201).json({ request: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'change_request_post_failed', detail: String(e) });
  }
});

// ─── POST /v3/arbloop/agents/publish ─────────────────────────────────────
// Seller submits manifest YAML + metadata; relayer uploads to mock EigenDA
// and calls AgentRegistry.publishAgent on-chain. Seller pays no gas.

const AGENT_REGISTRY_ABI_FRAGMENT = [
  'function publishAgent(bytes32 manifestEigenKzg, bytes32 manifestArweaveTxId, string defaultBackend, string defaultModel, uint256 perIterMin, uint256 perIterDefault, uint256 maxIter) external returns (uint256)',
  'event AgentPublished(uint256 indexed agentId, address indexed seller, bytes32 manifestEigenKzg, bytes32 manifestArweaveTxId, address personaNamespaceAddress)',
];

const AGENT_REGISTRY_V2_ABI_FRAGMENT = [
  'function publishAgentFor(address seller, bytes32 manifestIpfsCid, string defaultBackend, string defaultModel, uint256 perIterMin, uint256 perIterDefault, uint256 maxIter, uint256 deadline, uint256 nonce, bytes sellerSig) external returns (uint256)',
  'event AgentPublished(uint256 indexed agentId, address indexed seller, bytes32 manifestIpfsCid, address personaNamespaceAddress)',
];

router.post('/agents/publish', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const required = ['seller_address', 'title', 'manifest_yaml', 'per_iter_default_micro_usdc', 'max_iter_per_job'];
    for (const k of required) if (!body[k]) return res.status(400).json({ error: `missing:${k}` });

    // ─── v0.0 simple gasless branch ───────────────────────────────────────
    // When FEATURE_ARBLOOP_GASLESS_PUBLISH=true AND seller_signature provided,
    // route through AgentRegistryV2.publishAgentFor so on-chain
    // agents[id].seller is the recovered signer (fixes Drift #2).
    if (
      process.env.FEATURE_ARBLOOP_GASLESS_PUBLISH === 'true'
      && typeof body.seller_signature === 'string'
      && typeof body.publish_nonce !== 'undefined'
      && typeof body.publish_deadline !== 'undefined'
    ) {
      try {
        const manifestObj = yaml.load(body.manifest_yaml) as unknown;
        const manifest = parseLoopManifest(manifestObj);
        const rt = runtime();
        const manifestBytes = Buffer.from(body.manifest_yaml, 'utf8');
        // ─── On-chain reference is content-addressable SHA-256(manifest_yaml).
        //     The FRONTEND signs this same value over EIP-712 PublishAgent —
        //     the contract's ECDSA.recover() will only equal `seller` when both
        //     sides feed the SAME bytes32 into the typed-data digest. Using a
        //     Pinata CID truncation here breaks that invariant (BadSignature).
        const cidBytes32 = '0x' + createHash('sha256').update(manifestBytes).digest('hex');
        // ─── Pinata upload is a separate off-chain concern: best-effort, only
        //     drives the `manifest_ipfs_cid` DB column for retrieval. Pinata
        //     downtime no longer breaks the publish flow.
        let manifestIpfsCid = '';
        try {
          const pinata = loadPinataFromEnv();
          manifestIpfsCid = await pinata.put(manifestBytes, `agent-manifest-${Date.now()}.yaml`);
        } catch {
          try { manifestIpfsCid = await rt.eigenDa.put(manifestBytes); } catch { /* both unavailable */ }
        }

        const registryV2Addr = process.env.ARBLOOP_AGENT_REGISTRY_V2_ADDRESS ?? '';
        const rpcUrl = process.env.ARBITRUM_SEPOLIA_RPC ?? process.env.RPC_URL_ARBITRUM_SEPOLIA ?? '';
        const relayerKey = process.env.RELAYER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? '';
        if (!registryV2Addr || !rpcUrl || !relayerKey) {
          return res.status(503).json({ error: 'arbloop_v2_env_incomplete' });
        }
        const provider = new JsonRpcProvider(rpcUrl);
        const relayer = new Wallet(relayerKey, provider);
        const registry = new Contract(registryV2Addr, AGENT_REGISTRY_V2_ABI_FRAGMENT, relayer);
        const tx = await registry.publishAgentFor(
          getAddress(body.seller_address),
          cidBytes32,
          body.default_inference_backend ?? 'bedrock',
          body.default_model_id ?? manifest.iteration.inference.model_id,
          BigInt(body.per_iter_min_micro_usdc ?? body.per_iter_default_micro_usdc),
          BigInt(body.per_iter_default_micro_usdc),
          BigInt(body.max_iter_per_job),
          BigInt(body.publish_deadline),
          BigInt(body.publish_nonce),
          body.seller_signature,
        );
        const receipt = await tx.wait();
        let agentId: number | null = null;
        let personaNamespace: string | null = null;
        for (const log of receipt?.logs ?? []) {
          try {
            const parsed = new Interface(AGENT_REGISTRY_V2_ABI_FRAGMENT).parseLog(log as never);
            if (parsed?.name === 'AgentPublished') {
              agentId = Number(parsed.args.agentId);
              personaNamespace = parsed.args.personaNamespaceAddress as string;
              break;
            }
          } catch { /* not our event */ }
        }
        if (agentId === null) return res.status(500).json({ error: 'agent_published_event_missing' });

        const mode: 'x402' | 'loop' =
          (manifest.stop_condition.fallback_max_iterations === 1 && !(manifest.metadata.tags ?? []).includes('requires_memory'))
            ? 'x402' : 'loop';

        await pool.query(
          `INSERT INTO arbloop_agents_metadata
             (agent_registry_address, agent_id, seller_address,
              manifest_ipfs_cid, agent_registry_version, mode,
              default_inference_backend, default_model_id,
              per_iter_default_micro_usdc, per_iter_min_micro_usdc, max_iter_per_job,
              category, tags, title, short_description, persona_namespace_address)
           VALUES ($1,$2,$3,$4,2,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (agent_registry_address, agent_id) DO NOTHING`,
          [
            registryV2Addr.toLowerCase(),
            agentId,
            body.seller_address.toLowerCase(),
            manifestIpfsCid,
            mode,
            body.default_inference_backend ?? 'bedrock',
            body.default_model_id ?? manifest.iteration.inference.model_id,
            body.per_iter_default_micro_usdc,
            body.per_iter_min_micro_usdc ?? body.per_iter_default_micro_usdc,
            body.max_iter_per_job,
            manifest.metadata.category,
            manifest.metadata.tags,
            body.title,
            body.short_description ?? null,
            personaNamespace?.toLowerCase() ?? '',
          ],
        );

        return res.json({
          agent_id: agentId,
          tx_hash: receipt?.hash,
          persona_namespace_address: personaNamespace,
          manifest_ipfs_cid: manifestIpfsCid,
          agent_registry_version: 2,
          mode,
          gas_paid_by: 'relayer',
        });
      } catch (e) {
        return res.status(500).json({ error: 'gasless_publish_failed', detail: String(e) });
      }
    }

    // ─── Legacy v0.1 publish flow (fallthrough) ──────────────────────────

    // 1. Validate manifest via Zod
    const manifestObj = yaml.load(body.manifest_yaml) as unknown;
    const manifest = parseLoopManifest(manifestObj);

    // 2. Upload to mock EigenDA + mock Arweave
    const rt = runtime();
    const manifestBytes = Buffer.from(body.manifest_yaml, 'utf8');
    const eigenKzg = await rt.eigenDa.put(manifestBytes);
    const arweaveTxId = await rt.arweave.put(manifestBytes);
    const arweaveBytes32 = '0x' + Buffer.from(arweaveTxId, 'utf8').slice(0, 32).toString('hex').padEnd(64, '0');

    // 3. Call AgentRegistry.publishAgent via runner wallet
    const registryAddr = process.env.ARBLOOP_AGENT_REGISTRY_ADDRESS ?? '';
    const rpcUrl = process.env.ARBITRUM_SEPOLIA_RPC ?? '';
    const runnerKey = process.env.RELAYER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? '';
    if (!registryAddr || !rpcUrl || !runnerKey) {
      return res.status(503).json({ error: 'arbloop_env_incomplete' });
    }
    const provider = new JsonRpcProvider(rpcUrl);
    const runner = new Wallet(runnerKey, provider);
    const registry = new Contract(registryAddr, AGENT_REGISTRY_ABI_FRAGMENT, runner);
    const tx = await registry.publishAgent(
      eigenKzg,
      arweaveBytes32,
      body.default_inference_backend ?? 'phala-tee',
      body.default_model_id ?? manifest.iteration.inference.model_id,
      BigInt(body.per_iter_min_micro_usdc ?? body.per_iter_default_micro_usdc),
      BigInt(body.per_iter_default_micro_usdc),
      BigInt(body.max_iter_per_job),
    );
    const receipt = await tx.wait();
    let agentId: number | null = null;
    let personaNamespace: string | null = null;
    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = new Interface(AGENT_REGISTRY_ABI_FRAGMENT).parseLog(log as never);
        if (parsed?.name === 'AgentPublished') {
          agentId = Number(parsed.args.agentId);
          personaNamespace = parsed.args.personaNamespaceAddress as string;
          break;
        }
      } catch { /* not our event */ }
    }
    if (agentId === null) return res.status(500).json({ error: 'agent_published_event_missing' });

    // 4. Persist to off-chain index
    await pool.query(
      `INSERT INTO arbloop_agents_metadata
         (agent_registry_address, agent_id, seller_address, manifest_eigen_kzg,
          manifest_arweave_tx_id, default_inference_backend, default_model_id,
          per_iter_default_micro_usdc, per_iter_min_micro_usdc, max_iter_per_job,
          category, tags, title, short_description, persona_namespace_address)
       VALUES ($1, $2, $3, decode($4, 'hex'), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (agent_registry_address, agent_id) DO NOTHING`,
      [
        registryAddr.toLowerCase(),
        agentId,
        body.seller_address.toLowerCase(),
        eigenKzg.replace(/^0x/, ''),
        arweaveTxId,
        body.default_inference_backend ?? 'phala-tee',
        body.default_model_id ?? manifest.iteration.inference.model_id,
        body.per_iter_default_micro_usdc,
        body.per_iter_min_micro_usdc ?? body.per_iter_default_micro_usdc,
        body.max_iter_per_job,
        manifest.metadata.category,
        manifest.metadata.tags,
        body.title,
        body.short_description ?? null,
        personaNamespace?.toLowerCase() ?? '',
      ],
    );

    res.json({
      agent_id: agentId,
      tx_hash: receipt?.hash,
      persona_namespace_address: personaNamespace,
      manifest_eigen_kzg: eigenKzg,
      manifest_arweave_tx_id: arweaveTxId,
    });
  } catch (e) {
    res.status(500).json({ error: 'publish_failed', detail: String(e) });
  }
});

// ─── POST /v3/arbloop/hire/prepare ────────────────────────────────────────
// Returns a prepared transaction set for the MCP host wallet to sign.
// Frontend uses wagmi/viem and doesn't call this — it builds calls inline.

const LOOP_FACTORY_ABI_FRAGMENT = [
  'function create(uint256 agentId, uint256 maxIterations, uint256 budgetMicroUsdc) external returns (address, address)',
];

router.post('/hire/prepare', async (req: Request, res: Response) => {
  try {
    const { agent_id, max_iterations, budget_usdc, buyer_address } = req.body ?? {};
    if (!agent_id || !max_iterations || !budget_usdc || !buyer_address) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const factory = process.env.ARBLOOP_LOOP_JOB_FACTORY_ADDRESS ?? '';
    const usdc = process.env.ARBLOOP_USDC_ADDRESS ?? '';
    const budgetMicro = BigInt(Math.round(parseFloat(budget_usdc) * 1e6));
    const iface = new Interface(LOOP_FACTORY_ABI_FRAGMENT);
    const data = iface.encodeFunctionData('create', [
      BigInt(agent_id),
      BigInt(max_iterations),
      budgetMicro,
    ]);
    res.json({
      step1_approve_usdc: {
        to: usdc,
        data: new Interface([
          'function approve(address spender, uint256 amount) returns (bool)',
        ]).encodeFunctionData('approve', [factory, budgetMicro]),
        chainId: 421614,
      },
      step2_create_loop: {
        to: factory,
        data,
        chainId: 421614,
      },
      from: buyer_address,
      estimated_cost_usdc: budget_usdc,
    });
  } catch (e) {
    res.status(500).json({ error: 'hire_prepare_failed', detail: String(e) });
  }
});

// ─── POST /v3/arbloop/checkpoints/prepare-approve ─────────────────────────

router.post('/checkpoints/prepare-approve', async (req: Request, res: Response) => {
  try {
    const { job_address, iter_n } = req.body ?? {};
    if (!job_address || iter_n === undefined) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const cp = process.env.ARBLOOP_CHECKPOINT_APPROVAL_ADDRESS ?? '';
    const data = new Interface([
      'function approve(address jobAddress, uint256 iterN)',
    ]).encodeFunctionData('approve', [job_address, BigInt(iter_n)]);
    res.json({
      transaction: { to: cp, data, chainId: 421614 },
    });
  } catch (e) {
    res.status(500).json({ error: 'checkpoint_prepare_failed', detail: String(e) });
  }
});

// ─── v0.0 simple ship: concierge search + x402 invoke + Permit2 hire ────

router.post('/concierge/search', async (req: Request, res: Response) => {
  try {
    if (process.env.FEATURE_ARBLOOP_CHAT_EXECUTION === 'false') {
      return res.status(404).json({ error: 'concierge_disabled' });
    }
    const message = String(req.body?.message ?? '').slice(0, 1000);
    if (!message) return res.status(400).json({ error: 'missing:message' });
    const result = await conciergeSearch({
      message,
      buyerAddress: req.body?.buyer_address ?? undefined,
      sessionId: req.body?.session_id ?? undefined,
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'concierge_failed', detail: String(e) });
  }
});

// x402 fast-lane invoke. Middleware handles 402 dance + settlement.
router.post('/agents/:agentId/invoke', x402Middleware(), async (req: Request, res: Response) => {
  try {
    const settlement = req.x402Settlement;
    if (!settlement) return res.status(500).json({ error: 'no_settlement_attached' });

    // Resolve agent manifest from off-chain index.
    const r = await pool.query(
      `SELECT agent_id, agent_registry_address, agent_registry_version,
              title, short_description, persona_namespace_address,
              manifest_ipfs_cid, default_model_id, mode, tags, max_iter_per_job
         FROM arbloop_agents_metadata
        WHERE agent_id = $1 LIMIT 1`,
      [settlement.agentId],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'agent_meta_not_found' });
    const meta = r.rows[0];

    // Reject if mode is loop-only (manifest declares requires_memory or N>1).
    if ((meta.mode ?? 'x402') === 'loop') {
      return res.status(400).json({ error: 'agent_requires_loop_mode', code: 'use_compose' });
    }

    // Build a minimal manifest stub for the invoker. v0.1+ will fetch full
    // manifest YAML from Pinata; for v0.0 we construct from the off-chain
    // index columns + body.persona_system_prompt fallback.
    const personaPrompt = String(req.body?.persona_system_prompt ?? meta.short_description ?? meta.title ?? '');
    const wordLimit = Number(req.body?.word_limit ?? 5000);

    const fhe = loadFheGatewayFromEnv();
    const pinata = loadPinataFromEnv();
    const invoker = new AgentInvoker({ fhe, pinata });

    const correlationId = `${settlement.txHash}-${settlement.agentId}`;
    const out = await invoker.invokeAgent({
      agentId: settlement.agentId,
      agentRegistryAddress: meta.agent_registry_address,
      buyerAddress: settlement.payer,
      jobNonce: BigInt(req.body?.job_nonce ?? Date.now()),
      inputs: {
        text: req.body?.text ?? undefined,
        source_doc_ipfs_cid: req.body?.source_doc_ipfs_cid ?? undefined,
        source_doc_aes_key_handle: req.body?.source_doc_aes_key_handle ?? undefined,
        source_doc_iv: req.body?.source_doc_iv ?? undefined,
      },
      manifest: {
        title: meta.title,
        persona_system_prompt: personaPrompt,
        default_model_id: meta.default_model_id,
        word_limit: wordLimit,
      },
      contextV2Address: (process.env.ARBLOOP_CONFIDENTIAL_AI_CONTEXT_V2_ADDRESS ?? '') as `0x${string}`,
      correlationId,
    });

    // Persist to iteration_log for audit (uses iter_n=1 for x402 fast lane).
    await pool.query(
      `INSERT INTO arbloop_iteration_log
         (job_contract_address, iter_n, response_ipfs_cid, enc_result_handle,
          inputs_json, x402_settlement_tx, amount_paid_micro_usdc,
          inference_backend, inference_model_id, iter_completed_at, stop_condition_eval)
       VALUES ($1, 1, $2, decode($3, 'hex'), $4::jsonb, $5, $6, 'bedrock', $7, now(), true)
       ON CONFLICT DO NOTHING`,
      [
        `x402:${settlement.agentId}:${settlement.txHash}`,
        out.responseCid,
        out.encResponseHandle.replace(/^0x/, ''),
        JSON.stringify({ kind: 'x402_one_shot' }),
        settlement.txHash,
        settlement.amountMicroUsdc.toString(),
        meta.default_model_id,
      ],
    ).catch(() => undefined);

    res.json({
      ok: true,
      agent_id: settlement.agentId,
      response_cid: out.responseCid,
      enc_response_handle: out.encResponseHandle,
      enc_response_proof: out.encResponseProof,
      response_iv: out.responseIv,
      response_digest_sha256: out.responseDigestSha256,
      runner_memory_ms: out.runnerMemoryMs,
      settlement_tx: settlement.txHash,
      // Plaintext fallback for buyers when the encrypt-then-IPFS path
      // could not run (privacy infra not yet configured). Set only in
      // that case; encrypted-mode responses omit this field.
      text_response: out.responseText,
    });
  } catch (e) {
    res.status(500).json({ error: 'invoke_failed', detail: String(e) });
  }
});

// ─── Hire confirmation + synchronous mode-B runner ───────────────────────
//
// Closes the post-hire UX gap: buyer signs hire → tx mined → frontend POSTs
// here with `tx_hash` → we (1) parse the JobCreated event, (2) register the
// job in arbloop_jobs_metadata, (3) run inference via the existing llmChat
// dispatcher (Phala→Bedrock→OpenAI fallback), (4) persist the iter row with
// the answer text, (5) best-effort call advanceIterWithSplit so escrow
// releases. Synchronous so the buyer sees the result inside the same HTTP
// roundtrip — no background workers required.
router.post('/jobs/from-tx', async (req: Request, res: Response) => {
  try {
    const { tx_hash, task } = req.body ?? {};
    if (!tx_hash || typeof tx_hash !== 'string') return res.status(400).json({ error: 'missing:tx_hash' });
    const rpcUrl = process.env.ARBITRUM_SEPOLIA_RPC ?? process.env.RPC_URL_ARBITRUM_SEPOLIA ?? '';
    const runnerKey = process.env.RELAYER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? '';
    if (!rpcUrl) return res.status(503).json({ error: 'rpc_not_configured' });
    const provider = new JsonRpcProvider(rpcUrl);

    // 1. Fetch receipt + parse JobCreated.
    const receipt = await provider.getTransactionReceipt(tx_hash);
    if (!receipt) return res.status(404).json({ error: 'tx_not_mined' });

    // Reverted tx → 0 logs and status:0. Replay the call to extract the
    // actual revert reason (MaxIterTooLarge / AgentRevoked / BudgetExceeded /
    // …). Without this the buyer sees the generic 'job_created_event_missing'
    // and has no way to self-diagnose. SOLID — single responsibility added:
    // surface the upstream cause; route's success path is unchanged below.
    if (receipt.status === 0) {
      let detail = 'transaction reverted';
      let code = '';
      try {
        const tx = await provider.getTransaction(tx_hash);
        if (tx) {
          await provider.call({ to: tx.to, from: tx.from, data: tx.data, value: tx.value, blockTag: receipt.blockNumber });
        }
      } catch (e: any) {
        // ethers v6 packs the revert selector in e.data (or e.info.error.data).
        const raw: string =
          (typeof e?.data === 'string' && e.data)
          || e?.info?.error?.data
          || (typeof e?.error?.data === 'string' && e.error.data)
          || '';
        if (raw && raw.startsWith('0x') && raw.length >= 10) code = raw.slice(0, 10);
        // Custom-error selector → human message map (v0.0 LoopJobFactory + LoopJob).
        const ERRORS: Record<string, string> = {
          '0x6ecd216f': 'MaxIterTooLarge — your maxIterations exceeds the agent\'s on-chain max_iter_per_job. Reduce maxIter (try 1) or hire a different agent.',
          '0x6dfd3870': 'AgentRevoked — this agent has been revoked by the seller.',
          '0x38ba9ea3': 'PricingBelowMin — per-iter price below the seller\'s minimum.',
          '0x5ec82351': 'NotSeller — only the seller can perform this action.',
          '0x905e7107': 'AlreadyRevoked — agent was already revoked.',
          '0x50b2c4e1': 'BudgetExceeded — budget is too small for the requested iterations.',
          '0x5cd5d233': 'BadSignature — EIP-712 signature did not recover the expected signer.',
        };
        detail = (code && ERRORS[code])
          || e?.reason
          || e?.shortMessage
          || (raw ? `revert ${raw.slice(0, 18)}…` : 'execution reverted (unknown custom error)');
      }
      return res.status(400).json({ error: 'hire_tx_reverted', detail, selector: code || undefined });
    }

    const factoryAbi = new Interface([
      'event JobCreated(address indexed buyer, address indexed agentRegistryAddr, uint256 indexed agentId, bytes32 manifestEigenKzg, address jobAddress, address jobMemoryNamespace, uint256 budgetMicroUsdc, uint256 maxIterations)',
    ]);
    let evt: ReturnType<typeof factoryAbi.parseLog> | null = null;
    for (const log of receipt.logs) {
      try { const p = factoryAbi.parseLog(log as never); if (p?.name === 'JobCreated') { evt = p; break; } }
      catch { /* not our event */ }
    }
    if (!evt) return res.status(404).json({ error: 'job_created_event_missing', detail: `receipt has ${receipt.logs.length} log(s) but none match LoopJobFactory.JobCreated — wrong factory address?` });

    const jobAddress = String(evt.args.jobAddress).toLowerCase();
    const buyer = String(evt.args.buyer).toLowerCase();
    const agentRegistryAddr = String(evt.args.agentRegistryAddr).toLowerCase();
    const agentId = Number(evt.args.agentId);
    const maxIterations = Number(evt.args.maxIterations);
    const budgetMicroUsdc = String(evt.args.budgetMicroUsdc);
    const namespaceAddr = String(evt.args.jobMemoryNamespace).toLowerCase();
    const manifestEigenKzgHex = String(evt.args.manifestEigenKzg).replace(/^0x/, '');

    // 2. Register the job in arbloop_jobs_metadata (idempotent).
    await pool.query(
      `INSERT INTO arbloop_jobs_metadata
         (job_contract_address, buyer_address, agent_registry_address, agent_id,
          manifest_eigen_kzg,
          status, iterations_done, max_iterations, spent_micro_usdc, budget_micro_usdc,
          job_memory_namespace_address, inference_backend_used, created_at)
       VALUES ($1,$2,$3,$4, decode($5,'hex'), 1, 0, $6, '0', $7, $8, 'bedrock', now())
       ON CONFLICT (job_contract_address) DO NOTHING`,
      [jobAddress, buyer, agentRegistryAddr, agentId, manifestEigenKzgHex, maxIterations, budgetMicroUsdc, namespaceAddr],
    );

    // 3. If iter 1 already exists, return it (idempotent re-call).
    const existing = await pool.query(
      `SELECT iter_n, inputs_json->>'answer' AS answer FROM arbloop_iteration_log
        WHERE job_contract_address = $1 AND iter_n = 1`,
      [jobAddress],
    );
    if ((existing.rowCount ?? 0) > 0) {
      return res.json({
        job_address: jobAddress, buyer, agent_id: agentId, max_iterations: maxIterations,
        iter: { iter_n: 1, answer: existing.rows[0].answer ?? '' },
        already_executed: true,
      });
    }

    // 4. Look up agent persona (registry-agnostic — V2 wins over V1).
    const agentRow = await pool.query(
      `SELECT title, short_description, default_model_id, seller_address
         FROM arbloop_agents_metadata
        WHERE agent_id = $1
        ORDER BY agent_registry_version DESC NULLS LAST, published_at DESC LIMIT 1`,
      [agentId],
    );
    const agent = agentRow.rows[0] ?? {};
    const personaPrompt = String(agent.short_description ?? `You are "${agent.title ?? 'an agent'}". Provide a concise, actionable answer.`);
    const userTask = typeof task === 'string' && task.trim()
      ? task.trim()
      : `Run iteration 1 of your loop for the buyer. Budget: $${(Number(budgetMicroUsdc) / 1e6).toFixed(2)} USDC.`;

    // 5. Inference via existing dispatcher (Phala → Bedrock → OpenAI → mock).
    const { llmChat } = await import('../services/chat');
    const answer = await llmChat(personaPrompt, [{ role: 'user', content: userTask }]);

    // 6. Persist the iter row (answer in inputs_json for retrieval).
    const perIterMicro = String(BigInt(budgetMicroUsdc) / BigInt(Math.max(1, maxIterations)));
    await pool.query(
      `INSERT INTO arbloop_iteration_log
         (job_contract_address, iter_n, attestation_uid, inference_backend, inference_model_id,
          amount_paid_micro_usdc, iter_started_at, iter_completed_at, stop_condition_eval, inputs_json)
       VALUES ($1, 1, decode('00','hex'), 'bedrock', $2, $3, now(), now(), true, $4::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        jobAddress,
        agent.default_model_id ?? 'us.anthropic.claude-opus-4-6-v1',
        perIterMicro,
        JSON.stringify({ kind: 'mode_b_iter', answer, task: userTask }),
      ],
    );

    // 7. Best-effort: call advanceIterWithSplit on-chain to release escrow.
    let advanceTx: string | null = null;
    if (runnerKey && agent.seller_address) {
      try {
        const wallet = new Wallet(runnerKey, provider);
        const loopJob = new Contract(jobAddress, [
          'function advanceIterWithSplit(uint256 iterN, bytes32 attestationUid, uint256 amountPaidMicro, uint8 nextStatus, address sellerAddr, address computeAddr, address platformAddr, uint16 sellerBps, uint16 computeBps, uint16 platformBps)',
        ], wallet);
        const finalStatus = maxIterations === 1 ? 4 /* DONE */ : 1 /* RUNNING */;
        const tx = await loopJob.advanceIterWithSplit(
          1, '0x' + '00'.repeat(32), BigInt(perIterMicro), finalStatus,
          getAddress(agent.seller_address), wallet.address, wallet.address,
          7000, 2500, 500,
        );
        const rc = await tx.wait();
        if (rc?.hash) advanceTx = rc.hash;
        await pool.query(
          `UPDATE arbloop_jobs_metadata SET iterations_done=1, spent_micro_usdc=$1, status=$2 WHERE job_contract_address=$3`,
          [perIterMicro, finalStatus, jobAddress],
        );
      } catch (e) {
        // Escrow stays locked but iter row + answer are persisted — buyer can
        // still see + download the result; cancel later for refund.
        // (Surface the on-chain reason but don't fail the user-facing flow.)
        // eslint-disable-next-line no-console
        console.warn('arbloop:advanceIterWithSplit:failed', String(e).slice(0, 200));
      }
    }

    res.json({
      job_address: jobAddress,
      buyer,
      agent_id: agentId,
      max_iterations: maxIterations,
      iter: { iter_n: 1, answer },
      advance_tx: advanceTx,
    });
  } catch (e) {
    res.status(500).json({ error: 'jobs_from_tx_failed', detail: String(e).slice(0, 240) });
  }
});

// Permit2 single-popup hire prepare. Returns typed-data + spender info.
router.post('/hire/prepare-permit2', async (req: Request, res: Response) => {
  try {
    if (process.env.FEATURE_ARBLOOP_PERMIT2_HIRE !== 'true') {
      return res.status(404).json({ error: 'permit2_hire_disabled' });
    }
    const { agent_id, max_iterations, budget_usdc } = req.body ?? {};
    if (!agent_id || !max_iterations || !budget_usdc) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const factory = process.env.ARBLOOP_LOOP_JOB_FACTORY_ADDRESS ?? '';
    const usdc = process.env.ARBLOOP_USDC_ADDRESS ?? '';
    const budgetMicro = BigInt(Math.round(parseFloat(budget_usdc) * 1e6));
    const chainId = Number(process.env.ARBLOOP_CHAIN_ID ?? 421614);

    res.json({
      // Buyer signs this typed-data via wallet.signTypedData; the resulting
      // sig is passed to LoopJobFactory.createWithPermit2() in one tx.
      permit2_address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      spender: factory,
      token: usdc,
      amount_micro_usdc: budgetMicro.toString(),
      agent_id: Number(agent_id),
      max_iterations: Number(max_iterations),
      chain_id: chainId,
      // Frontend SDK: import { buildPermitTransferFromTypedData } from '@fhe-ai-context/sdk'.
      hint: 'use sdk/arbloop/permit2.buildPermitTransferFromTypedData',
    });
  } catch (e) {
    res.status(500).json({ error: 'permit2_prepare_failed', detail: String(e) });
  }
});

export default router;
