-- ============================================
-- Migration 004: Governance analytics support (#322)
-- Created: 2026-08-31
--
-- Indexes for the aggregations behind /api/v1/analytics. Per-DAO partitions
-- (events_{daoId}) are created at runtime, so their composite indexes are
-- built idempotently by ensureAnalyticsIndexes() in services/analytics.ts.
-- This migration covers the static tables those queries also touch.
-- ============================================

-- Turnout groups vote_cast / proposal_created rows by type then orders them by
-- time; the composite index lets SQLite satisfy both from one B-tree.
CREATE INDEX IF NOT EXISTS idx_events_type_timestamp
  ON events(type, timestamp);

-- Cross-DAO rollups filter on verified before grouping by type.
CREATE INDEX IF NOT EXISTS idx_events_verified_type
  ON events(verified, type);

-- Turnout's denominator is the DAO's cached member count.
CREATE INDEX IF NOT EXISTS idx_daos_member_count
  ON daos(member_count);

-- Receipt-derived participation is joined per DAO and proposal.
CREATE INDEX IF NOT EXISTS idx_vote_receipts_dao_proposal
  ON vote_receipts(dao_id, proposal_id);
