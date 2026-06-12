#!/usr/bin/env tsx
/**
 * smoke-fhenix-onboard.ts — verifies the onboarding-ready surface against a
 * running API. Read-only checks (no on-chain writes); proves wiring, not flow.
 *
 * Usage:
 *   API_URL=https://13-229-63-192.sslip.io npx tsx scripts/smoke-fhenix-onboard.ts
 *
 * Exits 0 on green, 1 on red. Each step is independently labelled so a CI log
 * pinpoints the first regression.
 */
const API = process.env.API_URL?.replace(/\/$/, '') ?? 'http://localhost:3001';

const STEPS: Array<[string, () => Promise<{ ok: boolean; detail?: string }>]> = [
  ['health', async () => {
    const r = await fetch(`${API}/health`);
    return { ok: r.ok, detail: `${r.status}` };
  }],
  ['platform-config', async () => {
    const r = await fetch(`${API}/platform`);
    if (!r.ok) return { ok: false, detail: `${r.status}` };
    const j = await r.json();
    const ok = !!j.platformWallet && !!j.contracts?.brainKeyVault;
    return { ok, detail: `vault=${j.contracts?.brainKeyVault?.slice(0, 10) ?? '∅'}` };
  }],
  ['legacy-chat-308', async () => {
    const r = await fetch(`${API}/chat`, { redirect: 'manual' });
    return { ok: r.status === 308, detail: `status=${r.status}` };
  }],
  ['v2-brains-list', async () => {
    const r = await fetch(`${API}/v2/brains`);
    // /v2 is auth-gated; 401 (no header) or 200 (open) both prove route is wired.
    return { ok: r.status === 200 || r.status === 401, detail: `${r.status}` };
  }],
  ['v2-inference-needs-auth', async () => {
    const r = await fetch(`${API}/v2/inference`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chunks: ['x'], question: 'y' }),
    });
    return { ok: r.status === 401, detail: `status=${r.status} (want 401)` };
  }],
  ['v2-access-requests-route', async () => {
    const r = await fetch(`${API}/v2/access/requests?owner=0x0000000000000000000000000000000000000000`);
    return { ok: r.status === 200 || r.status === 401, detail: `${r.status}` };
  }],
  ['no-subscribe-route', async () => {
    const r = await fetch(`${API}/subscribe`, { method: 'POST' });
    return { ok: r.status === 404 || r.status === 405, detail: `status=${r.status} (want 404/405)` };
  }],
];

(async () => {
  console.log(`==> smoke against ${API}`);
  let red = 0;
  for (const [name, fn] of STEPS) {
    const t0 = Date.now();
    try {
      const { ok, detail } = await fn();
      const ms = Date.now() - t0;
      console.log(`${ok ? '🟢' : '🔴'}  ${name.padEnd(28)} ${detail ?? ''} (${ms}ms)`);
      if (!ok) red++;
    } catch (e: any) {
      console.log(`🔴  ${name.padEnd(28)} threw: ${e?.message ?? e}`);
      red++;
    }
  }
  console.log(`\n${red === 0 ? '🟢 onboarding-ready · all checks passed' : `🔴 ${red} check(s) failed`}`);
  process.exit(red === 0 ? 0 : 1);
})();
