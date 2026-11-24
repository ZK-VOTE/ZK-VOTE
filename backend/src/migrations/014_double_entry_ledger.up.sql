-- ============================================
-- Migration 014: double-entry settlement ledger + reconciliation state
-- ============================================
-- SQLite dialect. Stores anchor callback idempotency, the settlement state
-- machine (PENDING -> ANCHOR_CONFIRMED -> SETTLED | FAILED | DISPUTED), every
-- observed callback as dispute evidence, and balanced hashed ledger postings.
-- Amounts are INTEGER minor units to avoid floating-point drift.

CREATE TABLE IF NOT EXISTS settlement_records (
  key TEXT PRIMARY KEY,
  anchor TEXT NOT NULL,
  external_tx_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'ANCHOR_CONFIRMED', 'SETTLED', 'FAILED', 'DISPUTED')),
  state_since INTEGER NOT NULL,
  gross_minor INTEGER,
  net_minor INTEGER,
  fee_breakdown TEXT NOT NULL DEFAULT '[]',
  posting_group_id TEXT,
  authority TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  dispute_surfaced INTEGER NOT NULL DEFAULT 0,
  UNIQUE (anchor, external_tx_id)
);

CREATE INDEX IF NOT EXISTS idx_settlement_records_state
  ON settlement_records(state, state_since);

CREATE TABLE IF NOT EXISTS settlement_callbacks (
  event_id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  anchor TEXT NOT NULL,
  external_tx_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('anchor_confirmed', 'settled', 'failed', 'disputed')),
  ledger_version INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  asset TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  gross_minor INTEGER,
  net_minor INTEGER,
  fee_breakdown TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (key) REFERENCES settlement_records(key)
);

CREATE INDEX IF NOT EXISTS idx_settlement_callbacks_key
  ON settlement_callbacks(key);

CREATE TABLE IF NOT EXISTS settlement_transitions (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  anchor TEXT NOT NULL,
  external_tx_id TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ledger_version INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (key) REFERENCES settlement_records(key)
);

CREATE INDEX IF NOT EXISTS idx_settlement_transitions_key
  ON settlement_transitions(key);

CREATE TABLE IF NOT EXISTS ledger_postings (
  posting_id TEXT PRIMARY KEY,
  posting_group_id TEXT NOT NULL,
  account TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  sequence INTEGER NOT NULL,
  balance_proof_hash TEXT NOT NULL CHECK (length(balance_proof_hash) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (posting_group_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_ledger_postings_group
  ON ledger_postings(posting_group_id);
