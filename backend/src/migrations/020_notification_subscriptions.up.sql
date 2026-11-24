-- Migration 020: Notification subscriptions (ZV-037 / #886)
--
-- Preferences are keyed by an anonymous contact token: a random value the
-- subscriber keeps (it is in every unsubscribe link). Nothing here links a
-- destination to a wallet address, DAO membership or vote.

CREATE TABLE IF NOT EXISTS notification_subscriptions (
    token           TEXT    PRIMARY KEY,           -- random, 32 bytes hex
    channel         TEXT    NOT NULL CHECK (channel IN ('email','webpush')),
    destination     TEXT    NOT NULL,              -- email address, or WebPush subscription JSON
    event_types     TEXT    NOT NULL DEFAULT '[]', -- JSON array; empty means every type
    dao_ids         TEXT    NOT NULL DEFAULT '[]', -- JSON array; empty means every DAO
    created_at      INTEGER NOT NULL,              -- epoch-ms
    updated_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL               -- epoch-ms; expired rows are skipped and purged
);

CREATE INDEX IF NOT EXISTS idx_notification_subscriptions_expires
    ON notification_subscriptions (expires_at);
