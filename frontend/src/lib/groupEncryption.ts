/**
 * DAO Group-Key Encryption for Governance Content (#324)
 *
 * Browser half of the end-to-end scheme in `backend/src/services/encryption.ts`.
 * The two must agree byte for byte: the same AES-256-GCM parameters, the same
 * HKDF derivation, and — most importantly — the same domain strings, since the
 * domain is authenticated as AAD and any divergence surfaces as an
 * indistinguishable "unable to decrypt".
 *
 * This is a strict upgrade over `encryption.ts`, which protects member aliases
 * only. Bodies encrypted here are opaque to the relay, to IPFS, and to anyone
 * who is not currently a member of the DAO.
 *
 * Uses WebCrypto rather than tweetnacl (which the alias path uses) because the
 * relay-side envelope is AES-GCM; mixing primitives across the boundary would
 * mean neither side could open the other's ciphertext.
 */

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const DOMAIN_PREFIX_BYTES = 4;
const TAG_BITS = 128;

export const ENVELOPE_VERSION = 1 as const;

export type ContentType = "proposal" | "comment";

export interface ContentEnvelope {
  v: typeof ENVELOPE_VERSION;
  daoId: number;
  epoch: number;
  contentType: ContentType;
  contentId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface KeyEpoch {
  daoId: number;
  epoch: number;
  threshold: number;
  memberCount: number;
  keyCommitment: string;
  rotationReason: string;
  createdAt: string;
  active: boolean;
}

// ============================================
// ENCODING HELPERS
// ============================================

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ============================================
// DOMAINS — must match the relay exactly
// ============================================

export function contentDomain(
  daoId: number,
  epoch: number,
  contentType: ContentType,
  contentId: string,
): string {
  return `zkvote/e2e/v1/content/dao=${daoId}/epoch=${epoch}/type=${contentType}/id=${contentId}`;
}

export function wrapDomain(
  daoId: number,
  epoch: number,
  memberId: string,
): string {
  return `zkvote/e2e/v1/wrap/dao=${daoId}/epoch=${epoch}/member=${memberId}`;
}

/**
 * Nonce for a domain: a deterministic 4-byte tag over the domain followed by
 * 8 random bytes. The tag partitions the nonce space per content so two
 * different bodies can never collide under the same key.
 */
async function deriveNonce(domain: string): Promise<Uint8Array> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(domain)),
  );
  const random = crypto.getRandomValues(
    new Uint8Array(NONCE_BYTES - DOMAIN_PREFIX_BYTES),
  );
  return concat(digest.subarray(0, DOMAIN_PREFIX_BYTES), random);
}

// ============================================
// KEYS
// ============================================

/** Fresh 256-bit group key. Never leaves the device unsealed. */
export function generateGroupKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/** Public commitment to a group key; lets clients verify a recovered key. */
export async function keyCommitment(groupKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    concat(textEncoder.encode("zkvote/e2e/v1/key-commitment"), groupKey),
  );
  return toHex(new Uint8Array(digest));
}

/**
 * Derive a member's wrapping key from their long-term secret (typically a
 * wallet signature). Bound to the DAO and member ID, so one device secret
 * yields unrelated keys across DAOs.
 */
export async function deriveMemberKey(
  memberSecret: Uint8Array,
  daoId: number,
  memberId: string,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    memberSecret as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textEncoder.encode(`zkvote/e2e/v1/member-salt/${daoId}`),
      info: textEncoder.encode(`zkvote/e2e/v1/member-key/${daoId}/${memberId}`),
    },
    baseKey,
    KEY_BYTES * 8,
  );

  return new Uint8Array(bits);
}

async function importAesKey(
  raw: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) {
    throw new Error(`Invalid key: expected ${KEY_BYTES} bytes`);
  }
  return crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM" },
    false,
    usages,
  );
}

/** Seal the group key to one member. The relay stores this blob unopened. */
export async function wrapGroupKeyForMember(
  groupKey: Uint8Array,
  memberKey: Uint8Array,
  daoId: number,
  epoch: number,
  memberId: string,
): Promise<string> {
  const domain = wrapDomain(daoId, epoch, memberId);
  const nonce = await deriveNonce(domain);
  const key = await importAesKey(memberKey, ["encrypt"]);

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce as BufferSource,
        additionalData: textEncoder.encode(domain),
        tagLength: TAG_BITS,
      },
      key,
      groupKey as BufferSource,
    ),
  );

  // WebCrypto appends the tag to the ciphertext, matching the relay's layout
  // of nonce || ciphertext || tag.
  return toBase64(concat(nonce, sealed));
}

/**
 * Open a member's wrap.
 *
 * Throws for the wrong member key, and for a wrap lifted from another DAO,
 * epoch or member — all three are authenticated in the AAD.
 */
export async function unwrapGroupKeyForMember(
  wrapped: string,
  memberKey: Uint8Array,
  daoId: number,
  epoch: number,
  memberId: string,
): Promise<Uint8Array> {
  const raw = fromBase64(wrapped);
  if (raw.length <= NONCE_BYTES) throw new Error("Malformed wrapped group key");

  const key = await importAesKey(memberKey, ["decrypt"]);
  const domain = wrapDomain(daoId, epoch, memberId);

  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: raw.subarray(0, NONCE_BYTES) as BufferSource,
        additionalData: textEncoder.encode(domain),
        tagLength: TAG_BITS,
      },
      key,
      raw.subarray(NONCE_BYTES) as BufferSource,
    );
    return new Uint8Array(opened);
  } catch {
    throw new Error("Not authorized to open this group key");
  }
}

// ============================================
// CONTENT
// ============================================

/** Encrypt a proposal or comment body to the DAO's current group key. */
export async function encryptContent(
  groupKey: Uint8Array,
  params: {
    daoId: number;
    epoch: number;
    contentType: ContentType;
    contentId: string;
    plaintext: string;
  },
): Promise<ContentEnvelope> {
  const domain = contentDomain(
    params.daoId,
    params.epoch,
    params.contentType,
    params.contentId,
  );
  const nonce = await deriveNonce(domain);
  const key = await importAesKey(groupKey, ["encrypt"]);

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce as BufferSource,
        additionalData: textEncoder.encode(domain),
        tagLength: TAG_BITS,
      },
      key,
      textEncoder.encode(params.plaintext) as BufferSource,
    ),
  );

  // The relay stores ciphertext and tag separately; split them here.
  const tagBytes = TAG_BITS / 8;
  return {
    v: ENVELOPE_VERSION,
    daoId: params.daoId,
    epoch: params.epoch,
    contentType: params.contentType,
    contentId: params.contentId,
    nonce: toBase64(nonce),
    ciphertext: toBase64(sealed.subarray(0, sealed.length - tagBytes)),
    tag: toBase64(sealed.subarray(sealed.length - tagBytes)),
  };
}

/**
 * Decrypt a body.
 *
 * The domain is rebuilt from the envelope's own fields, so an envelope moved to
 * another proposal or replayed across a rotation fails authentication rather
 * than decrypting.
 */
export async function decryptContent(
  groupKey: Uint8Array,
  envelope: ContentEnvelope,
): Promise<string> {
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported envelope version: ${String(envelope.v)}`);
  }

  const key = await importAesKey(groupKey, ["decrypt"]);
  const domain = contentDomain(
    envelope.daoId,
    envelope.epoch,
    envelope.contentType,
    envelope.contentId,
  );

  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(envelope.nonce) as BufferSource,
        additionalData: textEncoder.encode(domain),
        tagLength: TAG_BITS,
      },
      key,
      concat(
        fromBase64(envelope.ciphertext),
        fromBase64(envelope.tag),
      ) as BufferSource,
    );
    return textDecoder.decode(opened);
  } catch {
    throw new Error("Unable to decrypt governance content");
  }
}

// ============================================
// SESSION CACHE
// ============================================

/**
 * Group keys are cached in `sessionStorage`, not `localStorage`.
 *
 * A group key opens every body in the DAO, so it should not outlive the tab.
 * Rotation is keyed into the storage slot so a stale epoch key is never
 * silently reused after the DAO has moved on.
 */
function groupKeyStorageKey(daoId: number, epoch: number): string {
  return `dao_group_key_${daoId}_epoch_${epoch}`;
}

export function cacheGroupKey(
  daoId: number,
  epoch: number,
  groupKey: Uint8Array,
): void {
  try {
    sessionStorage.setItem(groupKeyStorageKey(daoId, epoch), toBase64(groupKey));
  } catch {
    // Private-mode browsers reject session storage; callers just re-derive.
  }
}

export function getCachedGroupKey(
  daoId: number,
  epoch: number,
): Uint8Array | null {
  try {
    const stored = sessionStorage.getItem(groupKeyStorageKey(daoId, epoch));
    return stored ? fromBase64(stored) : null;
  } catch {
    return null;
  }
}

/** Drop every cached group key for a DAO — call on rotation or on sign-out. */
export function clearCachedGroupKeys(daoId: number): void {
  try {
    const prefix = `dao_group_key_${daoId}_epoch_`;
    const doomed: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(prefix)) doomed.push(key);
    }
    for (const key of doomed) sessionStorage.removeItem(key);
  } catch {
    // Nothing cached if storage is unavailable.
  }
}
