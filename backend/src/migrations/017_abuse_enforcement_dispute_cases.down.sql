-- Rollback migration 017: Abuse-detection enforcement and dispute-case linkage
DROP INDEX IF EXISTS idx_dispute_cases_status;
DROP INDEX IF EXISTS idx_dispute_cases_tenant;
DROP INDEX IF EXISTS idx_dispute_cases_hold;
DROP TABLE IF EXISTS dispute_cases;

DROP INDEX IF EXISTS idx_payment_holds_payment_ref;
DROP INDEX IF EXISTS idx_payment_holds_status;
DROP INDEX IF EXISTS idx_payment_holds_tenant;
DROP TABLE IF EXISTS payment_holds;
