-- Migration 011: Notification subscriptions (ZV-037 / #886). Mirrors the
-- SQLite migration 020; epoch-ms timestamps need BIGINT here.

CREATE TABLE IF NOT EXISTS notification_subscriptions (
    token           TEXT    PRIMARY KEY,
    channel         TEXT    NOT NULL CHECK (channel IN ('email','webpush')),
    destination     TEXT    NOT NULL,
    event_types     TEXT    NOT NULL DEFAULT '[]',
    dao_ids         TEXT    NOT NULL DEFAULT '[]',
    created_at      BIGINT  NOT NULL,
    updated_at      BIGINT  NOT NULL,
    expires_at      BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_subscriptions_expires
    ON notification_subscriptions (expires_at);
