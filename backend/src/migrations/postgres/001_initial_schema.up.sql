-- ============================================
-- Migration 001 (Postgres): Initial schema with constraints
-- Parity target: ../001_initial_schema.up.sql
--
-- Differences from the SQLite original, and why each is safe:
--   * INTEGER PRIMARY KEY AUTOINCREMENT -> BIGSERIAL PRIMARY KEY.
--   * SQLite's 0/1 integer booleans -> real BOOLEAN columns. The relay reads
--     these through Kysely, which surfaces both as JS booleans, and the
--     CHECK(x IN (0,1)) guards become unnecessary (the type enforces it).
--   * strftime(...)/CURRENT_TIMESTAMP -> a to_char(now()) expression producing
--     the same ISO-8601 'YYYY-MM-DDTHH:MM:SS.mmmZ' string the relay parses.
--     Columns stay TEXT so row shapes are identical across backends.
--   * The event `type` CHECK list is lifted verbatim — the allowed set is
--     protocol-level and must not drift between backends.
-- ============================================

CREATE TABLE IF NOT EXISTS _migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  checksum TEXT,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS partition_registry (
  dao_id BIGINT PRIMARY KEY,
  created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS daos (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  creator TEXT NOT NULL,
  membership_open BOOLEAN NOT NULL DEFAULT TRUE,
  members_can_propose BOOLEAN NOT NULL DEFAULT FALSE,
  metadata_cid TEXT,
  member_count BIGINT DEFAULT 0,
  updated_at TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  dao_id BIGINT NOT NULL REFERENCES daos(id),
  type TEXT NOT NULL CHECK(type IN (
    'dao_create','admin_transfer','member_added','member_revoked','member_left',
    'tree_init','voter_registered','voter_removed','voter_reinstated',
    'vk_updated','proposal_created','proposal_closed','proposal_archived','vote_cast'
  )),
  data TEXT,
  ledger BIGINT,
  tx_hash TEXT,
  timestamp TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  UNIQUE(dao_id, ledger, tx_hash, type)
);
