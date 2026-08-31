-- ============================================
-- Migration 004: relay metadata encryption tables
-- Created: 2026-08-31
-- ============================================

CREATE TABLE IF NOT EXISTS relay_session_capabilities (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  dao_id INTEGER,
  nonce TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_relay_session_capabilities_client ON relay_session_capabilities(client_id);
CREATE INDEX IF NOT EXISTS idx_relay_session_capabilities_dao ON relay_session_capabilities(dao_id);
CREATE INDEX IF NOT EXISTS idx_relay_session_capabilities_expires ON relay_session_capabilities(expires_at);

CREATE TABLE IF NOT EXISTS relay_metadata_envelopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL,
  dao_id INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('verification-key', 'threshold', 'tally', 'relay-metadata')),
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_relay_metadata_envelopes_key ON relay_metadata_envelopes(key_id);
CREATE INDEX IF NOT EXISTS idx_relay_metadata_envelopes_dao ON relay_metadata_envelopes(dao_id);
CREATE INDEX IF NOT EXISTS idx_relay_metadata_envelopes_kind ON relay_metadata_envelopes(kind);
