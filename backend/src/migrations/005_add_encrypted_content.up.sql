-- ============================================
-- Migration 005: E2E encrypted governance content (#324)
-- Created: 2026-08-31
--
-- The relay is a ciphertext store. Nothing in this schema can be decrypted by
-- the relay: group keys are only ever present as a commitment, as blobs sealed
-- to a member, or as sealed Shamir recovery shares.
-- ============================================

-- One row per DAO key epoch. Membership changes create a new epoch; the
-- previous one is marked inactive but kept so historical content stays
-- attributable to the key it was sealed under.
CREATE TABLE IF NOT EXISTS dao_group_keys (
  dao_id INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  -- Shamir threshold required to reconstruct the key from recovery shares.
  threshold INTEGER NOT NULL,
  member_count INTEGER NOT NULL,
  -- SHA-256 commitment to the group key. Public; reveals nothing about the key.
  key_commitment TEXT NOT NULL,
  rotation_reason TEXT NOT NULL CHECK(rotation_reason IN (
    'genesis', 'member_joined', 'member_left', 'member_revoked', 'manual'
  )),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (dao_id, epoch)
);

CREATE INDEX IF NOT EXISTS idx_dao_group_keys_active
  ON dao_group_keys(dao_id, active, epoch DESC);

-- The group key sealed to each member's own key. Opaque to the relay: it holds
-- these so a member can fetch their copy from any device, not so it can read.
CREATE TABLE IF NOT EXISTS dao_key_wraps (
  dao_id INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (dao_id, epoch, member_id)
);

CREATE INDEX IF NOT EXISTS idx_dao_key_wraps_member
  ON dao_key_wraps(dao_id, member_id);

-- Sealed Shamir shares. A quorum recovers an epoch key if every member device
-- is lost; below the threshold they are information-theoretically useless.
CREATE TABLE IF NOT EXISTS dao_recovery_shares (
  dao_id INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  share_index INTEGER NOT NULL CHECK(share_index BETWEEN 1 AND 255),
  wrapped_share TEXT NOT NULL,
  PRIMARY KEY (dao_id, epoch, share_index)
);

-- Proposal and comment bodies as ciphertext. `redacted` rows keep the row (so
-- governance references still resolve) with the ciphertext columns nulled.
CREATE TABLE IF NOT EXISTS encrypted_content (
  dao_id INTEGER NOT NULL,
  content_type TEXT NOT NULL CHECK(content_type IN ('proposal', 'comment')),
  content_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  nonce TEXT,
  ciphertext TEXT,
  tag TEXT,
  redacted INTEGER NOT NULL DEFAULT 0 CHECK(redacted IN (0, 1)),
  redacted_at TEXT,
  redaction_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (dao_id, content_type, content_id),
  -- A redacted row must carry no ciphertext, and a live row must be complete.
  CHECK (
    (redacted = 1 AND nonce IS NULL AND ciphertext IS NULL AND tag IS NULL)
    OR
    (redacted = 0 AND nonce IS NOT NULL AND ciphertext IS NOT NULL AND tag IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_encrypted_content_dao_epoch
  ON encrypted_content(dao_id, epoch);
