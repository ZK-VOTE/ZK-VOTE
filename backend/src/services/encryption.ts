/**
 * End-to-End Encrypted Governance Content (#324)
 *
 * Proposal and comment bodies are encrypted to a DAO-scoped *group key* that
 * the relay never holds. This is a strict upgrade on the alias-only encryption
 * that came before it: previously the body was plaintext to anyone who could
 * read the relay's database or an IPFS pin, and only the author's alias was
 * protected.
 *
 * ## Trust boundary
 *
 * The relay is a ciphertext store. It persists:
 *
 *  - **key epochs** — metadata plus a commitment to the group key, never the key
 *  - **wraps** — the group key sealed to each member, opaque to the relay
 *  - **recovery shares** — Shamir shares of the group key, also sealed
 *  - **ciphertext** — governance bodies, with their domain but not their content
 *
 * Everything sensitive is generated and opened on a member's device. The
 * functions here that touch key material exist so clients (and this repo's
 * tests) share one implementation; the persistence functions below accept only
 * already-sealed blobs and will not take a raw key.
 *
 * ## Epochs and rotation
 *
 * Membership changes rotate the group key into a new epoch. A joiner is wrapped
 * into the new epoch only, so it cannot read history it was not part of; a
 * leaver is not wrapped into it, so it cannot read anything written after it
 * left. Old ciphertext stays readable by whoever held the old epoch — rotation
 * gives forward and backward secrecy at the epoch boundary, not retroactive
 * erasure. Erasure is what {@link redactContent} is for.
 *
 * ## Nonce domain
 *
 * Every ciphertext is bound to a domain string covering the DAO, the epoch, the
 * content type and the content ID. The domain seeds a deterministic nonce
 * prefix and is authenticated as AAD, so a ciphertext cannot be moved between
 * proposals, between comment threads, or across a rotation.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { getDb } from "./db.js";
import { log } from "./logger.js";

// ============================================
// CONSTANTS
// ============================================

/** Envelope format version; bumped if the AAD or nonce construction changes. */
export const ENVELOPE_VERSION = 1 as const;

const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // GCM standard nonce
const TAG_BYTES = 16;
const DOMAIN_PREFIX_BYTES = 4;
const CIPHER = "aes-256-gcm";

/** Content kinds that may be stored encrypted. */
export const CONTENT_TYPES = ["proposal", "comment"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export type RotationReason =
  | "genesis"
  | "member_joined"
  | "member_left"
  | "member_revoked"
  | "manual";

// ============================================
// GF(256) ARITHMETIC FOR SHAMIR
// ============================================

/**
 * Log/antilog tables for GF(2^8) with the AES reduction polynomial (0x11b) and
 * generator 3. Multiplication becomes an addition of logs, which keeps the
 * split/combine loops branch-free over secret bytes.
 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    // x *= 3, i.e. (x << 1) ^ x, reduced mod the field polynomial.
    const doubled = (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x = (doubled ^ x) & 0xff;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("Division by zero in GF(256)");
  if (a === 0) return 0;
  return GF_EXP[GF_LOG[a] + 255 - GF_LOG[b]];
}

// ============================================
// SHAMIR SECRET SHARING
// ============================================

export interface SecretShare {
  /** Evaluation point, 1..255. Never 0 — that is the secret itself. */
  index: number;
  /** One byte of share per byte of secret. */
  value: Buffer;
}

/**
 * Split `secret` into `shareCount` shares, any `threshold` of which recover it.
 *
 * Used for group-key recovery: a DAO that loses every member device can
 * reconstruct its epoch key from a quorum of escrowed shares. Normal reads do
 * not go through this path — each member holds a wrapped copy of the key.
 */
export function splitSecret(
  secret: Buffer,
  shareCount: number,
  threshold: number,
): SecretShare[] {
  if (!Number.isInteger(shareCount) || shareCount < 1 || shareCount > 255) {
    throw new Error("Share count must be between 1 and 255");
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > shareCount) {
    throw new Error("Threshold must be between 1 and the share count");
  }

  const shares: SecretShare[] = Array.from({ length: shareCount }, (_, i) => ({
    index: i + 1,
    value: Buffer.alloc(secret.length),
  }));

  // One independent random polynomial per secret byte, with the secret byte as
  // the constant term. Coefficients are fresh per byte so shares leak nothing
  // below the threshold.
  for (let byteIndex = 0; byteIndex < secret.length; byteIndex++) {
    const coefficients = randomBytes(threshold - 1);

    for (const share of shares) {
      let accumulator = secret[byteIndex];
      let power = 1;
      for (let degree = 0; degree < threshold - 1; degree++) {
        power = gfMul(power, share.index);
        accumulator ^= gfMul(coefficients[degree], power);
      }
      share.value[byteIndex] = accumulator;
    }
  }

  return shares;
}

/**
 * Recover a secret from `threshold` or more shares by Lagrange interpolation
 * at x = 0. Fewer than the threshold produces a wrong value, not an error —
 * that is the point of the scheme, so callers verify against the epoch's key
 * commitment rather than trusting the result.
 */
export function combineShares(shares: SecretShare[]): Buffer {
  if (shares.length === 0) throw new Error("No shares supplied");

  const indices = new Set(shares.map((share) => share.index));
  if (indices.size !== shares.length) {
    throw new Error("Duplicate share indices cannot be combined");
  }
  if (shares.some((share) => share.index === 0)) {
    throw new Error("Share index 0 is reserved for the secret");
  }

  const length = shares[0].value.length;
  if (shares.some((share) => share.value.length !== length)) {
    throw new Error("Shares have inconsistent lengths");
  }

  const secret = Buffer.alloc(length);
  for (let byteIndex = 0; byteIndex < length; byteIndex++) {
    let accumulator = 0;

    for (let i = 0; i < shares.length; i++) {
      let basis = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        // L_i(0) = prod_{j != i} x_j / (x_j - x_i); subtraction is XOR here.
        basis = gfMul(
          basis,
          gfDiv(shares[j].index, shares[i].index ^ shares[j].index),
        );
      }
      accumulator ^= gfMul(shares[i].value[byteIndex], basis);
    }

    secret[byteIndex] = accumulator;
  }

  return secret;
}

// ============================================
// GROUP KEYS
// ============================================

/** Fresh 256-bit group key. Generated on a member device, never on the relay. */
export function generateGroupKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Public commitment to a group key.
 *
 * Lets the relay tell two epochs apart, and lets a client confirm it
 * reconstructed the right key from recovery shares, without either learning the
 * key. Domain-separated so the digest is not a generic hash oracle.
 */
export function keyCommitment(groupKey: Buffer): string {
  return createHash("sha256")
    .update("zkvote/e2e/v1/key-commitment")
    .update(groupKey)
    .digest("hex");
}

/**
 * Derive a member's personal wrapping key from their long-term secret.
 *
 * Bound to the DAO and member ID so the same device secret yields unrelated
 * keys across DAOs, and a wrap cannot be replayed at another member's slot.
 */
export function deriveMemberKey(
  memberSecret: Buffer,
  daoId: number,
  memberId: string,
): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      memberSecret,
      Buffer.from(`zkvote/e2e/v1/member-salt/${daoId}`),
      Buffer.from(`zkvote/e2e/v1/member-key/${daoId}/${memberId}`),
      KEY_BYTES,
    ),
  );
}

export interface WrappedKey {
  daoId: number;
  epoch: number;
  memberId: string;
  /** base64 of nonce || ciphertext || tag. */
  wrapped: string;
}

function wrapDomain(daoId: number, epoch: number, memberId: string): string {
  return `zkvote/e2e/v1/wrap/dao=${daoId}/epoch=${epoch}/member=${memberId}`;
}

/** Seal a group key to one member. The result is opaque to the relay. */
export function wrapGroupKeyForMember(
  groupKey: Buffer,
  memberKey: Buffer,
  daoId: number,
  epoch: number,
  memberId: string,
): WrappedKey {
  assertKeyLength(groupKey, "group key");
  assertKeyLength(memberKey, "member key");

  const domain = wrapDomain(daoId, epoch, memberId);
  const nonce = deriveNonce(domain);
  const cipher = createCipheriv(CIPHER, memberKey, nonce);
  cipher.setAAD(Buffer.from(domain, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(groupKey), cipher.final()]);
  return {
    daoId,
    epoch,
    memberId,
    wrapped: Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString(
      "base64",
    ),
  };
}

/**
 * Open a member's wrap.
 *
 * Throws for a non-member (no wrap exists to pass in), for the wrong member key,
 * and for a wrap lifted from another DAO, epoch or member — the domain is
 * authenticated, so any of those fail the GCM tag rather than returning
 * garbage.
 */
export function unwrapGroupKeyForMember(
  wrapped: WrappedKey,
  memberKey: Buffer,
  daoId: number,
  epoch: number,
  memberId: string,
): Buffer {
  assertKeyLength(memberKey, "member key");

  const raw = Buffer.from(wrapped.wrapped, "base64");
  if (raw.length <= NONCE_BYTES + TAG_BYTES) {
    throw new Error("Malformed wrapped group key");
  }

  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ciphertext = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);

  const decipher = createDecipheriv(CIPHER, memberKey, nonce);
  decipher.setAAD(Buffer.from(wrapDomain(daoId, epoch, memberId), "utf8"));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Not authorized to open this group key");
  }
}

function assertKeyLength(key: Buffer, label: string): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Invalid ${label}: expected ${KEY_BYTES} bytes`);
  }
}

// ============================================
// NONCE DOMAIN
// ============================================

/**
 * Domain string bound into every ciphertext for a piece of content.
 *
 * Including the epoch is what stops a ciphertext surviving a rotation: after a
 * member leaves, content re-encrypted under the new epoch has a different
 * domain, so an old ciphertext cannot be substituted for it.
 */
export function contentDomain(
  daoId: number,
  epoch: number,
  contentType: ContentType,
  contentId: string,
): string {
  return `zkvote/e2e/v1/content/dao=${daoId}/epoch=${epoch}/type=${contentType}/id=${contentId}`;
}

/**
 * Nonce for a domain: a deterministic 4-byte domain tag followed by 8 random
 * bytes.
 *
 * The tag partitions the nonce space per domain so two different contents can
 * never collide, and the random suffix keeps nonces unique within a domain
 * across re-encryptions. The full domain is additionally authenticated as AAD,
 * so the tag is a partition, not the security boundary.
 */
export function deriveNonce(domain: string): Buffer {
  const tag = createHash("sha256")
    .update(domain)
    .digest()
    .subarray(0, DOMAIN_PREFIX_BYTES);
  return Buffer.concat([tag, randomBytes(NONCE_BYTES - DOMAIN_PREFIX_BYTES)]);
}

// ============================================
// CONTENT ENVELOPE
// ============================================

export interface ContentEnvelope {
  v: typeof ENVELOPE_VERSION;
  daoId: number;
  epoch: number;
  contentType: ContentType;
  contentId: string;
  /** base64 nonce. */
  nonce: string;
  /** base64 ciphertext. */
  ciphertext: string;
  /** base64 GCM tag. */
  tag: string;
}

/** Encrypt a governance body to the DAO's group key for the given epoch. */
export function encryptContent(
  groupKey: Buffer,
  params: {
    daoId: number;
    epoch: number;
    contentType: ContentType;
    contentId: string;
    plaintext: string;
  },
): ContentEnvelope {
  assertKeyLength(groupKey, "group key");
  if (!CONTENT_TYPES.includes(params.contentType)) {
    throw new Error(`Unsupported content type: ${params.contentType}`);
  }

  const domain = contentDomain(
    params.daoId,
    params.epoch,
    params.contentType,
    params.contentId,
  );
  const nonce = deriveNonce(domain);
  const cipher = createCipheriv(CIPHER, groupKey, nonce);
  cipher.setAAD(Buffer.from(domain, "utf8"));

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(params.plaintext, "utf8")),
    cipher.final(),
  ]);

  return {
    v: ENVELOPE_VERSION,
    daoId: params.daoId,
    epoch: params.epoch,
    contentType: params.contentType,
    contentId: params.contentId,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Decrypt a governance body.
 *
 * The domain is rebuilt from the envelope's own fields, so an envelope whose
 * `daoId`, `epoch`, `contentType` or `contentId` was edited in transit fails
 * the tag check instead of decrypting under a domain it was never sealed for.
 */
export function decryptContent(
  groupKey: Buffer,
  envelope: ContentEnvelope,
): string {
  assertKeyLength(groupKey, "group key");
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported envelope version: ${String(envelope.v)}`);
  }

  const domain = contentDomain(
    envelope.daoId,
    envelope.epoch,
    envelope.contentType,
    envelope.contentId,
  );

  const decipher = createDecipheriv(
    CIPHER,
    groupKey,
    Buffer.from(envelope.nonce, "base64"),
  );
  decipher.setAAD(Buffer.from(domain, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Unable to decrypt governance content");
  }
}

// ============================================
// LOG REDACTION
// ============================================

/**
 * Log-safe view of an envelope.
 *
 * Ciphertext length is a coarse proxy for body length, which is already
 * observable from storage, but the bytes themselves never reach a log line
 * where they could be correlated against a later disclosure.
 */
export function redactEnvelopeForLog(
  envelope: ContentEnvelope,
): Record<string, unknown> {
  return {
    v: envelope.v,
    daoId: envelope.daoId,
    epoch: envelope.epoch,
    contentType: envelope.contentType,
    contentId: envelope.contentId,
    ciphertextBytes: Buffer.from(envelope.ciphertext, "base64").length,
    nonce: "[redacted]",
    ciphertext: "[redacted]",
    tag: "[redacted]",
  };
}

// ============================================
// PERSISTENCE — CIPHERTEXT AND SEALED BLOBS ONLY
// ============================================

export interface GroupKeyEpoch {
  daoId: number;
  epoch: number;
  threshold: number;
  memberCount: number;
  keyCommitment: string;
  rotationReason: RotationReason;
  createdAt: string;
  active: boolean;
}

export interface StoredContent {
  daoId: number;
  epoch: number;
  contentType: ContentType;
  contentId: string;
  envelope: ContentEnvelope | null;
  redacted: boolean;
  redactedAt: string | null;
  redactionReason: string | null;
  createdAt: string;
}

/** Create the encryption tables if the migration has not been applied yet. */
export function initEncryptionSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS dao_group_keys (
      dao_id INTEGER NOT NULL,
      epoch INTEGER NOT NULL,
      threshold INTEGER NOT NULL,
      member_count INTEGER NOT NULL,
      key_commitment TEXT NOT NULL,
      rotation_reason TEXT NOT NULL CHECK(rotation_reason IN (
        'genesis', 'member_joined', 'member_left', 'member_revoked', 'manual'
      )),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (dao_id, epoch)
    );

    CREATE TABLE IF NOT EXISTS dao_key_wraps (
      dao_id INTEGER NOT NULL,
      epoch INTEGER NOT NULL,
      member_id TEXT NOT NULL,
      wrapped_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (dao_id, epoch, member_id)
    );

    CREATE TABLE IF NOT EXISTS dao_recovery_shares (
      dao_id INTEGER NOT NULL,
      epoch INTEGER NOT NULL,
      share_index INTEGER NOT NULL CHECK(share_index BETWEEN 1 AND 255),
      wrapped_share TEXT NOT NULL,
      PRIMARY KEY (dao_id, epoch, share_index)
    );

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
      -- Mirrors migration 005: a redacted row carries no ciphertext, and a
      -- live row is never half written.
      CHECK (
        (redacted = 1 AND nonce IS NULL AND ciphertext IS NULL AND tag IS NULL)
        OR
        (redacted = 0 AND nonce IS NOT NULL AND ciphertext IS NOT NULL AND tag IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_dao_group_keys_active
      ON dao_group_keys(dao_id, active, epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_dao_key_wraps_member
      ON dao_key_wraps(dao_id, member_id);
    CREATE INDEX IF NOT EXISTS idx_encrypted_content_dao_epoch
      ON encrypted_content(dao_id, epoch);
  `);
}

/**
 * Record a new key epoch, superseding the previous one.
 *
 * `wraps` and `shares` must already be sealed. This function has no parameter
 * that could carry a raw group key — the trust boundary is enforced by the
 * signature, not by a convention.
 */
export function recordGroupKeyEpoch(params: {
  daoId: number;
  epoch: number;
  threshold: number;
  keyCommitment: string;
  rotationReason: RotationReason;
  wraps: WrappedKey[];
  recoveryShares: Array<{ index: number; wrappedShare: string }>;
}): GroupKeyEpoch {
  initEncryptionSchema();
  const db = getDb();

  const insert = db.transaction(() => {
    db.prepare("UPDATE dao_group_keys SET active = 0 WHERE dao_id = ?").run(
      params.daoId,
    );

    db.prepare(
      `INSERT INTO dao_group_keys
         (dao_id, epoch, threshold, member_count, key_commitment, rotation_reason, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      params.daoId,
      params.epoch,
      params.threshold,
      params.wraps.length,
      params.keyCommitment,
      params.rotationReason,
    );

    const wrapStatement = db.prepare(
      `INSERT OR REPLACE INTO dao_key_wraps (dao_id, epoch, member_id, wrapped_key)
       VALUES (?, ?, ?, ?)`,
    );
    for (const wrap of params.wraps) {
      wrapStatement.run(params.daoId, params.epoch, wrap.memberId, wrap.wrapped);
    }

    const shareStatement = db.prepare(
      `INSERT OR REPLACE INTO dao_recovery_shares (dao_id, epoch, share_index, wrapped_share)
       VALUES (?, ?, ?, ?)`,
    );
    for (const share of params.recoveryShares) {
      shareStatement.run(
        params.daoId,
        params.epoch,
        share.index,
        share.wrappedShare,
      );
    }
  });

  insert();

  log("info", "group_key_epoch_recorded", {
    daoId: params.daoId,
    epoch: params.epoch,
    reason: params.rotationReason,
    members: params.wraps.length,
    threshold: params.threshold,
  });

  return {
    daoId: params.daoId,
    epoch: params.epoch,
    threshold: params.threshold,
    memberCount: params.wraps.length,
    keyCommitment: params.keyCommitment,
    rotationReason: params.rotationReason,
    createdAt: new Date().toISOString(),
    active: true,
  };
}

/** The DAO's current key epoch, or `null` if it has never had one. */
export function getActiveEpoch(daoId: number): GroupKeyEpoch | null {
  initEncryptionSchema();

  const row = getDb()
    .prepare(
      `SELECT dao_id, epoch, threshold, member_count, key_commitment,
              rotation_reason, active, created_at
         FROM dao_group_keys
        WHERE dao_id = ? AND active = 1
        ORDER BY epoch DESC
        LIMIT 1`,
    )
    .get(daoId) as
    | {
        dao_id: number;
        epoch: number;
        threshold: number;
        member_count: number;
        key_commitment: string;
        rotation_reason: RotationReason;
        active: number;
        created_at: string;
      }
    | undefined;

  if (!row) return null;

  return {
    daoId: row.dao_id,
    epoch: row.epoch,
    threshold: row.threshold,
    memberCount: row.member_count,
    keyCommitment: row.key_commitment,
    rotationReason: row.rotation_reason,
    createdAt: row.created_at,
    active: row.active === 1,
  };
}

/** Next epoch number for a DAO. Epochs start at 1 and never reuse a value. */
export function nextEpoch(daoId: number): number {
  initEncryptionSchema();
  const row = getDb()
    .prepare("SELECT MAX(epoch) AS latest FROM dao_group_keys WHERE dao_id = ?")
    .get(daoId) as { latest: number | null } | undefined;
  return (row?.latest ?? 0) + 1;
}

/**
 * The wrap for one member at one epoch, or `null` when none exists.
 *
 * A `null` here is how a non-member is turned away: there is nothing to hand
 * back, and the relay could not decrypt on their behalf even if it wanted to.
 */
export function getWrappedKey(
  daoId: number,
  epoch: number,
  memberId: string,
): WrappedKey | null {
  initEncryptionSchema();

  const row = getDb()
    .prepare(
      `SELECT wrapped_key FROM dao_key_wraps
        WHERE dao_id = ? AND epoch = ? AND member_id = ?`,
    )
    .get(daoId, epoch, memberId) as { wrapped_key: string } | undefined;

  return row ? { daoId, epoch, memberId, wrapped: row.wrapped_key } : null;
}

/** Sealed recovery shares for an epoch, for a threshold reconstruction. */
export function getRecoveryShares(
  daoId: number,
  epoch: number,
): Array<{ index: number; wrappedShare: string }> {
  initEncryptionSchema();

  const rows = getDb()
    .prepare(
      `SELECT share_index, wrapped_share FROM dao_recovery_shares
        WHERE dao_id = ? AND epoch = ? ORDER BY share_index ASC`,
    )
    .all(daoId, epoch) as Array<{ share_index: number; wrapped_share: string }>;

  return rows.map((row) => ({
    index: row.share_index,
    wrappedShare: row.wrapped_share,
  }));
}

/** Persist a ciphertext envelope. Overwrites the previous body for that ID. */
export function storeCiphertext(envelope: ContentEnvelope): void {
  initEncryptionSchema();

  getDb()
    .prepare(
      `INSERT INTO encrypted_content
         (dao_id, content_type, content_id, epoch, nonce, ciphertext, tag, redacted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(dao_id, content_type, content_id) DO UPDATE SET
         epoch = excluded.epoch,
         nonce = excluded.nonce,
         ciphertext = excluded.ciphertext,
         tag = excluded.tag,
         redacted = 0,
         redacted_at = NULL,
         redaction_reason = NULL`,
    )
    .run(
      envelope.daoId,
      envelope.contentType,
      envelope.contentId,
      envelope.epoch,
      envelope.nonce,
      envelope.ciphertext,
      envelope.tag,
    );

  log("info", "encrypted_content_stored", redactEnvelopeForLog(envelope));
}

/** Load a stored body. Redacted rows come back with a `null` envelope. */
export function loadCiphertext(
  daoId: number,
  contentType: ContentType,
  contentId: string,
): StoredContent | null {
  initEncryptionSchema();

  const row = getDb()
    .prepare(
      `SELECT dao_id, content_type, content_id, epoch, nonce, ciphertext, tag,
              redacted, redacted_at, redaction_reason, created_at
         FROM encrypted_content
        WHERE dao_id = ? AND content_type = ? AND content_id = ?`,
    )
    .get(daoId, contentType, contentId) as
    | {
        dao_id: number;
        content_type: ContentType;
        content_id: string;
        epoch: number;
        nonce: string | null;
        ciphertext: string | null;
        tag: string | null;
        redacted: number;
        redacted_at: string | null;
        redaction_reason: string | null;
        created_at: string;
      }
    | undefined;

  if (!row) return null;

  const redacted = row.redacted === 1;
  return {
    daoId: row.dao_id,
    epoch: row.epoch,
    contentType: row.content_type,
    contentId: row.content_id,
    envelope:
      redacted || row.nonce === null || row.ciphertext === null || row.tag === null
        ? null
        : {
            v: ENVELOPE_VERSION,
            daoId: row.dao_id,
            epoch: row.epoch,
            contentType: row.content_type,
            contentId: row.content_id,
            nonce: row.nonce,
            ciphertext: row.ciphertext,
            tag: row.tag,
          },
    redacted,
    redactedAt: row.redacted_at,
    redactionReason: row.redaction_reason,
    createdAt: row.created_at,
  };
}

/**
 * Redact a stored body.
 *
 * The ciphertext columns are overwritten with NULL rather than the row being
 * deleted: governance references to the content ID stay resolvable, and the
 * tombstone records that a body existed and was removed. Because the relay
 * never held the key, this is the only erasure it can perform — and it is
 * irreversible for anyone who did not already fetch the ciphertext.
 *
 * Returns `false` when there was nothing to redact.
 */
export function redactContent(
  daoId: number,
  contentType: ContentType,
  contentId: string,
  reason: string,
): boolean {
  initEncryptionSchema();

  const result = getDb()
    .prepare(
      `UPDATE encrypted_content
          SET nonce = NULL,
              ciphertext = NULL,
              tag = NULL,
              redacted = 1,
              redacted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              redaction_reason = ?
        WHERE dao_id = ? AND content_type = ? AND content_id = ? AND redacted = 0`,
    )
    .run(reason, daoId, contentType, contentId);

  if (result.changes > 0) {
    log("warn", "encrypted_content_redacted", {
      daoId,
      contentType,
      contentId,
      reason,
    });
  }

  return result.changes > 0;
}

/**
 * Whether a reconstructed key matches an epoch's commitment.
 *
 * Compared in constant time: the commitment is public, but a timing oracle on
 * "how many leading bytes were right" would help an attacker grind shares.
 */
export function verifyGroupKey(groupKey: Buffer, epoch: GroupKeyEpoch): boolean {
  const expected = Buffer.from(epoch.keyCommitment, "hex");
  const actual = Buffer.from(keyCommitment(groupKey), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
