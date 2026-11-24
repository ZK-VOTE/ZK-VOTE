-- ============================================
-- Migration 016: Durable saga / rate-limit / ordering / VK-cache state
-- ============================================
-- Mirrors services/durable-schema.ts. The schema is also installed at boot by
-- initDb() so stores are usable before the migration runner; this file keeps
-- the schema in the migration history for restored databases.

CREATE TABLE IF NOT EXISTS factory_sagas (
  ticket_id TEXT PRIMARY KEY,
  creator TEXT NOT NULL,
  dao_name TEXT NOT NULL,
  params TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress','completed','failed','compensating','compensated')),
  version INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_factory_sagas_status ON factory_sagas(status);
CREATE INDEX IF NOT EXISTS idx_factory_sagas_creator ON factory_sagas(creator);
CREATE INDEX IF NOT EXISTS idx_factory_sagas_updated ON factory_sagas(updated_at);

CREATE TABLE IF NOT EXISTS factory_saga_steps (
  ticket_id TEXT NOT NULL REFERENCES factory_sagas(ticket_id) ON DELETE CASCADE,
  step INTEGER NOT NULL CHECK (step BETWEEN 1 AND 11),
  name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  contract_id TEXT,
  tx_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  PRIMARY KEY (ticket_id, step)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_steps_idempotency
  ON factory_saga_steps(ticket_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_factory_steps_status ON factory_saga_steps(status);

CREATE TABLE IF NOT EXISTS factory_saga_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL,
  step INTEGER,
  event TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_factory_saga_events_ticket ON factory_saga_events(ticket_id);

CREATE TABLE IF NOT EXISTS shared_rate_buckets (
  bucket_key TEXT PRIMARY KEY,
  tokens_vote REAL NOT NULL,
  tokens_query REAL NOT NULL,
  tokens_auth REAL NOT NULL,
  window_start INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_rate_buckets_window ON shared_rate_buckets(window_start);

CREATE TABLE IF NOT EXISTS rate_quota_overrides (
  subject_key TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('vote','query','auth')),
  max_tokens INTEGER NOT NULL,
  window_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subject_key, bucket)
);

CREATE TABLE IF NOT EXISTS randomness_orderings (
  dao_id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  vdf_input TEXT NOT NULL,
  vdf_output TEXT NOT NULL DEFAULT '',
  vdf_checkpoints TEXT NOT NULL DEFAULT '[]',
  vdf_iterations INTEGER NOT NULL,
  proposal_ids TEXT NOT NULL,
  required_shares INTEGER NOT NULL,
  combined_seed TEXT NOT NULL DEFAULT '',
  ordering TEXT NOT NULL DEFAULT '[]',
  replay_nonce TEXT NOT NULL DEFAULT '',
  finalized_at INTEGER,
  committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS randomness_shares (
  dao_id INTEGER NOT NULL REFERENCES randomness_orderings(dao_id) ON DELETE CASCADE,
  authority_id TEXT NOT NULL,
  share_hex TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (dao_id, authority_id)
);

CREATE TABLE IF NOT EXISTS randomness_commits (
  dao_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (dao_id, version)
);
CREATE TRIGGER IF NOT EXISTS randomness_commits_immutable_update
BEFORE UPDATE ON randomness_commits
BEGIN
  SELECT RAISE(ABORT, 'randomness_commits: commit records are immutable');
END;
CREATE TRIGGER IF NOT EXISTS randomness_commits_immutable_delete
BEFORE DELETE ON randomness_commits
BEGIN
  SELECT RAISE(ABORT, 'randomness_commits: commit records are immutable');
END;

CREATE TABLE IF NOT EXISTS circuit_vk_cache (
  circuit_id TEXT NOT NULL,
  circuit_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  vk_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  num_public_signals INTEGER NOT NULL,
  ceremony_transcript_hash TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (circuit_id, circuit_type, version)
);

CREATE TABLE IF NOT EXISTS circuit_vk_revocations (
  circuit_id TEXT NOT NULL,
  circuit_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (circuit_id, circuit_type, version)
);
