-- Migration 018: Shared PoW challenge store (#918 ZV-074)
-- Moves challenge storage from an in-process Map to a shared table so a
-- challenge issued on replica A can be consumed on replica B exactly once.

CREATE TABLE IF NOT EXISTS pow_challenges (
  server_id    TEXT    PRIMARY KEY,
  commitment   TEXT    NOT NULL,
  difficulty   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,   -- Unix epoch ms
  expires_at   INTEGER NOT NULL,   -- Unix epoch ms
  consumed     INTEGER NOT NULL DEFAULT 0  -- 0 = fresh, 1 = consumed (atomic toggle)
);

CREATE INDEX IF NOT EXISTS idx_pow_expires    ON pow_challenges (expires_at);
CREATE INDEX IF NOT EXISTS idx_pow_commitment ON pow_challenges (commitment);
