-- Reverse migration 004 (#322)
DROP INDEX IF EXISTS idx_vote_receipts_dao_proposal;
DROP INDEX IF EXISTS idx_daos_member_count;
DROP INDEX IF EXISTS idx_events_verified_type;
DROP INDEX IF EXISTS idx_events_type_timestamp;
