-- Rollback relayer key lifecycle tables.
-- WARNING: dropping relayer_key_revocations lets a compromised key that is
-- still configured become active again on the next restart.
DROP INDEX IF EXISTS idx_relayer_key_events_created;
DROP TABLE IF EXISTS relayer_key_events;
DROP TABLE IF EXISTS relayer_key_revocations;
