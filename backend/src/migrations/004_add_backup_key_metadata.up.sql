-- ============================================
-- Migration 004: Backup encryption key metadata
-- Created: 2026-08-30
-- ============================================

-- Audit trail for backup encryption key lifecycle (Issue #359).
-- Records when keys were created / rotated / archived so operators can
-- determine which key era a snapshot belongs to and confirm rotation.
-- The key material itself is NEVER stored in the database.

CREATE TABLE IF NOT EXISTS backup_keys (
  key_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  source TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 1,
  rotated_from TEXT,
  event_type TEXT NOT NULL DEFAULT 'created'
);

CREATE INDEX IF NOT EXISTS idx_backup_keys_created ON backup_keys(created_at);
CREATE INDEX IF NOT EXISTS idx_backup_keys_rotated_from ON backup_keys(rotated_from);