-- Migration 022: Treasury multisig signing sessions (ZV-039 / #888)
--
-- Off-chain coordination for an on-chain treasury proposal
-- (contracts/threshold-crypto `treasury_*`): which signers have signed the
-- proposal's digest, whether the threshold is met, and how it was executed.

CREATE TABLE IF NOT EXISTS treasury_signing_sessions (
    id               TEXT    PRIMARY KEY,
    proposal_id      INTEGER NOT NULL,
    digest           TEXT    NOT NULL,           -- 64 hex chars, the contract's proposal digest
    action           TEXT    NOT NULL,           -- JSON: { kind: "spend" | "rotate", ... }
    signers          TEXT    NOT NULL,           -- JSON array of G... signer addresses (config snapshot)
    required         INTEGER NOT NULL,           -- approvals needed, by the contract's rule
    expires_at       INTEGER NOT NULL,           -- unix seconds, the proposal's expiry
    status           TEXT    NOT NULL DEFAULT 'collecting'
                     CHECK (status IN ('collecting','ready','executed','expired')),
    stellar_tx_hash  TEXT,
    created_by       TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE (proposal_id, digest)
);

CREATE TABLE IF NOT EXISTS treasury_session_signatures (
    session_id   TEXT    NOT NULL REFERENCES treasury_signing_sessions(id),
    signer       TEXT    NOT NULL,
    signature    TEXT    NOT NULL,                -- base64 ed25519 (SEP-53 message signature)
    signed_at    INTEGER NOT NULL,
    PRIMARY KEY (session_id, signer)
);
