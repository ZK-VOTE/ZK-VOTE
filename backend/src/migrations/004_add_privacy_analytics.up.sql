-- ============================================
-- Migration 004: Privacy-preserving analytics (homomorphic tally aggregates)
-- Created: 2026-08-31
--
-- Stores an encrypted, per-DAO *aggregate* tally for turnout / participation
-- analytics. Individual votes are summed homomorphically under the DAO's DKG
-- joint public key and only the aggregate ciphertext is ever threshold-decrypted,
-- so indexers never observe per-voter participation (see THREAT_MODEL.md §Privacy
-- Preserving Analytics).
--
-- A per-DAO privacy budget gates how many aggregates may be decrypted, so an
-- attacker cannot repeatedly coarsen or difference aggregates to isolate a single
-- voter's participation. A minimum-cohort bound (k-anonymity floor) additionally
-- refuses to decrypt cohorts smaller than a DAO-configured minimum.
-- ============================================

-- Per-DAO encrypted homomorphic aggregate plus accounting metadata.
CREATE TABLE IF NOT EXISTS analytics_aggregates (
  dao_id INTEGER PRIMARY KEY,
  -- The DKG joint public key (G1 point, hex) under which tallies were encrypted.
  joint_public_key TEXT NOT NULL,
  -- ElGamal ciphertext (c1 || c2, G1 points, hex) of the accumulated sum.
  -- Individual vote contributions are folded into this aggregate; they are NOT
  -- retained separately, so per-voter participation cannot be recovered from the
  -- analytics table.
  aggregate_c1 TEXT NOT NULL,
  aggregate_c2 TEXT NOT NULL,
  -- Number of encrypted contributions folded in so far (unencrypted metadata;
  -- reveals cohort size, which is public information on-chain anyway).
  contribution_count INTEGER NOT NULL DEFAULT 0,
  -- DKG threshold parameters used for this DAO's aggregate decryption.
  threshold_t INTEGER NOT NULL DEFAULT 0,
  threshold_n INTEGER NOT NULL DEFAULT 0,
  -- Guard flags: once decrypted-once semantics / finalize-after-decrypt.
  decrypted INTEGER NOT NULL DEFAULT 0 CHECK(decrypted IN (0, 1)),
  last_decrypted_tally TEXT,
  decrypted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_aggregates_dao ON analytics_aggregates(dao_id);

-- Per-DAO privacy budget. epsilon budget is "spent" (monotonically) as
-- aggregates are decrypted; queries are refused once remaining < per-query cost.
CREATE TABLE IF NOT EXISTS privacy_budget (
  dao_id INTEGER PRIMARY KEY,
  -- Initial privacy budget for the current window (epsilon units).
  epsilon_budget REAL NOT NULL DEFAULT 1.0,
  -- Cumulative epsilon spent on aggregate decryptions this window.
  epsilon_spent REAL NOT NULL DEFAULT 0.0,
  -- Per-decryption epsilon cost.
  epsilon_per_query REAL NOT NULL DEFAULT 0.1,
  -- k-anonymity floor: smallest cohort we will ever decrypt.
  min_cohort INTEGER NOT NULL DEFAULT 5,
  -- Start of the budget accounting window (used for manual reset / auditability).
  window_started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_privacy_budget_dao ON privacy_budget(dao_id);