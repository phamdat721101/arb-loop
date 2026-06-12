-- 028_arbloop_simple.sql — v0.0 simple ship
-- Consolidates PRD-master's 4 sub-migrations (028a..028d) per the
-- essential-files-only mandate. Idempotent: safe to re-run.
--
-- What it does:
--   1. arbloop_agents_metadata: add manifest_ipfs_cid + agent_registry_version;
--      keep manifest_eigen_kzg + manifest_arweave_tx_id NULL-able for back-compat
--      (no DROP — preserves byte-identical rollback to heavy v0.1).
--   2. arbloop_iteration_log: add v0.0 columns (enc_result_handle, response_ipfs_cid,
--      inputs_json, x402_settlement_tx). EigenDA/Arweave/EAS/Phala columns kept
--      NULL-able for the same back-compat reason.
--   3. arbloop_x402_settlements: NEW table for per-call x402 settlements.
--   4. arbloop_concierge_history: NEW table for F6 reflexive loop substrate.
--
-- Rollback: this migration only ADDS columns + tables. Disabling
-- FEATURE_ARBLOOP_SIMPLE leaves the schema additive but inactive.

BEGIN;

-- ─── 1. arbloop_agents_metadata: add v0.0 columns ───────────────────────

ALTER TABLE arbloop_agents_metadata
  ADD COLUMN IF NOT EXISTS manifest_ipfs_cid       TEXT,
  ADD COLUMN IF NOT EXISTS agent_registry_version  SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS mode                    TEXT;  -- 'x402' | 'loop' (derived)

-- Make existing manifest pointers NULL-able (was NOT NULL in v0.1).
ALTER TABLE arbloop_agents_metadata
  ALTER COLUMN manifest_eigen_kzg DROP NOT NULL,
  ALTER COLUMN manifest_arweave_tx_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS arbloop_agents_metadata_registry_version_idx
  ON arbloop_agents_metadata (agent_registry_version, agent_id);

CREATE INDEX IF NOT EXISTS arbloop_agents_metadata_mode_idx
  ON arbloop_agents_metadata (mode) WHERE mode IS NOT NULL;

-- ─── 2. arbloop_iteration_log: add v0.0 columns ─────────────────────────

ALTER TABLE arbloop_iteration_log
  ADD COLUMN IF NOT EXISTS enc_result_handle     BYTEA,
  ADD COLUMN IF NOT EXISTS response_ipfs_cid     TEXT,
  ADD COLUMN IF NOT EXISTS inputs_json           JSONB,
  ADD COLUMN IF NOT EXISTS x402_settlement_tx    TEXT;

-- Same back-compat: keep heavy v0.1 columns null-able.
DO $$ BEGIN
  ALTER TABLE arbloop_iteration_log ALTER COLUMN eigen_input_kzg DROP NOT NULL;
EXCEPTION WHEN undefined_column OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE arbloop_iteration_log ALTER COLUMN eigen_output_kzg DROP NOT NULL;
EXCEPTION WHEN undefined_column OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE arbloop_iteration_log ALTER COLUMN phala_signing_address DROP NOT NULL;
EXCEPTION WHEN undefined_column OR invalid_table_definition THEN NULL; END $$;

-- ─── 3. arbloop_x402_settlements: NEW ───────────────────────────────────

CREATE TABLE IF NOT EXISTS arbloop_x402_settlements (
  tx_hash             TEXT PRIMARY KEY,                      -- on-chain settlement tx
  agent_id            INTEGER NOT NULL,
  agent_registry_addr TEXT NOT NULL,
  payer_address       TEXT NOT NULL,
  seller_address      TEXT NOT NULL,
  amount_micro_usdc   BIGINT NOT NULL,
  seller_cut_micro    BIGINT NOT NULL,
  compute_cut_micro   BIGINT NOT NULL,
  platform_cut_micro  BIGINT NOT NULL,
  splits_json         JSONB,                                  -- { sellerBps, computeBps, platformBps }
  request_correlation_id TEXT,
  settled_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS arbloop_x402_settlements_agent_idx
  ON arbloop_x402_settlements (agent_registry_addr, agent_id, settled_at DESC);

CREATE INDEX IF NOT EXISTS arbloop_x402_settlements_payer_idx
  ON arbloop_x402_settlements (payer_address, settled_at DESC);

-- ─── 4. arbloop_concierge_history: NEW (F6 reflexive loop) ──────────────

CREATE TABLE IF NOT EXISTS arbloop_concierge_history (
  id                  BIGSERIAL PRIMARY KEY,
  buyer_address       TEXT,                                   -- nullable for anonymous
  session_id          TEXT,                                   -- localStorage id
  query_text          TEXT NOT NULL,
  intent_json         JSONB,                                  -- conciergeService output
  candidates_json     JSONB,                                  -- ranked agent ids + scores
  picked_agent_id     INTEGER,
  picked_mode         TEXT,
  outcome             TEXT,                                   -- 'paid' | 'abandoned' | 'failed'
  outcome_tx_hash     TEXT,
  executed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS arbloop_concierge_history_buyer_idx
  ON arbloop_concierge_history (buyer_address, executed_at DESC)
  WHERE buyer_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS arbloop_concierge_history_session_idx
  ON arbloop_concierge_history (session_id, executed_at DESC)
  WHERE session_id IS NOT NULL;

COMMIT;
