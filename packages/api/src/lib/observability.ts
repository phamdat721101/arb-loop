import type { Request, Response, RequestHandler } from 'express';
import client from 'prom-client';
import type { Pool } from 'pg';
import { getBreakerSnapshot } from '@fhe-ai-context/runtime-utils';
import { logger } from './logger';

/**
 * Observability — `/metrics` (Prometheus) + `/health` (dependency probes).
 *
 * SOLID:
 * - Single Responsibility: this file owns the *outward-facing* observability
 *   endpoints. The mechanics of *why* a dep is unhealthy live in `resilientCall`.
 * - Open/Closed: dependency probes are registered via `registerHealthProbe`,
 *   never by editing this file.
 * - Liskov: every probe satisfies the same `HealthProbe` contract.
 */

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [registry],
});

export const httpRequestDurationMs = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'path', 'status'] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [registry],
});

// v2 privacy pipeline metrics
export const v2InferenceDurationMs = new client.Histogram({
  name: 'v2_inference_duration_ms',
  help: 'v2 inference call duration',
  buckets: [100, 500, 1000, 3000, 5000, 10000, 30000],
  registers: [registry],
});

export const v2UploadsTotal = new client.Counter({
  name: 'v2_uploads_total',
  help: 'Total v2 opaque uploads',
  registers: [registry],
});

export const v2ChatsTotal = new client.Counter({
  name: 'v2_chats_total',
  help: 'Total v2 chat inferences',
  registers: [registry],
});

// v3 agentic-marketplace metrics
export const v3RailReceiptsTotal = new client.Counter({
  name: 'v3_rail_receipts_total',
  help: 'Total v3 paid agent calls per rail',
  labelNames: ['rail'] as const,
  registers: [registry],
});

export const v3PayLatencyMs = new client.Histogram({
  name: 'v3_pay_latency_ms',
  help: 'PayRouter rail dispatch latency',
  labelNames: ['rail'] as const,
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

export const v3BundleStepsTotal = new client.Counter({
  name: 'v3_bundle_steps_total',
  help: 'Total bundle steps executed (hosted runner)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** Express middleware that records request count + duration. Mount once, near the top. */
export function metricsMiddleware(): RequestHandler {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const labels = { method: req.method, path: req.route?.path ?? req.path, status: String(res.statusCode) };
      httpRequestsTotal.inc(labels);
      httpRequestDurationMs.observe(labels, Date.now() - start);
    });
    next();
  };
}

/** Mounts as a route handler at `/metrics`. */
export const metricsHandler: RequestHandler = async (_req, res) => {
  res.setHeader('Content-Type', registry.contentType);
  res.send(await registry.metrics());
};

// ---------- Health ----------------------------------------------------------

export type DepStatus = 'ok' | 'degraded' | 'down';

export interface HealthProbe {
  name: string;
  /** Returns `ok` quickly (≤1s). Throw to signal `down`. */
  check: () => Promise<DepStatus>;
}

const probes: HealthProbe[] = [];

/** Add a probe that the `/health` endpoint will run on every hit. */
export function registerHealthProbe(probe: HealthProbe): void {
  probes.push(probe);
}

/** Single-shot probe with a 1s timeout. Probe internals never block the response. */
async function runProbe(probe: HealthProbe): Promise<DepStatus> {
  try {
    const result = await Promise.race<DepStatus>([
      probe.check(),
      new Promise<DepStatus>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 1_000)),
    ]);
    return result;
  } catch (err) {
    logger.warn({ dep: probe.name, err: (err as Error)?.message }, 'health:probe_failed');
    return 'down';
  }
}

export const healthHandler: RequestHandler = async (_req: Request, res: Response) => {
  const deps: Record<string, DepStatus> = {};
  // Aggregate breaker state into the health view: an OPEN breaker is `degraded`
  // even if the live probe currently passes — clients should know the server is
  // shedding load.
  const breakers = getBreakerSnapshot();
  for (const [name, b] of Object.entries(breakers)) {
    deps[name] = b.state === 'OPEN' ? 'degraded' : 'ok';
  }

  await Promise.all(
    probes.map(async (p) => {
      const status = await runProbe(p);
      // Worst status wins.
      if (deps[p.name] !== 'down') deps[p.name] = status;
    }),
  );

  const overall: DepStatus = Object.values(deps).reduce<DepStatus>(
    (worst, current) => (current === 'down' ? 'down' : current === 'degraded' ? (worst === 'down' ? 'down' : 'degraded') : worst),
    'ok',
  );

  res.status(overall === 'down' ? 503 : 200).json({ status: overall, deps });
};

// ── KPI gauges (T7/PRD-D) ───────────────────────────────────────────────────
//
// 14 metrics tracked: 5 USP_BRIEF kill criteria + 4 Fhenix-specific +
// 4 investor-grade + 1 freemium funnel. All share the same registry so
// /metrics auto-includes them; /v4/admin/stats returns them as JSON.
//
// SOLID:
//   - SRP: each gauge is one number; refreshKpiGauges() is the only writer.
//   - I3: single source of truth — /metrics scrape AND /v4/admin/stats both
//     pull from these same gauges. No duplicated computation.

const KPI_NAMES = [
  // Group A — kill criteria (USP_BRIEF.md)
  'kpi_seller_wallets_total',
  'kpi_brains_earning_total',
  'kpi_buying_agent_wallets_total',
  'kpi_settled_usdc_total',
  'kpi_unsolicited_tweets_total',
  // Group B — Fhenix-specific
  'kpi_fherc20_settlements_total',
  'kpi_fherc20_pct',
  'kpi_wrapped_usdc_holders_total',
  'kpi_settlement_ledger_rows_total',
  // Group C — investor-grade
  'kpi_wau_brains_earning',
  'kpi_top10_seller_revenue_usdc',
  'kpi_buyer_retention_w1',
  'kpi_agent_arpu_usdc',
  // Group D — freemium funnel
  'kpi_free_to_paid_pct',
] as const;

export type KpiName = (typeof KPI_NAMES)[number];

const kpiGauges = Object.fromEntries(
  KPI_NAMES.map((name) => [
    name,
    new client.Gauge({ name, help: name.replace(/_/g, ' '), registers: [registry] }),
  ]),
) as Record<KpiName, client.Gauge>;

/**
 * Run all 14 KPI queries against Postgres and update the gauges.
 * Returns the raw values as a JSON-friendly object.
 *
 * Cheap: each query hits an indexed column (paid_calls_buyer_idx,
 * paid_calls_agent_idx, paid_calls_freemium_idx from migration 010).
 * Total round-trip <50ms on a freshly-seeded testnet. Safe to call per
 * request from /v4/admin/stats.
 */
export async function refreshKpiGauges(pool: Pool): Promise<Record<KpiName, number>> {
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => r.rows);

  // Fan out — Postgres handles ~14 small queries easily.
  const [
    sellerWallets,
    brainsEarning,
    buyingAgents,
    settledUsdc,
    fherc20Count,
    fherc20Pct,
    wrappedHolders,
    wauBrains,
    top10Revenue,
    buyerRetentionW1,
    agentArpu,
    freeToPaid,
  ] = await Promise.all([
    q(`SELECT COUNT(DISTINCT owner_address)::int AS n FROM brains`),
    q(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT agent_id FROM paid_calls
          WHERE method != 'free'
          GROUP BY agent_id HAVING COUNT(DISTINCT buyer) >= 3
       ) s`,
    ),
    q(`SELECT COUNT(DISTINCT buyer)::int AS n FROM paid_calls WHERE method != 'free'`),
    q(`SELECT COALESCE(SUM(amount_usdc), 0)::float AS n FROM paid_calls WHERE method != 'free'`),
    q(`SELECT COUNT(*)::int AS n FROM paid_calls WHERE method = 'fherc20'`),
    q(
      `SELECT CASE WHEN total = 0 THEN 0
              ELSE 100.0 * fhe / total END AS n FROM (
         SELECT COUNT(*) FILTER (WHERE method = 'fherc20')::float AS fhe,
                COUNT(*) FILTER (WHERE method IN ('fherc20','exact'))::float AS total
           FROM paid_calls
       ) s`,
    ),
    q(`SELECT COUNT(DISTINCT buyer)::int AS n FROM paid_calls WHERE method = 'fherc20'`),
    q(
      `SELECT COUNT(DISTINCT agent_id)::int AS n FROM paid_calls
        WHERE method != 'free' AND created_at >= NOW() - INTERVAL '7 days'`,
    ),
    q(
      `SELECT COALESCE(SUM(amount_usdc), 0)::float AS n FROM (
         SELECT b.owner_address, SUM(pc.amount_usdc) AS amount_usdc
           FROM paid_calls pc
           JOIN agents a ON a.id = pc.agent_id
           JOIN brains b ON b.id = a.brain_id
          WHERE pc.method != 'free'
          GROUP BY b.owner_address
          ORDER BY amount_usdc DESC
          LIMIT 10
       ) top`,
    ),
    q(
      `WITH w1 AS (
         SELECT DISTINCT buyer FROM paid_calls
          WHERE method != 'free'
            AND created_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
       ),
       w2 AS (
         SELECT DISTINCT buyer FROM paid_calls
          WHERE method != 'free'
            AND created_at >= NOW() - INTERVAL '7 days'
       )
       SELECT CASE WHEN (SELECT COUNT(*) FROM w1) = 0 THEN 0
              ELSE 100.0 * (SELECT COUNT(*) FROM w1 INNER JOIN w2 USING (buyer)) /
                           (SELECT COUNT(*) FROM w1) END AS n`,
    ),
    q(
      `SELECT CASE WHEN COUNT(DISTINCT buyer) = 0 THEN 0
              ELSE COALESCE(SUM(amount_usdc), 0)::float / COUNT(DISTINCT buyer) END AS n
         FROM paid_calls WHERE method != 'free'`,
    ),
    q(
      `WITH freed AS (
         SELECT DISTINCT buyer, agent_id FROM paid_calls WHERE method = 'free'
       ),
       paid AS (
         SELECT DISTINCT buyer, agent_id FROM paid_calls WHERE method != 'free'
       )
       SELECT CASE WHEN (SELECT COUNT(*) FROM freed) = 0 THEN 0
              ELSE 100.0 * (SELECT COUNT(*) FROM freed
                              INNER JOIN paid USING (buyer, agent_id)) /
                           (SELECT COUNT(*) FROM freed) END AS n`,
    ),
  ]).catch((err) => {
    logger.warn({ err: (err as Error).message }, 'kpi:refresh:failed');
    // Return all-zero rows so gauges still update to 0 instead of stale data.
    return Array(12).fill([{ n: 0 }]);
  });

  // Manual count: read latest tweet count from process.env (set by manual update).
  const tweets = Number(process.env.KPI_UNSOLICITED_TWEETS ?? 0);

  const values: Record<KpiName, number> = {
    kpi_seller_wallets_total: Number(sellerWallets[0]?.n ?? 0),
    kpi_brains_earning_total: Number(brainsEarning[0]?.n ?? 0),
    kpi_buying_agent_wallets_total: Number(buyingAgents[0]?.n ?? 0),
    kpi_settled_usdc_total: Number(settledUsdc[0]?.n ?? 0),
    kpi_unsolicited_tweets_total: tweets,
    kpi_fherc20_settlements_total: Number(fherc20Count[0]?.n ?? 0),
    kpi_fherc20_pct: Number(fherc20Pct[0]?.n ?? 0),
    kpi_wrapped_usdc_holders_total: Number(wrappedHolders[0]?.n ?? 0),
    // Proxy until v1.1 reads on-chain SettlementLedger.settlementCount()
    kpi_settlement_ledger_rows_total: Number(fherc20Count[0]?.n ?? 0),
    kpi_wau_brains_earning: Number(wauBrains[0]?.n ?? 0),
    kpi_top10_seller_revenue_usdc: Number(top10Revenue[0]?.n ?? 0),
    kpi_buyer_retention_w1: Number(buyerRetentionW1[0]?.n ?? 0),
    kpi_agent_arpu_usdc: Number(agentArpu[0]?.n ?? 0),
    kpi_free_to_paid_pct: Number(freeToPaid[0]?.n ?? 0),
  };

  for (const [name, val] of Object.entries(values)) {
    kpiGauges[name as KpiName].set(Number.isFinite(val) ? val : 0);
  }
  return values;
}
