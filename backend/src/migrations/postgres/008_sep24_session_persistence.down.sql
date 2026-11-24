-- Rollback Migration 008: SEP-24 Session Persistence (ZV-119)

DROP INDEX IF EXISTS idx_registry_pins_registry_id;
DROP INDEX IF EXISTS idx_registry_pin_audit_dao_id;
DROP TABLE IF EXISTS registry_pin_audit;
DROP TABLE IF EXISTS registry_pins;

DROP INDEX IF EXISTS idx_sep24_security_events_occurred_at;
DROP INDEX IF EXISTS idx_sep24_security_events_session_id;
DROP INDEX IF EXISTS idx_sep24_completions_session_id;
DROP INDEX IF EXISTS idx_sep24_session_tokens_current;
DROP INDEX IF EXISTS idx_sep24_session_tokens_session_id;
DROP INDEX IF EXISTS idx_sep24_sessions_created_at;
DROP INDEX IF EXISTS idx_sep24_sessions_expires_at;
DROP INDEX IF EXISTS idx_sep24_sessions_account;

DROP TABLE IF EXISTS sep24_security_events;
DROP TABLE IF EXISTS sep24_completions;
DROP TABLE IF EXISTS sep24_session_tokens;
DROP TABLE IF EXISTS sep24_sessions;
