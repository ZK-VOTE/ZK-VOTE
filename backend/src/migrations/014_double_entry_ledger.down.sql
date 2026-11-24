-- ============================================
-- Migration 014 rollback
-- ============================================

DROP INDEX IF EXISTS idx_ledger_postings_group;
DROP TABLE IF EXISTS ledger_postings;

DROP INDEX IF EXISTS idx_settlement_transitions_key;
DROP TABLE IF EXISTS settlement_transitions;

DROP INDEX IF EXISTS idx_settlement_callbacks_key;
DROP TABLE IF EXISTS settlement_callbacks;

DROP INDEX IF EXISTS idx_settlement_records_state;
DROP TABLE IF EXISTS settlement_records;
