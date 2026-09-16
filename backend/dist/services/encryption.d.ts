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
/** Envelope format version; bumped if the AAD or nonce construction changes. */
export declare const ENVELOPE_VERSION: 1;
/** Content kinds that may be stored encrypted. */
export declare const CONTENT_TYPES: readonly ["proposal", "comment"];
export type ContentType = (typeof CONTENT_TYPES)[number];
export type RotationReason = "genesis" | "member_joined" | "member_left" | "member_revoked" | "manual";
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
export declare function splitSecret(secret: Buffer, shareCount: number, threshold: number): SecretShare[];
/**
 * Recover a secret from `threshold` or more shares by Lagrange interpolation
 * at x = 0. Fewer than the threshold produces a wrong value, not an error —
 * that is the point of the scheme, so callers verify against the epoch's key
 * commitment rather than trusting the result.
 */
export declare function combineShares(shares: SecretShare[]): Buffer;
/** Fresh 256-bit group key. Generated on a member device, never on the relay. */
export declare function generateGroupKey(): Buffer;
/**
 * Public commitment to a group key.
 *
 * Lets the relay tell two epochs apart, and lets a client confirm it
 * reconstructed the right key from recovery shares, without either learning the
 * key. Domain-separated so the digest is not a generic hash oracle.
 */
export declare function keyCommitment(groupKey: Buffer): string;
/**
 * Derive a member's personal wrapping key from their long-term secret.
 *
 * Bound to the DAO and member ID so the same device secret yields unrelated
 * keys across DAOs, and a wrap cannot be replayed at another member's slot.
 */
export declare function deriveMemberKey(memberSecret: Buffer, daoId: number, memberId: string): Buffer;
export interface WrappedKey {
    daoId: number;
    epoch: number;
    memberId: string;
    /** base64 of nonce || ciphertext || tag. */
    wrapped: string;
}
/** Seal a group key to one member. The result is opaque to the relay. */
export declare function wrapGroupKeyForMember(groupKey: Buffer, memberKey: Buffer, daoId: number, epoch: number, memberId: string): WrappedKey;
/**
 * Open a member's wrap.
 *
 * Throws for a non-member (no wrap exists to pass in), for the wrong member key,
 * and for a wrap lifted from another DAO, epoch or member — the domain is
 * authenticated, so any of those fail the GCM tag rather than returning
 * garbage.
 */
export declare function unwrapGroupKeyForMember(wrapped: WrappedKey, memberKey: Buffer, daoId: number, epoch: number, memberId: string): Buffer;
/**
 * Domain string bound into every ciphertext for a piece of content.
 *
 * Including the epoch is what stops a ciphertext surviving a rotation: after a
 * member leaves, content re-encrypted under the new epoch has a different
 * domain, so an old ciphertext cannot be substituted for it.
 */
export declare function contentDomain(daoId: number, epoch: number, contentType: ContentType, contentId: string): string;
/**
 * Nonce for a domain: a deterministic 4-byte domain tag followed by 8 random
 * bytes.
 *
 * The tag partitions the nonce space per domain so two different contents can
 * never collide, and the random suffix keeps nonces unique within a domain
 * across re-encryptions. The full domain is additionally authenticated as AAD,
 * so the tag is a partition, not the security boundary.
 */
export declare function deriveNonce(domain: string): Buffer;
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
export declare function encryptContent(groupKey: Buffer, params: {
    daoId: number;
    epoch: number;
    contentType: ContentType;
    contentId: string;
    plaintext: string;
}): ContentEnvelope;
/**
 * Decrypt a governance body.
 *
 * The domain is rebuilt from the envelope's own fields, so an envelope whose
 * `daoId`, `epoch`, `contentType` or `contentId` was edited in transit fails
 * the tag check instead of decrypting under a domain it was never sealed for.
 */
export declare function decryptContent(groupKey: Buffer, envelope: ContentEnvelope): string;
/**
 * Log-safe view of an envelope.
 *
 * Ciphertext length is a coarse proxy for body length, which is already
 * observable from storage, but the bytes themselves never reach a log line
 * where they could be correlated against a later disclosure.
 */
export declare function redactEnvelopeForLog(envelope: ContentEnvelope): Record<string, unknown>;
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
export declare function initEncryptionSchema(): void;
/**
 * Record a new key epoch, superseding the previous one.
 *
 * `wraps` and `shares` must already be sealed. This function has no parameter
 * that could carry a raw group key — the trust boundary is enforced by the
 * signature, not by a convention.
 */
export declare function recordGroupKeyEpoch(params: {
    daoId: number;
    epoch: number;
    threshold: number;
    keyCommitment: string;
    rotationReason: RotationReason;
    wraps: WrappedKey[];
    recoveryShares: Array<{
        index: number;
        wrappedShare: string;
    }>;
}): GroupKeyEpoch;
/** The DAO's current key epoch, or `null` if it has never had one. */
export declare function getActiveEpoch(daoId: number): GroupKeyEpoch | null;
/** Next epoch number for a DAO. Epochs start at 1 and never reuse a value. */
export declare function nextEpoch(daoId: number): number;
/**
 * The wrap for one member at one epoch, or `null` when none exists.
 *
 * A `null` here is how a non-member is turned away: there is nothing to hand
 * back, and the relay could not decrypt on their behalf even if it wanted to.
 */
export declare function getWrappedKey(daoId: number, epoch: number, memberId: string): WrappedKey | null;
/** Sealed recovery shares for an epoch, for a threshold reconstruction. */
export declare function getRecoveryShares(daoId: number, epoch: number): Array<{
    index: number;
    wrappedShare: string;
}>;
/** Persist a ciphertext envelope. Overwrites the previous body for that ID. */
export declare function storeCiphertext(envelope: ContentEnvelope): void;
/** Load a stored body. Redacted rows come back with a `null` envelope. */
export declare function loadCiphertext(daoId: number, contentType: ContentType, contentId: string): StoredContent | null;
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
export declare function redactContent(daoId: number, contentType: ContentType, contentId: string, reason: string): boolean;
/**
 * Whether a reconstructed key matches an epoch's commitment.
 *
 * Compared in constant time: the commitment is public, but a timing oracle on
 * "how many leading bytes were right" would help an attacker grind shares.
 */
export declare function verifyGroupKey(groupKey: Buffer, epoch: GroupKeyEpoch): boolean;
//# sourceMappingURL=encryption.d.ts.map