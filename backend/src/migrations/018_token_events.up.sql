-- Migration 018: SEP-41 token event projection tables (ZV-065)
--
-- Raw verified token events, plus three projections rebuilt from them:
--   token_balances      — current balance per address
--   token_delegates     — current delegate per address
--   token_checkpoints   — per-address balance checkpoints keyed by ledger
--
-- Reorg handling: delete rows with ledger > fork_point, then replay forward.

CREATE TABLE IF NOT EXISTS token_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT    NOT NULL CHECK (event_type IN ('token_mint','token_burn','token_transfer','token_delegate','token_checkpoint')),
    address     TEXT    NOT NULL,       -- primary subject (from/account/owner)
    to_address  TEXT,                   -- destination for transfers
    amount      TEXT,                   -- i128 as decimal string
    ledger      INTEGER NOT NULL,
    tx_hash     TEXT,
    timestamp   TEXT    NOT NULL,
    verified    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_token_events_address ON token_events (address);
CREATE INDEX IF NOT EXISTS idx_token_events_ledger  ON token_events (ledger);
CREATE INDEX IF NOT EXISTS idx_token_events_type    ON token_events (event_type, ledger);

-- Current balance projection (upserted on each mint/burn/transfer).
CREATE TABLE IF NOT EXISTS token_balances (
    address       TEXT    PRIMARY KEY,
    balance       TEXT    NOT NULL DEFAULT '0',  -- i128 as decimal string
    last_ledger   INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Current delegate projection (upserted on each DelegateChanged event).
CREATE TABLE IF NOT EXISTS token_delegates (
    address       TEXT    PRIMARY KEY,
    delegate      TEXT    NOT NULL,
    last_ledger   INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Balance checkpoint index keyed by (address, ledger).
-- Populated from Checkpoint events; used for point-in-time snapshot queries.
CREATE TABLE IF NOT EXISTS token_checkpoints (
    address       TEXT    NOT NULL,
    ledger        INTEGER NOT NULL,
    balance       TEXT    NOT NULL,  -- i128 as decimal string
    tx_hash       TEXT,
    timestamp     TEXT    NOT NULL,
    PRIMARY KEY (address, ledger)
);

CREATE INDEX IF NOT EXISTS idx_token_checkpoints_ledger ON token_checkpoints (ledger);
