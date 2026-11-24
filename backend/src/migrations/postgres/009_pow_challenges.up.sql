-- Postgres parity for 018: Shared PoW challenge store (#918 ZV-074)
CREATE TABLE IF NOT EXISTS pow_challenges (
  server_id  TEXT        PRIMARY KEY,
  commitment TEXT        NOT NULL,
  difficulty INTEGER     NOT NULL,
  created_at BIGINT      NOT NULL,
  expires_at BIGINT      NOT NULL,
  consumed   BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_pow_expires    ON pow_challenges (expires_at);
CREATE INDEX IF NOT EXISTS idx_pow_commitment ON pow_challenges (commitment);
