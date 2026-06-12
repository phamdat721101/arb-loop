-- 027_arbloop.sql — arb-loop v0.1 tables (Arbitrum Sepolia, FEATURE_ARBLOOP gated)

-- Off-chain index of on-chain AgentRegistry entries
CREATE TABLE IF NOT EXISTS arbloop_agents_metadata (
  agent_registry_address TEXT NOT NULL,
  agent_id              BIGINT NOT NULL,
  seller_address        TEXT NOT NULL,
  manifest_eigen_kzg    BYTEA NOT NULL,
  manifest_arweave_tx_id TEXT,
  default_inference_backend TEXT NOT NULL,
  default_model_id      TEXT NOT NULL,
  per_iter_default_micro_usdc BIGINT NOT NULL,
  per_iter_min_micro_usdc BIGINT NOT NULL,
  max_iter_per_job      INTEGER NOT NULL,
  reputation_score      INTEGER NOT NULL DEFAULT 0,
  completed_jobs        INTEGER NOT NULL DEFAULT 0,
  total_iter_count      INTEGER NOT NULL DEFAULT 0,
  category              TEXT,
  tags                  TEXT[],
  title                 TEXT NOT NULL,
  short_description     TEXT,
  persona_namespace_address TEXT NOT NULL,
  published_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked               BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (agent_registry_address, agent_id)
);
CREATE INDEX IF NOT EXISTS arbloop_agents_seller_idx
  ON arbloop_agents_metadata(seller_address);
CREATE INDEX IF NOT EXISTS arbloop_agents_category_idx
  ON arbloop_agents_metadata(category, revoked);

-- Off-chain index of on-chain LoopJobs
CREATE TABLE IF NOT EXISTS arbloop_jobs_metadata (
  job_contract_address  TEXT PRIMARY KEY,
  buyer_address         TEXT NOT NULL,
  agent_registry_address TEXT NOT NULL,
  agent_id              BIGINT NOT NULL,
  manifest_eigen_kzg    BYTEA NOT NULL,
  status                SMALLINT NOT NULL,
  iterations_done       INTEGER NOT NULL DEFAULT 0,
  max_iterations        INTEGER NOT NULL,
  spent_micro_usdc      BIGINT NOT NULL DEFAULT 0,
  budget_micro_usdc     BIGINT NOT NULL,
  job_memory_namespace_address TEXT NOT NULL,
  last_attestation_uid  BYTEA,
  inference_backend_used TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_iter_at          TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS arbloop_jobs_buyer_idx
  ON arbloop_jobs_metadata(buyer_address);
CREATE INDEX IF NOT EXISTS arbloop_jobs_status_idx
  ON arbloop_jobs_metadata(status, last_iter_at);

-- Per-iteration telemetry
CREATE TABLE IF NOT EXISTS arbloop_iteration_log (
  job_contract_address  TEXT NOT NULL REFERENCES arbloop_jobs_metadata(job_contract_address),
  iter_n                INTEGER NOT NULL,
  attestation_uid       BYTEA NOT NULL,
  inference_backend     TEXT NOT NULL,
  inference_model_id    TEXT NOT NULL,
  phala_signing_address TEXT,
  phala_attestation_hash BYTEA,
  eigen_input_kzg       BYTEA NOT NULL,
  eigen_output_kzg      BYTEA NOT NULL,
  arweave_l4_tx_id      TEXT,
  arweave_l5_tx_id      TEXT,
  latency_inference_ms  INTEGER,
  latency_total_ms      INTEGER,
  amount_paid_micro_usdc BIGINT NOT NULL,
  pull_split_address    TEXT NOT NULL,
  stop_condition_eval   BOOLEAN NOT NULL,
  signals_emitted       JSONB,
  tools_used            TEXT[],
  iter_started_at       TIMESTAMPTZ NOT NULL,
  iter_completed_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (job_contract_address, iter_n)
);
CREATE INDEX IF NOT EXISTS arbloop_iter_log_attestation_idx
  ON arbloop_iteration_log(attestation_uid);

-- Memory index over (buyer, seller, agent) → namespace_address
CREATE TABLE IF NOT EXISTS arbloop_memory_index (
  buyer_address         TEXT NOT NULL,
  agent_registry_address TEXT NOT NULL,
  agent_id              BIGINT NOT NULL,
  seller_address        TEXT NOT NULL,
  job_memory_namespace_address TEXT NOT NULL,
  total_jobs            INTEGER NOT NULL DEFAULT 0,
  total_iters           INTEGER NOT NULL DEFAULT 0,
  l4_pattern_count      INTEGER NOT NULL DEFAULT 0,
  l5_reflection_count   INTEGER NOT NULL DEFAULT 0,
  first_job_at          TIMESTAMPTZ NOT NULL,
  last_job_at           TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (buyer_address, agent_registry_address, agent_id)
);
CREATE INDEX IF NOT EXISTS arbloop_memory_seller_idx
  ON arbloop_memory_index(seller_address);

-- L1 + L2 ephemeral memory KV (24h TTL via background sweep)
CREATE TABLE IF NOT EXISTS arbloop_l1_turns (
  job_contract_address TEXT NOT NULL,
  iter_n              INTEGER NOT NULL,
  turn_idx            INTEGER NOT NULL,
  role                TEXT NOT NULL,
  content_ciphertext  TEXT NOT NULL,
  lit_pkp_address     TEXT NOT NULL,
  ts_ms               BIGINT NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (job_contract_address, iter_n, turn_idx)
);
CREATE INDEX IF NOT EXISTS arbloop_l1_expires_idx ON arbloop_l1_turns(expires_at);

CREATE TABLE IF NOT EXISTS arbloop_l2_episodes (
  job_contract_address TEXT NOT NULL,
  iter_n              INTEGER NOT NULL,
  episode_ciphertext  TEXT NOT NULL,
  lit_pkp_address     TEXT NOT NULL,
  attestation_uid     BYTEA NOT NULL,
  ts_ms               BIGINT NOT NULL,
  PRIMARY KEY (job_contract_address, iter_n)
);

-- Mock storage backing — Postgres-backed mock for EigenDA + Arweave + Lit
-- in v0.1; swap to real SDKs in v0.2 by changing the client implementation.
CREATE TABLE IF NOT EXISTS arbloop_mock_blobs (
  id          TEXT PRIMARY KEY,            -- KZG commitment OR Arweave tx-id
  kind        TEXT NOT NULL,               -- 'eigenda' | 'arweave'
  payload     BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS arbloop_mock_blobs_kind_idx ON arbloop_mock_blobs(kind);

-- ── Loop runner work queue ────────────────────────────────────────────────
-- Decoupled from the PRD-19 chain_ops_queue (which requires a DB-UUID
-- agent_id FK; arbloop agents live on-chain). One queue, one feature, one
-- worker — same SOLID + SKIP LOCKED claim pattern as chain_ops_queue.

CREATE TABLE IF NOT EXISTS arbloop_runner_queue (
  id                  BIGSERIAL    PRIMARY KEY,
  op_kind             TEXT         NOT NULL,                  -- 'iter' | 'reflective_writeback'
  job_contract_address TEXT        NOT NULL,
  iter_n              INTEGER      NOT NULL DEFAULT 0,
  trigger_event       TEXT         NOT NULL,                  -- 'JobCreated' | 'IterAdvanced' | 'CheckpointApproved'
  trigger_tx_hash     TEXT,
  state               TEXT         NOT NULL DEFAULT 'pending', -- 'pending' | 'claimed' | 'completed' | 'failed'
  attempts            SMALLINT     NOT NULL DEFAULT 0,
  last_error          TEXT,
  claimed_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  not_before          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS arbloop_runner_queue_state_idx
  ON arbloop_runner_queue(state, not_before, created_at);
CREATE INDEX IF NOT EXISTS arbloop_runner_queue_job_idx
  ON arbloop_runner_queue(job_contract_address);

-- Watermark for chain event polling (one row per network).
CREATE TABLE IF NOT EXISTS arbloop_event_cursor (
  network    TEXT     PRIMARY KEY,
  last_block BIGINT   NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
