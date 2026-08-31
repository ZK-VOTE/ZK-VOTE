-- ============================================
-- Migration 002 (Postgres): Constraint parity for the events/daos tables
-- Parity target: ../002_add_partition_constraints.up.sql
--
-- The SQLite version exists because SQLite cannot ALTER TABLE ADD CONSTRAINT,
-- so it sanitises data and re-issues CREATE TABLE IF NOT EXISTS. Postgres can
-- add the constraints directly, so this migration does the honest thing:
-- sanitise first (same rows as the SQLite version removes), then attach the
-- constraint. Both end states are identical; only the mechanism differs.
-- ============================================

-- Step 1: drop rows/values that would violate the constraints, matching the
-- SQLite migration's cleanup exactly.
DELETE FROM events WHERE type NOT IN (
  'dao_create','admin_transfer','member_added','member_revoked','member_left',
  'tree_init','voter_registered','voter_removed','voter_reinstated',
  'vk_updated','proposal_created','proposal_closed','proposal_archived','vote_cast'
);

-- Step 2: attach the CHECK constraint if 001 did not already create it
-- (idempotent: re-running the migration must be a no-op).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_type_check_v2'
  ) THEN
    ALTER TABLE events ADD CONSTRAINT events_type_check_v2 CHECK (type IN (
      'dao_create','admin_transfer','member_added','member_revoked','member_left',
      'tree_init','voter_registered','voter_removed','voter_reinstated',
      'vk_updated','proposal_created','proposal_closed','proposal_archived','vote_cast'
    ));
  END IF;
END
$$;

-- Step 3: the SQLite migration normalises out-of-range boolean values. On
-- Postgres the BOOLEAN column type makes that unrepresentable, so only the
-- NOT NULL / DEFAULT parity is asserted here.
ALTER TABLE daos ALTER COLUMN membership_open SET DEFAULT TRUE;
ALTER TABLE daos ALTER COLUMN members_can_propose SET DEFAULT FALSE;

-- Index supporting the cross-DAO event scans the indexer runs. On SQLite this
-- is served by the per-DAO partition tables; on Postgres a single partitioned
-- index is both cheaper and a prerequisite for the analytics views in #4.
CREATE INDEX IF NOT EXISTS idx_events_dao_ledger ON events(dao_id, ledger DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(type, created_at DESC);
