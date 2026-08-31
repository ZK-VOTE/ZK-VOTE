-- Reverse migration 005 (#324)
DROP INDEX IF EXISTS idx_encrypted_content_dao_epoch;
DROP TABLE IF EXISTS encrypted_content;
DROP TABLE IF EXISTS dao_recovery_shares;
DROP INDEX IF EXISTS idx_dao_key_wraps_member;
DROP TABLE IF EXISTS dao_key_wraps;
DROP INDEX IF EXISTS idx_dao_group_keys_active;
DROP TABLE IF EXISTS dao_group_keys;
