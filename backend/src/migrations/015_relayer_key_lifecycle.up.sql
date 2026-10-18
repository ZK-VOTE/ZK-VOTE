-- ============================================
-- Migration 015: Relayer key lifecycle (#746)
-- ============================================
-- Audit trail of rotations, compromise declarations, sweeps and halts, and
-- the persisted revocation list that keeps a compromised relayer key revoked
-- across restarts. SqliteKeyLifecycleStore also creates these tables at boot
-- (CREATE ... IF NOT EXISTS) because revocations must be readable before the
-- migration runner; this file keeps the schema in the migration history.

CREATE TABLE IF NOT EXISTS relayer_key_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  key_id TEXT,
  public_key TEXT,
  actor TEXT NOT NULL,
  reason TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relayer_key_events_created ON relayer_key_events(created_at);

CREATE TABLE IF NOT EXISTS relayer_key_revocations (
  public_key TEXT PRIMARY KEY,
  key_id TEXT,
  reason TEXT NOT NULL,
  declared_by TEXT NOT NULL,
  declared_at INTEGER NOT NULL
);
