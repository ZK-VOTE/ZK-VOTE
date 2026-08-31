-- ============================================
-- Rollback Migration 002 (Postgres)
-- Parity target: ../002_add_partition_constraints.down.sql
-- ============================================

DROP INDEX IF EXISTS idx_events_type_created;
DROP INDEX IF EXISTS idx_events_dao_ledger;
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_type_check_v2;
DROP TABLE IF EXISTS events_v2;
