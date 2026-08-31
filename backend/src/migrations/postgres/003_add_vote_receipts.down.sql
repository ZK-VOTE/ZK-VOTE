-- ============================================
-- Migration 003 (Postgres): Rollback vote_receipts table
-- Parity target: ../003_add_vote_receipts.down.sql
-- ============================================

DROP INDEX IF EXISTS idx_vote_receipts_proposal;
DROP INDEX IF EXISTS idx_vote_receipts_dao_created;
DROP INDEX IF EXISTS idx_vote_receipts_nullifier;
DROP TABLE IF EXISTS vote_receipts;
