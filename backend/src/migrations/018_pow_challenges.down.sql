-- Rollback 018
DROP INDEX IF EXISTS idx_pow_commitment;
DROP INDEX IF EXISTS idx_pow_expires;
DROP TABLE IF EXISTS pow_challenges;
