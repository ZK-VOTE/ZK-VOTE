-- Rollback durable state-machine tables (Postgres).
DROP TABLE IF EXISTS circuit_vk_revocations;
DROP TABLE IF EXISTS circuit_vk_cache;
DROP TABLE IF EXISTS randomness_commits;
DROP TABLE IF EXISTS randomness_shares;
DROP TABLE IF EXISTS randomness_orderings;
DROP TABLE IF EXISTS rate_quota_overrides;
DROP TABLE IF EXISTS shared_rate_buckets;
DROP TABLE IF EXISTS factory_saga_events;
DROP TABLE IF EXISTS factory_saga_steps;
DROP TABLE IF EXISTS factory_sagas;
