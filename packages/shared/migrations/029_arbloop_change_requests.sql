-- 029_arbloop_change_requests.sql — Studio change-request thread
--
-- One DB-backed thread per LoopJob. Buyer files a request; seller replies
-- (or vice-versa). Off-chain on purpose — keeps the on-chain footprint at
-- the existing pause/resume/cancel/checkpoint primitives. No state is
-- safety-critical: this table can be wiped without breaking any flow.
--
-- Idempotent. Indexed for the only access pattern: per-job thread, newest
-- last (chat order).

BEGIN;

CREATE TABLE IF NOT EXISTS arbloop_change_requests (
  id                    BIGSERIAL PRIMARY KEY,
  job_contract_address  TEXT       NOT NULL,           -- lowercased
  buyer_address         TEXT       NOT NULL,           -- lowercased
  seller_address        TEXT       NOT NULL,           -- lowercased
  sender_address        TEXT       NOT NULL,           -- lowercased — must equal buyer or seller
  direction             TEXT       NOT NULL CHECK (direction IN ('buyer_to_seller', 'seller_to_buyer')),
  body                  TEXT       NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS arbloop_change_requests_job_idx
  ON arbloop_change_requests (job_contract_address, created_at ASC);

CREATE INDEX IF NOT EXISTS arbloop_change_requests_seller_inbox_idx
  ON arbloop_change_requests (seller_address, created_at DESC)
  WHERE direction = 'buyer_to_seller';

CREATE INDEX IF NOT EXISTS arbloop_change_requests_buyer_inbox_idx
  ON arbloop_change_requests (buyer_address, created_at DESC)
  WHERE direction = 'seller_to_buyer';

COMMIT;
