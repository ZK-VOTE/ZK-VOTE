-- ============================================
-- Migration 003 (Postgres): Add vote_receipts table
-- Parity target: ../003_add_vote_receipts.up.sql
-- ============================================

CREATE TABLE IF NOT EXISTS vote_receipts (
  id BIGSERIAL PRIMARY KEY,
  nullifier TEXT NOT NULL UNIQUE,
  tx_hash TEXT NOT NULL,
  proposal_id BIGINT NOT NULL,
  dao_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'pending', 'failed')),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),

  FOREIGN KEY (dao_id) REFERENCES daos(id)
);

CREATE INDEX IF NOT EXISTS idx_vote_receipts_nullifier ON vote_receipts(nullifier);
CREATE INDEX IF NOT EXISTS idx_vote_receipts_dao_created ON vote_receipts(dao_id, created_at);
CREATE INDEX IF NOT EXISTS idx_vote_receipts_proposal ON vote_receipts(proposal_id);
