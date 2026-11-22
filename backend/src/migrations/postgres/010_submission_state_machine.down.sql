-- Postgres rollback 019
DROP INDEX IF EXISTS idx_submission_lease;
DROP INDEX IF EXISTS idx_submission_state;
DROP INDEX IF EXISTS idx_submission_nullifier;
DROP TABLE IF EXISTS submission_state;
