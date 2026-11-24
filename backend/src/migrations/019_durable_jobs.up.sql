-- Migration 019: Durable job queue with leases (ZV-069)
--
-- A persisted job queue that survives process restarts.  Workers claim jobs
-- with an atomic lease; expired leases are picked up by other workers.
-- Dead-lettered jobs (too many retries) are preserved for investigation.

CREATE TABLE IF NOT EXISTS jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    business_key    TEXT,                   -- idempotency key; NULL means no dedup
    job_type        TEXT    NOT NULL,       -- e.g. "payout", "rollup", "analytics"
    payload         TEXT    NOT NULL DEFAULT '{}',  -- JSON, refs only — no secrets
    status          TEXT    NOT NULL DEFAULT 'ready'
                    CHECK (status IN ('ready','leased','retrying','dead')),
    lease_expires_at INTEGER,              -- epoch-ms; NULL when status != 'leased'
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 5,
    run_after       INTEGER NOT NULL DEFAULT 0,     -- epoch-ms; for delayed jobs
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_business_key
    ON jobs (business_key)
    WHERE business_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_claimable
    ON jobs (status, run_after, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_jobs_type_status
    ON jobs (job_type, status);
