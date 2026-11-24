-- Postgres parity for 019: Durable vote submission state machine (#921 ZV-078)
CREATE TABLE IF NOT EXISTS submission_state (
  idempotency_key  TEXT        PRIMARY KEY,
  nullifier_hash   TEXT        NOT NULL,
  state            TEXT        NOT NULL DEFAULT 'PENDING'
                   CHECK(state IN ('PENDING','SUBMITTED','CONFIRMING','CONFIRMED','FAILED','CONFLICT','EXPIRED')),
  tx_hash          TEXT,
  error_code       TEXT,
  error_message    TEXT,
  lease_expires_at BIGINT,
  retry_count      INTEGER     NOT NULL DEFAULT 0,
  created_at       BIGINT      NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000),
  updated_at       BIGINT      NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)
);

CREATE INDEX IF NOT EXISTS idx_submission_nullifier ON submission_state (nullifier_hash);
CREATE INDEX IF NOT EXISTS idx_submission_state     ON submission_state (state);
CREATE INDEX IF NOT EXISTS idx_submission_lease     ON submission_state (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;
