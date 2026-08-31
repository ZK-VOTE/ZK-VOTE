-- ============================================
-- Migration 004: Proposal lifecycle notification subscriptions
-- Created: 2026-08-30
-- ============================================

CREATE TABLE IF NOT EXISTS proposal_lifecycle_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dao_id INTEGER NOT NULL,
  wallet_address_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(dao_id, wallet_address_hash)
);

CREATE INDEX IF NOT EXISTS idx_proposal_lifecycle_subscriptions_dao
  ON proposal_lifecycle_subscriptions(dao_id);
CREATE INDEX IF NOT EXISTS idx_proposal_lifecycle_subscriptions_active
  ON proposal_lifecycle_subscriptions(dao_id, active);
CREATE INDEX IF NOT EXISTS idx_proposal_lifecycle_subscriptions_unique
  ON proposal_lifecycle_subscriptions(dao_id, wallet_address_hash);

CREATE TABLE IF NOT EXISTS proposal_lifecycle_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dao_id INTEGER NOT NULL,
  proposal_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  wallet_address_hash TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(dao_id, proposal_id, event_type, wallet_address_hash)
);

CREATE INDEX IF NOT EXISTS idx_proposal_lifecycle_notifications_dao
  ON proposal_lifecycle_notifications(dao_id);
CREATE INDEX IF NOT EXISTS idx_proposal_lifecycle_notifications_event
  ON proposal_lifecycle_notifications(dao_id, event_type);
CREATE INDEX IF NOT EXISTS idx_proposal_lifecycle_notifications_unique
  ON proposal_lifecycle_notifications(dao_id, proposal_id, event_type, wallet_address_hash);
