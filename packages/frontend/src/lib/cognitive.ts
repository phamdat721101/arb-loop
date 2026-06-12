'use client';

/**
 * lib/cognitive.ts — frontend adapter for /v4/cognitive/*.
 *
 * SRP: this module owns the HTTP layer for cognitive memory + the polling
 * loop. UI components import from here only. No JSX in this file.
 *
 * Trust posture: list endpoints are owner-gated server-side (x-wallet-address
 * must match :addr). Plaintext fields (`body`, `fact`, `steps`) are populated
 * by the server only when the caller is the owner; for non-owner buyers the
 * snapshot endpoint provides counts/topics without plaintext.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_BACKEND_URL } from './contracts';

// ─── Wire-shapes (mirror api/services/cognitiveMemoryService Public*Row) ────

export interface EpisodeRow {
  id: string;
  agentId: string;
  topic: string;
  brainId: number | null;
  createdAt: string;
  payloadHex: string;
  body?: string;
}
export interface FactRow {
  id: string;
  topic: string;
  factType: string;
  confidence: number;
  derivedFrom: string[];
  procedureKey: string | null;
  signer: string;
  signature: string;
  createdAt: string;
  payloadHex: string;
  fact?: string;
}
export interface SkillRow {
  id: string;
  procedureKey: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  defaultPriceUsdc: string;
  derivedFrom: string[];
  runCount: number;
  lastAttestation: string | null;
  signer: string;
  signature: string;
  createdAt: string;
  steps?: Array<{ name: string; description: string }>;
}

export interface BrainSnapshot {
  brainId: number;
  ownerAddr: string | null;
  episodes: number;
  facts: number;
  skills: number;
  topics: Array<{ key: string; count: number }>;
  activity14d: number[];
  lastQueryAt: string | null;
  fhenixVaultAddress: string | null;
  recentSkills: Array<{ id: string; procedureKey: string; defaultPriceUsdc: string; runCount: number }>;
  recentAttestations: Array<{ runId: number; attestation: string; createdAt: string }>;
}

// ─── Owner-gated fetchers ──────────────────────────────────────────────────

function ownerHeaders(addr: string): HeadersInit {
  return { 'Content-Type': 'application/json', 'x-wallet-address': addr.toLowerCase() };
}

export async function fetchEpisodes(addr: string, limit = 50): Promise<EpisodeRow[]> {
  const r = await fetch(`${AGENT_BACKEND_URL}/v4/cognitive/episodes/by-owner/${addr.toLowerCase()}?limit=${limit}`, {
    headers: ownerHeaders(addr),
  });
  if (!r.ok) return [];
  const data = (await r.json()) as { items: EpisodeRow[] };
  return data.items ?? [];
}

export async function fetchFacts(addr: string, limit = 50): Promise<FactRow[]> {
  const r = await fetch(`${AGENT_BACKEND_URL}/v4/cognitive/facts/by-owner/${addr.toLowerCase()}?limit=${limit}`, {
    headers: ownerHeaders(addr),
  });
  if (!r.ok) return [];
  const data = (await r.json()) as { items: FactRow[] };
  return data.items ?? [];
}

export async function fetchSkills(addr: string, limit = 50): Promise<SkillRow[]> {
  const r = await fetch(`${AGENT_BACKEND_URL}/v4/cognitive/skills/by-owner/${addr.toLowerCase()}?limit=${limit}`, {
    headers: ownerHeaders(addr),
  });
  if (!r.ok) return [];
  const data = (await r.json()) as { items: SkillRow[] };
  return data.items ?? [];
}

export async function runSkill(skillId: string, walletAddress: string, input: unknown): Promise<{ result: unknown; attestation: string }> {
  const r = await fetch(`${AGENT_BACKEND_URL}/v4/cognitive/skills/${skillId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-wallet-address': walletAddress.toLowerCase() },
    body: JSON.stringify({ input }),
  });
  if (!r.ok) throw new Error(`run skill ${r.status}: ${await r.text()}`);
  return r.json();
}

// ─── Public snapshot for /agent/[id] (no auth required, no plaintext) ──────

export async function fetchBrainSnapshot(brainId: number): Promise<BrainSnapshot | null> {
  const r = await fetch(`${AGENT_BACKEND_URL}/v4/cognitive/brain/${brainId}/snapshot`);
  if (!r.ok) return null;
  return r.json();
}

// ─── Polling hook ──────────────────────────────────────────────────────────

const POLL_MS = 3_000;

export interface CognitiveState {
  episodes: EpisodeRow[];
  facts: FactRow[];
  skills: SkillRow[];
  /** Newly-added entity ids since last poll — drives animations. */
  freshEpisodeIds: Set<string>;
  freshFactIds: Set<string>;
  freshSkillIds: Set<string>;
  /** True when the last poll succeeded for at least one of the three. */
  isLive: boolean;
  refresh: () => void;
}

/**
 * useCognitive — single source of truth for /brain page state. Polls the 3
 * owner-gated endpoints every POLL_MS, diffs results to surface "fresh" ids
 * for the animation layer, and exposes a manual refresh().
 *
 * SOLID-DIP: components consume this state shape, not the underlying
 * endpoints. Phase 2 swaps polling for SSE inside this hook with no
 * component-level changes.
 */
export function useCognitive(addr: string | undefined): CognitiveState {
  const [episodes, setEpisodes] = useState<EpisodeRow[]>([]);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [freshEpisodeIds, setFreshEpisodeIds] = useState<Set<string>>(new Set());
  const [freshFactIds, setFreshFactIds] = useState<Set<string>>(new Set());
  const [freshSkillIds, setFreshSkillIds] = useState<Set<string>>(new Set());
  const [isLive, setIsLive] = useState(false);
  const seenEpRef = useRef<Set<string>>(new Set());
  const seenFactRef = useRef<Set<string>>(new Set());
  const seenSkillRef = useRef<Set<string>>(new Set());

  const tick = useCallback(async () => {
    if (!addr) return;
    const [eps, fcs, sks] = await Promise.all([
      fetchEpisodes(addr).catch(() => []),
      fetchFacts(addr).catch(() => []),
      fetchSkills(addr).catch(() => []),
    ]);
    setIsLive(eps.length + fcs.length + sks.length >= 0);

    const freshEp = new Set<string>();
    for (const e of eps) {
      if (!seenEpRef.current.has(e.id)) freshEp.add(e.id);
      seenEpRef.current.add(e.id);
    }
    const freshFa = new Set<string>();
    for (const f of fcs) {
      if (!seenFactRef.current.has(f.id)) freshFa.add(f.id);
      seenFactRef.current.add(f.id);
    }
    const freshSk = new Set<string>();
    for (const s of sks) {
      if (!seenSkillRef.current.has(s.id)) freshSk.add(s.id);
      seenSkillRef.current.add(s.id);
    }

    setEpisodes(eps);
    setFacts(fcs);
    setSkills(sks);

    // Only mark something "fresh" if it's not the very first poll (otherwise
    // every initial row would animate, which is noise).
    if (seenEpRef.current.size > freshEp.size) setFreshEpisodeIds(freshEp);
    if (seenFactRef.current.size > freshFa.size) setFreshFactIds(freshFa);
    if (seenSkillRef.current.size > freshSk.size) setFreshSkillIds(freshSk);
  }, [addr]);

  useEffect(() => {
    if (!addr) {
      setEpisodes([]);
      setFacts([]);
      setSkills([]);
      seenEpRef.current = new Set();
      seenFactRef.current = new Set();
      seenSkillRef.current = new Set();
      return;
    }
    void tick();
    const handle = setInterval(tick, POLL_MS);
    return () => clearInterval(handle);
  }, [addr, tick]);

  return { episodes, facts, skills, freshEpisodeIds, freshFactIds, freshSkillIds, isLive, refresh: tick };
}
