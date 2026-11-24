-- Migration 021: EVM bridge relayer state (ZV-038 / #887)
--
-- A checkpoint of the last scanned EVM block (with its hash, to detect
-- reorgs) and one row per forwarded vote. A vote is keyed by its nullifier
-- within a proposal: the same vote can be re-observed after a reorg, but it is
-- relayed to Soroban at most once.

CREATE TABLE IF NOT EXISTS bridge_relay_checkpoints (
    contract_address TEXT    PRIMARY KEY,      -- lower-case 0x address of Bridge.sol
    block_number     INTEGER NOT NULL,         -- last fully scanned block
    block_hash       TEXT    NOT NULL,         -- its hash, to detect reorgs
    updated_at       INTEGER NOT NULL          -- epoch-ms
);

CREATE TABLE IF NOT EXISTS bridge_relay_votes (
    dao_id           TEXT    NOT NULL,
    proposal_id      TEXT    NOT NULL,
    nullifier        TEXT    NOT NULL,         -- 0x-prefixed 32-byte hex
    vote_choice      INTEGER NOT NULL,
    vote_root        TEXT    NOT NULL,
    evm_tx_hash      TEXT    NOT NULL,
    evm_log_index    INTEGER NOT NULL,
    block_number     INTEGER NOT NULL,
    block_hash       TEXT    NOT NULL,
    status           TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','relayed','failed','rolled_back','orphaned')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    stellar_tx_hash  TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (dao_id, proposal_id, nullifier)
);

CREATE INDEX IF NOT EXISTS idx_bridge_relay_votes_status ON bridge_relay_votes (status, block_number);
