-- ============================================
-- Migration 004 rollback: Remove canonical_proof_hash
-- Created: 2026-08-30
-- ============================================
--
-- SQLite does not support DROP COLUMN in older versions, so we only drop the
-- index here. The column becomes a harmless extra column if the schema is
-- ever inspected without the migration applied.

DROP INDEX IF EXISTS idx_proof_commitments_canonical;
