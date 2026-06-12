/**
 * evmMemoryService.ts — L1-L5 stratified memory orchestrator (arb-loop).
 *
 * Layers:
 *   L1 — turn-level Postgres KV (24h TTL), Lit-encrypted per buyer key
 *   L2 — episode-level Postgres KV + EigenDA snapshot every 50 entries
 *   L3 — Arweave (seller persona snapshot, public-read policy)
 *   L4 — Arweave (buyer-seller cross-workflow patterns, buyer-encrypted)
 *   L5 — Arweave + EAS attestation (reflective writeback at job completion)
 *
 * SOLID:
 *   - SRP: this class owns "given a job + manifest, read or write memory".
 *     Contract writes are gated by injected ethers Wallet (RUNNER_ROLE).
 *   - DIP: storage clients injected via constructor (no concrete types).
 *   - OCP: adding L6 = one method + one switch arm in dispatchers.
 */

import { Contract, JsonRpcProvider, Wallet, ZeroHash } from 'ethers';
import type {
  IEigenDaClient,
  IArweaveClient,
  ILitEncryption,
  LoopManifest,
  EvmMemoryBinding,
} from '@fhe-ai-context/sdk';
import { pool } from '../../db';
import { EasAttestation } from './easAttestation';

// ─── Minimal ABIs for namespace contract reads/writes ─────────────────────

const JOB_NS_ABI = [
  'function buyer() view returns (address)',
  'function seller() view returns (address)',
  'function agentId() view returns (uint256)',
  'function l4ArweaveTxId() view returns (bytes32)',
  'function l2SnapshotCount() view returns (uint256)',
  'function updateL4ArweaveTxId(bytes32) external',
  'function pushL2Snapshot(bytes32) external',
];

const AGENT_NS_ABI = [
  'function seller() view returns (address)',
  'function agentId() view returns (uint256)',
  'function l3ArweaveTxId() view returns (bytes32)',
  'function l5Count() view returns (uint256)',
  'function publicRead() view returns (bool)',
  'function updateL3ArweaveTxId(bytes32) external',
  'function pushL5Reflection(bytes32, bytes32) external',
];

// ─── Domain types ─────────────────────────────────────────────────────────

export interface TurnSnapshot {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  ts_ms: number;
}

export interface EpisodeEntry {
  iter_n: number;
  summary: string;
  signals: Record<string, unknown>;
  ts_ms: number;
}

export interface L4Pattern {
  pair_traits: Record<string, unknown>;
  entries: Array<{ key: string; value: unknown; confidence: number }>;
  confidence: number;
}

export interface InferenceResultLike {
  text: string;
  inputKzg: string;       // EigenDA KZG of prompt blob
  outputKzg: string;      // EigenDA KZG of response blob
  episodeSummary: string;
  signals?: Record<string, unknown>;
  l4Pattern?: L4Pattern;  // when manifest has write L4 with mode=pattern_extract
}

export interface EvmMemoryServiceDeps {
  rpcUrl: string;
  runnerPrivateKey: string;
  eigenDa: IEigenDaClient;
  arweave: IArweaveClient;
  lit: ILitEncryption;
  eas: EasAttestation;
}

// Convert the 43-char Arweave tx-id to a deterministic bytes32 for on-chain storage.
function arweaveTxIdToBytes32(txId: string): string {
  const buf = Buffer.from(txId, 'utf8');
  // Pad to 32 bytes (truncate if longer; pad with zeros if shorter).
  const out = Buffer.alloc(32);
  buf.copy(out, 0, 0, Math.min(32, buf.length));
  return '0x' + out.toString('hex');
}

const ZERO_ARWEAVE_BYTES32 = ZeroHash;

// ─── Service ──────────────────────────────────────────────────────────────

export class EvmMemoryService {
  private readonly provider: JsonRpcProvider;
  private readonly runner: Wallet;
  private readonly eigenDa: IEigenDaClient;
  private readonly arweave: IArweaveClient;
  private readonly lit: ILitEncryption;
  private readonly eas: EasAttestation;

  constructor(deps: EvmMemoryServiceDeps) {
    this.provider = new JsonRpcProvider(deps.rpcUrl);
    this.runner = new Wallet(deps.runnerPrivateKey, this.provider);
    this.eigenDa = deps.eigenDa;
    this.arweave = deps.arweave;
    this.lit = deps.lit;
    this.eas = deps.eas;
  }

  // ─── Read path ─────────────────────────────────────────────────────────

  async buildMemoryContext(
    jobNamespaceAddr: string,
    agentNamespaceAddr: string,
    manifest: LoopManifest,
  ): Promise<EvmMemoryBinding> {
    const ctx: EvmMemoryBinding = {};
    for (const r of manifest.iteration.memory.read) {
      switch (r.level) {
        case 'L1':
          ctx.l1 = await this.readL1(jobNamespaceAddr, r.window ?? 10);
          break;
        case 'L2':
          ctx.l2 = await this.readL2(jobNamespaceAddr, r.window ?? 50);
          break;
        case 'L3':
          ctx.l3 = await this.readL3(agentNamespaceAddr);
          break;
        case 'L4':
          ctx.l4 = await this.readL4(jobNamespaceAddr, r.filter);
          break;
      }
    }
    return ctx;
  }

  private async readL1(jobNamespaceAddr: string, window: number): Promise<TurnSnapshot[]> {
    const r = await pool.query(
      `SELECT role, content_ciphertext, ts_ms
         FROM arbloop_l1_turns
        WHERE job_contract_address = $1 AND expires_at > now()
        ORDER BY iter_n DESC, turn_idx DESC
        LIMIT $2`,
      [jobNamespaceAddr, window],
    );
    const buyer = await this.getBuyer(jobNamespaceAddr);
    const out: TurnSnapshot[] = [];
    for (const row of r.rows) {
      try {
        const value = (await this.lit.decryptForReader(
          row.content_ciphertext as string,
          buyer,
          'job-memory-l1',
        )) as { content: string };
        out.push({ role: row.role, content: value.content, ts_ms: Number(row.ts_ms) });
      } catch {
        /* skip undecryptable rows (e.g. policy version drift) */
      }
    }
    return out.reverse();
  }

  private async readL2(jobNamespaceAddr: string, window: number): Promise<EpisodeEntry[]> {
    const r = await pool.query(
      `SELECT iter_n, episode_ciphertext, ts_ms
         FROM arbloop_l2_episodes
        WHERE job_contract_address = $1
        ORDER BY iter_n DESC
        LIMIT $2`,
      [jobNamespaceAddr, window],
    );
    const buyer = await this.getBuyer(jobNamespaceAddr);
    const out: EpisodeEntry[] = [];
    for (const row of r.rows) {
      try {
        const value = (await this.lit.decryptForReader(
          row.episode_ciphertext as string,
          buyer,
          'job-memory-l2',
        )) as Omit<EpisodeEntry, 'iter_n' | 'ts_ms'>;
        out.push({
          iter_n: row.iter_n,
          summary: value.summary,
          signals: value.signals ?? {},
          ts_ms: Number(row.ts_ms),
        });
      } catch {
        /* skip */
      }
    }
    return out.reverse();
  }

  private async readL3(agentNamespaceAddr: string): Promise<unknown | null> {
    const ns = new Contract(agentNamespaceAddr, AGENT_NS_ABI, this.provider);
    const txIdBytes32 = (await ns.l3ArweaveTxId()) as string;
    if (txIdBytes32 === ZERO_ARWEAVE_BYTES32) return null;
    const txId = Buffer.from(txIdBytes32.slice(2), 'hex').toString('utf8').replace(/\0+$/, '');
    const ciphertext = await this.arweave.fetch(txId);
    const seller = (await ns.seller()) as string;
    return await this.lit.decryptForReader(
      Buffer.from(ciphertext).toString('utf8'),
      seller,
      'agent-memory-l3-public-read',
    );
  }

  private async readL4(jobNamespaceAddr: string, filter?: string): Promise<L4Pattern | null> {
    const ns = new Contract(jobNamespaceAddr, JOB_NS_ABI, this.provider);
    const txIdBytes32 = (await ns.l4ArweaveTxId()) as string;
    if (txIdBytes32 === ZERO_ARWEAVE_BYTES32) return null;
    const txId = Buffer.from(txIdBytes32.slice(2), 'hex').toString('utf8').replace(/\0+$/, '');
    const ciphertext = await this.arweave.fetch(txId);
    const buyer = await this.getBuyer(jobNamespaceAddr);
    const value = await this.lit.decryptForReader(
      Buffer.from(ciphertext).toString('utf8'),
      buyer,
      'job-memory-l4',
      { filter },
    );
    return value as L4Pattern | null;
  }

  // ─── Write path ────────────────────────────────────────────────────────

  async writeMemory(
    jobNamespaceAddr: string,
    iterN: number,
    result: InferenceResultLike,
    manifest: LoopManifest,
  ): Promise<void> {
    const buyer = await this.getBuyer(jobNamespaceAddr);

    for (const w of manifest.iteration.memory.write) {
      switch (w.level) {
        case 'L1':
          await this.appendL1(jobNamespaceAddr, iterN, buyer, {
            role: 'assistant',
            content: result.text,
            ts_ms: Date.now(),
          });
          break;
        case 'L2':
          await this.appendL2(jobNamespaceAddr, iterN, buyer, {
            iter_n: iterN,
            summary: result.episodeSummary,
            signals: result.signals ?? {},
            ts_ms: Date.now(),
          });
          break;
        case 'L4':
          if (w.mode === 'pattern_extract' && result.l4Pattern && result.l4Pattern.confidence >= 0.7) {
            await this.appendL4(jobNamespaceAddr, buyer, result.l4Pattern);
          }
          break;
      }
    }

    // EigenDA snapshot every 50 L2 entries
    if (iterN > 0 && iterN % 50 === 0) {
      await this.snapshotL2ToEigenDa(jobNamespaceAddr, buyer);
    }
  }

  private async appendL1(
    jobNamespaceAddr: string,
    iterN: number,
    buyer: string,
    snapshot: TurnSnapshot,
  ): Promise<void> {
    const ciphertext = await this.lit.encryptForOwner(
      { content: snapshot.content },
      buyer,
      'job-memory-l1',
    );
    await pool.query(
      `INSERT INTO arbloop_l1_turns
         (job_contract_address, iter_n, turn_idx, role, content_ciphertext, lit_pkp_address, ts_ms)
       VALUES ($1, $2, COALESCE((SELECT COALESCE(MAX(turn_idx), -1) + 1
                                   FROM arbloop_l1_turns
                                  WHERE job_contract_address = $1 AND iter_n = $2), 0),
               $3, $4, $5, $6)
       ON CONFLICT (job_contract_address, iter_n, turn_idx) DO NOTHING`,
      [jobNamespaceAddr, iterN, snapshot.role, ciphertext, buyer, snapshot.ts_ms],
    );
  }

  private async appendL2(
    jobNamespaceAddr: string,
    iterN: number,
    buyer: string,
    episode: EpisodeEntry,
  ): Promise<void> {
    const ciphertext = await this.lit.encryptForOwner(
      { summary: episode.summary, signals: episode.signals },
      buyer,
      'job-memory-l2',
    );
    await pool.query(
      `INSERT INTO arbloop_l2_episodes
         (job_contract_address, iter_n, episode_ciphertext, lit_pkp_address, attestation_uid, ts_ms)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (job_contract_address, iter_n) DO UPDATE
         SET episode_ciphertext = EXCLUDED.episode_ciphertext`,
      [jobNamespaceAddr, iterN, ciphertext, buyer, Buffer.alloc(32), episode.ts_ms],
    );
  }

  private async appendL4(jobNamespaceAddr: string, buyer: string, pattern: L4Pattern): Promise<void> {
    const ns = new Contract(jobNamespaceAddr, JOB_NS_ABI, this.runner);
    const oldBytes32 = (await ns.l4ArweaveTxId()) as string;
    let merged: L4Pattern = pattern;
    if (oldBytes32 !== ZERO_ARWEAVE_BYTES32) {
      try {
        const oldTxId = Buffer.from(oldBytes32.slice(2), 'hex').toString('utf8').replace(/\0+$/, '');
        const oldBundle = await this.arweave.fetch(oldTxId);
        const old = (await this.lit.decryptForReader(
          Buffer.from(oldBundle).toString('utf8'),
          buyer,
          'job-memory-l4',
        )) as L4Pattern;
        merged = mergeL4(old, pattern);
      } catch {
        /* fall back to fresh write */
      }
    }
    const ciphertext = await this.lit.encryptForOwner(merged, buyer, 'job-memory-l4');
    const newTxId = await this.arweave.put(Buffer.from(ciphertext, 'utf8'));
    const tx = await ns.updateL4ArweaveTxId(arweaveTxIdToBytes32(newTxId));
    await tx.wait();
  }

  private async snapshotL2ToEigenDa(jobNamespaceAddr: string, buyer: string): Promise<void> {
    const all = await pool.query(
      `SELECT iter_n, episode_ciphertext, ts_ms
         FROM arbloop_l2_episodes
        WHERE job_contract_address = $1
        ORDER BY iter_n ASC`,
      [jobNamespaceAddr],
    );
    const blob = await this.lit.encryptForOwner(
      { episodes: all.rows },
      buyer,
      'job-memory-l2',
    );
    const kzg = await this.eigenDa.put(Buffer.from(blob, 'utf8'));
    const ns = new Contract(jobNamespaceAddr, JOB_NS_ABI, this.runner);
    const tx = await ns.pushL2Snapshot(kzg);
    await tx.wait();
  }

  // ─── Reflective writeback (job completion) ─────────────────────────────

  async reflectiveWriteback(
    jobNamespaceAddr: string,
    agentNamespaceAddr: string,
    manifest: LoopManifest,
  ): Promise<{ l5Uid: string | null; l5TxId: string | null }> {
    const reflectiveTpl = manifest.reflective?.on_complete?.write_to_l5;
    if (!reflectiveTpl) return { l5Uid: null, l5TxId: null };

    const seller = await this.getSellerFromAgentNs(agentNamespaceAddr);
    const reflection = { template: reflectiveTpl, generated_at_ms: Date.now() };

    // 1. Lit-encrypt + Arweave-pin
    const ciphertext = await this.lit.encryptForOwner(reflection, seller, 'agent-memory-l5');
    const txId = await this.arweave.put(Buffer.from(ciphertext, 'utf8'));
    const txIdBytes32 = arweaveTxIdToBytes32(txId);

    // 2. EAS-attest
    const uid = await this.eas.attestL5Reflection({
      agentContract: agentNamespaceAddr,
      jobAddress: jobNamespaceAddr,
      arweaveTxId: txId,
      arweaveTxIdBytes32: txIdBytes32,
      reflectiveAtMs: BigInt(Date.now()),
    });

    // 3. AgentMemoryNamespace pointer push (RUNNER_ROLE-gated on-chain)
    const ns = new Contract(agentNamespaceAddr, AGENT_NS_ABI, this.runner);
    const tx = await ns.pushL5Reflection(txIdBytes32, uid);
    await tx.wait();

    // 4. Re-synthesize L3 every 5 L5 entries
    const l5Count = Number((await ns.l5Count()) as bigint);
    if (l5Count > 0 && l5Count % 5 === 0) {
      const newL3 = { synthesized_at_ms: Date.now(), from_l5_count: l5Count };
      const l3Cipher = await this.lit.encryptForOwner(newL3, seller, 'agent-memory-l3');
      const l3Tx = await this.arweave.put(Buffer.from(l3Cipher, 'utf8'));
      const updateTx = await ns.updateL3ArweaveTxId(arweaveTxIdToBytes32(l3Tx));
      await updateTx.wait();
    }

    return { l5Uid: uid, l5TxId: txId };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async getBuyer(jobNamespaceAddr: string): Promise<string> {
    const ns = new Contract(jobNamespaceAddr, JOB_NS_ABI, this.provider);
    return ((await ns.buyer()) as string).toLowerCase();
  }

  private async getSellerFromAgentNs(agentNamespaceAddr: string): Promise<string> {
    const ns = new Contract(agentNamespaceAddr, AGENT_NS_ABI, this.provider);
    return ((await ns.seller()) as string).toLowerCase();
  }
}

// Pure merge helper — preserves entries with highest confidence per key.
function mergeL4(old: L4Pattern, fresh: L4Pattern): L4Pattern {
  const byKey = new Map<string, { value: unknown; confidence: number }>();
  for (const e of old.entries) byKey.set(e.key, { value: e.value, confidence: e.confidence });
  for (const e of fresh.entries) {
    const existing = byKey.get(e.key);
    if (!existing || e.confidence > existing.confidence) {
      byKey.set(e.key, { value: e.value, confidence: e.confidence });
    }
  }
  return {
    pair_traits: { ...old.pair_traits, ...fresh.pair_traits },
    entries: Array.from(byKey, ([key, v]) => ({ key, ...v })),
    confidence: Math.max(old.confidence, fresh.confidence),
  };
}
