/**
 * Verified proving-key / artifact cache for ZK-VOTE (ZV-024 / ZV-033 / ZV-034).
 *
 * This module is the client half of the signed artifact supply chain described
 * in docs/PROVING_KEY_SUPPLY_CHAIN.md. It never returns an artifact that has
 * not passed *all* of these checks:
 *
 *   1. the manifest signature verifies against a trusted release key,
 *   2. the release key is neither retired past its rotation boundary nor revoked,
 *   3. the manifest's ceremonyTranscriptHash equals the value read from the
 *      circuit registry (or a pinned value carried by an offline bundle),
 *   4. the transparency-log entry hash binds the circuit, version, artifact
 *      digests, ceremony hash and release key,
 *   5. each zkey/wasm/vkey byte stream hashes to the pinned SHA-256 and size.
 *
 * Verification is incremental: chunks are hashed as they arrive, a size
 * overrun aborts the stream early, and bytes are only handed to the caller
 * after the final digest matches. Cached/offline copies are re-verified with
 * exactly the same logic. The module has no browser-only top-level side
 * effects, so it can also be exercised in Node.
 */

// ===========================================================================
// Constants and public types
// ===========================================================================

export const ARTIFACT_MANIFEST_SCHEMA = "zkvote.artifact-manifest/v1";
export const TRANSPARENCY_ENTRY_SCHEMA = "zkvote.transparency-entry/v1";
export const DEFAULT_LOG_ID = "zkvote-artifacts-v1";
export const ARTIFACT_KINDS = ["zkey", "wasm", "vkey"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

const CACHE_NAMESPACE = "zkvote-vkcache/v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Stable JSON: recursively sorted keys, no whitespace. Byte-identical to the
 * canonicalisation in circuits/ceremony/verify-ceremony.js. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") +
    "}"
  );
}

export interface ArtifactDescriptor {
  /** lowercase 64-char SHA-256 of the exact artifact bytes. */
  sha256: string;
  /** exact byte length; truncated or padded downloads are rejected. */
  size: number;
}

export interface TransparencyLogBinding {
  id: string;
  index: number;
  previousEntryHash: string | null;
  /** SHA-256 over the canonical transparency-log entry (see below). */
  entryHash: string;
}

export interface SignedArtifactManifest {
  schema: string;
  circuitId: string;
  version: number;
  /** ISO-8601 issuance time; used by release-key rotation policy. */
  issuedAt: string;
  ceremonyTranscriptHash: string;
  artifacts: Record<ArtifactKind, ArtifactDescriptor>;
  releaseKeyId: string;
  transparencyLog: TransparencyLogBinding;
  /** base64 (or 128-char hex) Ed25519 signature over the canonical unsigned manifest. */
  signature: string;
}

export interface TransparencyLogEntry {
  schema: string;
  logId: string;
  index: number;
  previousEntryHash: string | null;
  manifestHash: string;
  circuitId: string;
  version: number;
  ceremonyTranscriptHash: string;
  releaseKeyId: string;
  artifactHashes: Record<ArtifactKind, string>;
}

/** A release verification key and its lifecycle state.
 * `publicKey` accepts raw Ed25519 bytes (hex/base64), an Ed25519 SPKI PEM, a
 * JWK, or an imported CryptoKey. */
export interface TrustedReleaseKey {
  keyId: string;
  publicKey: string | JsonWebKey | CryptoKey;
  status?: "active" | "retired" | "revoked";
  /** Manifests issued at/after this instant are rejected for a retired key.
   * Accepts epoch milliseconds or an ISO-8601 string. */
  retiredAt?: number | string;
  /** Hard cutoff: every manifest signed by this key is rejected. */
  revokedAt?: number | string;
}

export type ArtifactVerificationReason =
  | "SUBTLE_UNAVAILABLE"
  | "MANIFEST_MISSING"
  | "MANIFEST_CACHE_MISS"
  | "MANIFEST_FETCH_FAILED"
  | "MANIFEST_MALFORMED"
  | "MANIFEST_UNSUPPORTED"
  | "MANIFEST_UNSIGNED"
  | "CIRCUIT_MISMATCH"
  | "VERSION_MISMATCH"
  | "KEY_MISSING"
  | "KEY_NOT_TRUSTED"
  | "KEY_RETIRED"
  | "KEY_REVOKED"
  | "SIGNATURE_INVALID"
  | "REGISTRY_UNAVAILABLE"
  | "REGISTRY_READ_FAILED"
  | "REGISTRY_HASH_MISSING"
  | "REGISTRY_HASH_INVALID"
  | "CEREMONY_HASH_MISMATCH"
  | "TRANSPARENCY_LOG_MISSING"
  | "TRANSPARENCY_LOG_MISMATCH"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_DOWNLOAD_FAILED"
  | "ARTIFACT_SIZE_MISMATCH"
  | "ARTIFACT_HASH_MISMATCH"
  | "ARTIFACT_MALFORMED"
  | "STREAM_ERROR";

export class ArtifactVerificationError extends Error {
  readonly code: ArtifactVerificationReason;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ArtifactVerificationReason,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ArtifactVerificationError";
    this.code = code;
    this.details = details;
  }
}

/** Backwards-friendly alias used by callers that only deal with VK loading. */
export { ArtifactVerificationError as VKIntegrityError };

export interface ArtifactCache {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface LoadVerifiedArtifactsOptions {
  circuitId: string;
  version: number;
  /** Pre-fetched manifest (skips manifest download). */
  manifest?: SignedArtifactManifest;
  manifestUrl?: string;
  /** Direct URLs for each artifact. */
  artifactUrls?: Partial<Record<ArtifactKind, string>>;
  /** Base URL; artifact names follow the release tooling convention. */
  artifactBaseUrl?: string;
  /** Reads the on-chain ceremony_transcript_hash for this circuit/version. */
  registryReader?:
    | ((circuitId: string, version: number) => Promise<string | null | undefined>)
    | ((circuitId: string, version: number) => string | null | undefined);
  /** Explicitly pinned registry hash (overrides the reader). */
  registryHash?: string;
  /** Optional independent lookup of the published transparency-log entry. */
  logReader?:
    | ((logId: string, index: number) => Promise<TransparencyLogEntry | null>)
    | ((logId: string, index: number) => TransparencyLogEntry | null);
  trustedKeys: TrustedReleaseKey | TrustedReleaseKey[];
  cache?: ArtifactCache;
  /** Offline mode: never fetch; use the cached manifest/registry/artifacts. */
  offline?: boolean;
  fetchFn?: typeof fetch;
  /** Injectable WebCrypto (useful for Node tests / non-browser runtimes). */
  subtle?: SubtleCrypto;
  /** Injectable clock for rotation/revocation tests. */
  now?: () => number;
}

export interface VerifiedArtifacts {
  circuitId: string;
  version: number;
  ceremonyTranscriptHash: string;
  manifestHash: string;
  manifest: SignedArtifactManifest;
  transparencyLogEntryHash: string;
  releaseKeyId: string;
  artifacts: {
    zkey: Uint8Array;
    wasm: Uint8Array;
    vkeyBytes: Uint8Array;
    verificationKey: unknown;
  };
  /** Which artifacts came from the cache rather than the network. */
  fromCache: Record<ArtifactKind, boolean>;
}

// ===========================================================================
// Incremental SHA-256 (no buffering of the whole artifact required)
// ===========================================================================

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
  0x5be0cd19,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Streaming SHA-256. Safe for artifacts up to 2^53 bytes (far beyond zkeys). */
export class Sha256Stream {
  private readonly state = SHA256_INIT.slice();
  private readonly block = new Uint8Array(64);
  private buffered = 0;
  private totalBytes = 0;
  private finalized = false;

  get size(): number {
    return this.totalBytes;
  }

  update(data: Uint8Array): this {
    if (this.finalized) throw new Error("Sha256Stream is already finalized");
    this.totalBytes += data.byteLength;
    let offset = 0;
    if (this.buffered > 0) {
      const needed = 64 - this.buffered;
      const take = Math.min(needed, data.byteLength);
      this.block.set(data.subarray(0, take), this.buffered);
      this.buffered += take;
      offset += take;
      if (this.buffered === 64) {
        this.compress(this.block, 0);
        this.buffered = 0;
      }
    }
    while (offset + 64 <= data.byteLength) {
      this.compress(data, offset);
      offset += 64;
    }
    if (offset < data.byteLength) {
      this.block.set(data.subarray(offset), this.buffered);
      this.buffered += data.byteLength - offset;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finalized) throw new Error("Sha256Stream is already finalized");
    this.finalized = true;

    const bitLength = this.totalBytes * 8;
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    const tailLength = ((this.buffered + 1 + 8 + 63) & ~63) - this.buffered;
    const tail = new Uint8Array(tailLength);
    tail[0] = 0x80;
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    view.setUint32(tailLength - 8, high, false);
    view.setUint32(tailLength - 4, low, false);

    if (this.buffered > 0) {
      const combined = new Uint8Array(this.buffered + tailLength);
      combined.set(this.block.subarray(0, this.buffered), 0);
      combined.set(tail, this.buffered);
      for (let offset = 0; offset < combined.byteLength; offset += 64) {
        this.compress(combined, offset);
      }
    } else {
      for (let offset = 0; offset < tailLength; offset += 64) {
        this.compress(tail, offset);
      }
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, this.state[i], false);
    return out;
  }

  hex(): string {
    return bytesToHex(this.digest());
  }

  private compress(data: Uint8Array, offset: number): void {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = this.state[0], b = this.state[1], c = this.state[2], d = this.state[3];
    let e = this.state[4], f = this.state[5], g = this.state[6], h = this.state[7];
    for (let i = 0; i < 64; i++) {
      const big1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + big1 + choose + SHA256_K[i] + w[i]) >>> 0;
      const big0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (big0 + majority) >>> 0;
      h = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

// ===========================================================================
// Encoding / hashing helpers
// ===========================================================================

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function normalizeHex(value: string, code: ArtifactVerificationReason): string {
  if (typeof value !== "string") {
    throw new ArtifactVerificationError(code, "Expected a hexadecimal digest");
  }
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new ArtifactVerificationError(code, `Invalid SHA-256 digest: ${value}`);
  }
  return normalized;
}

function fromHex(value: string): Uint8Array {
  const hex = value.trim().replace(/^0x/, "");
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new ArtifactVerificationError("KEY_NOT_TRUSTED", "Invalid hex key material");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function fromBase64(value: string): Uint8Array {
  const normalized = value
    .trim()
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/\s/g, "");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  if (typeof atob === "function") {
    binary = atob(padded);
  } else {
    throw new ArtifactVerificationError("SUBTLE_UNAVAILABLE", "No base64 decoder available");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Copy into an ArrayBuffer-backed view (WebCrypto BufferSource requirement). */
function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function hashUtf8(value: string): string {
  return new Sha256Stream().update(encoder.encode(value)).hex();
}

function spkiPemToRawEd25519(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s/g, "");
  const der = fromBase64(body);
  // An Ed25519 SubjectPublicKeyInfo is 44 bytes: 12-byte header + 32-byte key.
  if (der.length < 32) {
    throw new ArtifactVerificationError("KEY_NOT_TRUSTED", "Invalid Ed25519 SPKI PEM");
  }
  return der.subarray(der.length - 32);
}

function rawReleaseKeyBytes(publicKey: string): Uint8Array {
  const value = publicKey.trim();
  if (value.startsWith("-----BEGIN")) return spkiPemToRawEd25519(value);
  const hex = value.replace(/^0x/, "");
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return fromHex(hex);
  if (/^[0-9a-fA-F]{88}$/.test(hex)) {
    const der = fromHex(hex);
    return der.subarray(der.length - 32);
  }
  const decoded = fromBase64(value);
  return decoded.length === 32 || decoded.length === 44
    ? decoded.subarray(decoded.length - 32)
    : decoded;
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return (
    typeof value === "object" &&
    value !== null &&
    "algorithm" in value &&
    "type" in value &&
    (value as { type?: string }).type === "public"
  );
}

async function resolveSubtle(explicit?: SubtleCrypto): Promise<SubtleCrypto> {
  if (explicit) return explicit;
  const globalSubtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (globalSubtle) return globalSubtle;
  // Node / jsdom sandboxes may not expose WebCrypto on globalThis. Keep this
  // dynamic (and @vite-ignore) so browsers never try to bundle node:crypto.
  try {
    const specifier = "node:" + "crypto";
    const nodeCrypto = (await import(/* @vite-ignore */ specifier)) as {
      webcrypto?: { subtle: SubtleCrypto };
    };
    if (nodeCrypto.webcrypto?.subtle) return nodeCrypto.webcrypto.subtle;
  } catch {
    /* fall through */
  }
  throw new ArtifactVerificationError(
    "SUBTLE_UNAVAILABLE",
    "WebCrypto subtle (Ed25519 verify) is not available in this runtime",
  );
}

function toInstant(value: number | string | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

// ===========================================================================
// Manifest identity, transparency log and signature verification
// ===========================================================================

function manifestBody(manifest: SignedArtifactManifest): Record<string, unknown> {
  const { signature, ...rest } = manifest;
  void signature;
  const body = rest as Record<string, unknown>;
  if (body.transparencyLog && typeof body.transparencyLog === "object") {
    const { entryHash, ...log } = body.transparencyLog as Record<string, unknown>;
    void entryHash;
    body.transparencyLog = log;
  }
  return body;
}

/** Bytes covered by the release signature (all manifest fields except `signature`). */
export function manifestSignatureBytes(manifest: SignedArtifactManifest): Uint8Array<ArrayBuffer> {
  const { signature, ...rest } = manifest;
  void signature;
  return encoder.encode(canonicalJson(rest));
}

/** Stable manifest identity used by the transparency log. Excludes the
 * signature and the log's own entryHash to avoid a circular hash. */
export function computeManifestHash(manifest: SignedArtifactManifest): string {
  return hashUtf8(canonicalJson(manifestBody(manifest)));
}

export function buildTransparencyLogEntry(
  manifest: SignedArtifactManifest,
  options: {
    logId?: string;
    index?: number;
    previousEntryHash?: string | null;
  } = {},
): TransparencyLogEntry {
  const previous = options.previousEntryHash !== undefined
    ? options.previousEntryHash
    : manifest.transparencyLog?.previousEntryHash ?? null;
  return {
    schema: TRANSPARENCY_ENTRY_SCHEMA,
    logId: options.logId ?? manifest.transparencyLog?.id ?? DEFAULT_LOG_ID,
    index: options.index ?? manifest.transparencyLog?.index ?? 0,
    previousEntryHash: previous
      ? normalizeHex(previous, "TRANSPARENCY_LOG_MISMATCH")
      : null,
    manifestHash: computeManifestHash(manifest),
    circuitId: manifest.circuitId,
    version: manifest.version,
    ceremonyTranscriptHash: normalizeHex(
      manifest.ceremonyTranscriptHash,
      "CEREMONY_HASH_MISMATCH",
    ),
    releaseKeyId: manifest.releaseKeyId,
    artifactHashes: {
      zkey: normalizeHex(manifest.artifacts.zkey.sha256, "MANIFEST_MALFORMED"),
      wasm: normalizeHex(manifest.artifacts.wasm.sha256, "MANIFEST_MALFORMED"),
      vkey: normalizeHex(manifest.artifacts.vkey.sha256, "MANIFEST_MALFORMED"),
    },
  };
}

export function computeTransparencyLogEntryHash(entry: TransparencyLogEntry): string {
  return hashUtf8(canonicalJson(entry));
}

/** Rebuild the log entry from the signed manifest and verify the binding. When
 * `expectedLogId` is set, the entry must belong to that log. */
export function verifyTransparencyLogEntry(
  manifest: SignedArtifactManifest,
  entry: TransparencyLogEntry,
  expectedLogId?: string,
): string {
  if (!manifest.transparencyLog?.entryHash) {
    throw new ArtifactVerificationError(
      "TRANSPARENCY_LOG_MISSING",
      "Manifest does not pin a transparency log entry hash",
    );
  }
  if (!entry || typeof entry !== "object") {
    throw new ArtifactVerificationError(
      "TRANSPARENCY_LOG_MISSING",
      "No transparency log entry supplied",
    );
  }
  if (expectedLogId && entry.logId !== expectedLogId) {
    throw new ArtifactVerificationError(
      "TRANSPARENCY_LOG_MISMATCH",
      `Expected transparency log ${expectedLogId}, got ${entry.logId}`,
    );
  }
  const computed = computeTransparencyLogEntryHash(entry);
  if (computed !== normalizeHex(manifest.transparencyLog.entryHash, "MANIFEST_MALFORMED")) {
    throw new ArtifactVerificationError(
      "TRANSPARENCY_LOG_MISMATCH",
      `Transparency log entry hash mismatch (computed ${computed})`,
    );
  }
  const expected = buildTransparencyLogEntry(manifest, {
    logId: entry.logId,
    index: entry.index,
    previousEntryHash: entry.previousEntryHash,
  });
  const comparable: Array<keyof TransparencyLogEntry> = [
    "logId", "index", "manifestHash", "circuitId", "version",
    "ceremonyTranscriptHash", "releaseKeyId",
  ];
  for (const field of comparable) {
    if (entry[field] !== expected[field]) {
      throw new ArtifactVerificationError(
        "TRANSPARENCY_LOG_MISMATCH",
        `Transparency log ${field} does not match the signed manifest`,
        { expected: expected[field], actual: entry[field] },
      );
    }
  }
  for (const kind of ARTIFACT_KINDS) {
    if (entry.artifactHashes?.[kind] !== expected.artifactHashes[kind]) {
      throw new ArtifactVerificationError(
        "TRANSPARENCY_LOG_MISMATCH",
        `Transparency log ${kind} hash does not match the signed manifest`,
      );
    }
  }
  return computed;
}

export function assertManifestShape(manifest: SignedArtifactManifest): void {
  if (!manifest || typeof manifest !== "object" || manifest.schema !== ARTIFACT_MANIFEST_SCHEMA) {
    throw new ArtifactVerificationError(
      "MANIFEST_UNSUPPORTED",
      `Unsupported manifest schema: ${manifest?.schema ?? "(none)"}`,
    );
  }
  if (typeof manifest.circuitId !== "string" || !manifest.circuitId) {
    throw new ArtifactVerificationError("MANIFEST_MALFORMED", "Manifest circuitId is required");
  }
  if (!Number.isSafeInteger(manifest.version) || manifest.version < 0) {
    throw new ArtifactVerificationError("MANIFEST_MALFORMED", "Manifest version is invalid");
  }
  normalizeHex(manifest.ceremonyTranscriptHash, "MANIFEST_MALFORMED");
  if (!manifest.artifacts || !manifest.releaseKeyId || !manifest.transparencyLog?.id) {
    throw new ArtifactVerificationError("MANIFEST_MALFORMED", "Manifest is missing required fields");
  }
  for (const kind of ARTIFACT_KINDS) {
    const descriptor = manifest.artifacts[kind];
    if (!descriptor) {
      throw new ArtifactVerificationError("MANIFEST_MALFORMED", `Manifest missing ${kind} descriptor`);
    }
    normalizeHex(descriptor.sha256, "MANIFEST_MALFORMED");
    if (!Number.isSafeInteger(descriptor.size) || descriptor.size <= 0) {
      throw new ArtifactVerificationError("MANIFEST_MALFORMED", `Manifest ${kind} size is invalid`);
    }
  }
}

export interface VerifySignedManifestResult {
  valid: true;
  keyId: string;
  manifestHash: string;
}

/** Verify the Ed25519 signature and enforce release-key rotation/revocation. */
export async function verifySignedManifest(
  manifest: SignedArtifactManifest,
  trustedKeys: TrustedReleaseKey | TrustedReleaseKey[],
  options: { subtle?: SubtleCrypto; now?: number } = {},
): Promise<VerifySignedManifestResult> {
  assertManifestShape(manifest);
  if (!manifest.signature || typeof manifest.signature !== "string") {
    throw new ArtifactVerificationError("MANIFEST_UNSIGNED", "Manifest has no signature");
  }
  const keys = Array.isArray(trustedKeys) ? trustedKeys : [trustedKeys];
  const entry = keys.find((key) => key?.keyId === manifest.releaseKeyId);
  if (!entry) {
    throw new ArtifactVerificationError(
      "KEY_NOT_TRUSTED",
      `Release key ${manifest.releaseKeyId} is not in the trust store`,
    );
  }

  const now = options.now ?? Date.now();
  const revokedAt = toInstant(entry.revokedAt);
  if ((revokedAt !== null && now >= revokedAt) || (entry.status === "revoked" && revokedAt === null)) {
    throw new ArtifactVerificationError(
      "KEY_REVOKED",
      `Release key ${entry.keyId} has been revoked`,
    );
  }
  const retiredAt = toInstant(entry.retiredAt);
  if (entry.status === "retired" || retiredAt !== null) {
    // A rotated key may only authenticate manifests issued before the cutover.
    // A manifest without a trusted timestamp fails closed.
    const issuedAt = toInstant(manifest.issuedAt);
    if (retiredAt === null || issuedAt === null || issuedAt >= retiredAt) {
      throw new ArtifactVerificationError(
        "KEY_RETIRED",
        `Release key ${entry.keyId} was retired; this manifest was not issued before the rotation`,
      );
    }
  }

  const subtle = await resolveSubtle(options.subtle);
  let cryptoKey: CryptoKey;
  try {
    if (isCryptoKey(entry.publicKey)) {
      cryptoKey = entry.publicKey;
    } else if (typeof entry.publicKey === "string") {
      cryptoKey = await subtle.importKey(
        "raw",
        bufferSource(rawReleaseKeyBytes(entry.publicKey)),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
    } else {
      cryptoKey = await subtle.importKey(
        "jwk",
        entry.publicKey as JsonWebKey,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
    }
    const signature = /^[0-9a-fA-F]{128}$/.test(manifest.signature)
      ? fromHex(manifest.signature)
      : fromBase64(manifest.signature);
    if (signature.byteLength !== 64) {
      throw new ArtifactVerificationError(
        "SIGNATURE_INVALID",
        "Ed25519 signature must be 64 bytes",
      );
    }
    const ok = await subtle.verify(
      { name: "Ed25519" },
      cryptoKey,
      bufferSource(signature),
      manifestSignatureBytes(manifest),
    );
    if (!ok) {
      throw new ArtifactVerificationError(
        "SIGNATURE_INVALID",
        "Manifest signature verification failed",
      );
    }
  } catch (err) {
    if (err instanceof ArtifactVerificationError) throw err;
    throw new ArtifactVerificationError(
      "SIGNATURE_INVALID",
      `Manifest signature verification error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { valid: true, keyId: entry.keyId, manifestHash: computeManifestHash(manifest) };
}

// ===========================================================================
// Stream verification
// ===========================================================================

export type VerifiableStream =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>;

function isReadableStream(value: VerifiableStream): value is ReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReadableStream<Uint8Array>).getReader === "function"
  );
}

function chunkBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return encoder.encode(value);
  throw new ArtifactVerificationError("STREAM_ERROR", "Unsupported stream chunk type");
}

async function* iterateChunks(source: VerifiableStream): AsyncGenerator<Uint8Array> {
  if (isReadableStream(source)) {
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) yield chunkBytes(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }
  const maybeAsync = source as AsyncIterable<unknown>;
  if (typeof maybeAsync[Symbol.asyncIterator] === "function") {
    for await (const chunk of maybeAsync) yield chunkBytes(chunk);
    return;
  }
  for (const chunk of source as Iterable<unknown>) yield chunkBytes(chunk);
}

export interface VerifiedStreamResult {
  bytes: Uint8Array;
  sha256: string;
  size: number;
}

/**
 * Hash a chunked stream while collecting it. The bytes are returned only if
 * the running size and the final SHA-256 both equal the pinned descriptor.
 */
export async function readVerifiedStream(
  source: VerifiableStream,
  expected: ArtifactDescriptor,
  options: { kind?: ArtifactKind; onProgress?: (bytesRead: number) => void } = {},
): Promise<VerifiedStreamResult> {
  const label = options.kind ?? "artifact";
  const expectedHash = normalizeHex(expected.sha256, "MANIFEST_MALFORMED");
  if (!Number.isSafeInteger(expected.size) || expected.size <= 0) {
    throw new ArtifactVerificationError(
      "MANIFEST_MALFORMED",
      `${label} has an invalid expected size`,
    );
  }
  const hasher = new Sha256Stream();
  const chunks: Uint8Array[] = [];

  try {
    for await (const chunk of iterateChunks(source)) {
      if (hasher.size + chunk.byteLength > expected.size) {
        throw new ArtifactVerificationError(
          "ARTIFACT_SIZE_MISMATCH",
          `${label} download exceeded the pinned size (${expected.size} bytes)`,
          { expected: expected.size, received: hasher.size + chunk.byteLength },
        );
      }
      hasher.update(chunk);
      chunks.push(chunk);
      options.onProgress?.(hasher.size);
    }
  } catch (err) {
    if (err instanceof ArtifactVerificationError) throw err;
    throw new ArtifactVerificationError(
      "STREAM_ERROR",
      `${label} stream failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (hasher.size !== expected.size) {
    throw new ArtifactVerificationError(
      "ARTIFACT_SIZE_MISMATCH",
      `${label} size mismatch: expected ${expected.size}, got ${hasher.size}`,
      { expected: expected.size, actual: hasher.size },
    );
  }
  const sha256 = hasher.hex();
  if (sha256 !== expectedHash) {
    throw new ArtifactVerificationError(
      "ARTIFACT_HASH_MISMATCH",
      `${label} SHA-256 mismatch: expected ${expectedHash}, got ${sha256}`,
      { expected: expectedHash, actual: sha256 },
    );
  }

  const bytes = new Uint8Array(hasher.size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, sha256, size: hasher.size };
}

/** Verify bytes already in memory (used for cache hits). */
export async function verifyArtifactBytes(
  bytes: Uint8Array,
  expected: ArtifactDescriptor,
  kind: ArtifactKind,
): Promise<VerifiedStreamResult> {
  return readVerifiedStream([bytes], expected, { kind });
}

// ===========================================================================
// Caches
// ===========================================================================

export function manifestCacheKey(circuitId: string, version: number): string {
  return `${CACHE_NAMESPACE}/${circuitId}/${version}/manifest.json`;
}

export function registryCacheKey(circuitId: string, version: number): string {
  return `${CACHE_NAMESPACE}/${circuitId}/${version}/registry-hash`;
}

export function logCacheKey(circuitId: string, version: number): string {
  return `${CACHE_NAMESPACE}/${circuitId}/${version}/log-entry.json`;
}

export function artifactCacheKey(kind: ArtifactKind, circuitId: string, version: number): string {
  return `${CACHE_NAMESPACE}/${circuitId}/${version}/${kind}`;
}

export class InMemoryArtifactCache implements ArtifactCache {
  private readonly store: Map<string, Uint8Array>;

  constructor() {
    this.store = new Map<string, Uint8Array>();
  }

  async get(key: string): Promise<Uint8Array | null> {
    const value = this.store.get(key);
    return value ? new Uint8Array(value) : null;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.store.set(key, new Uint8Array(value));
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

/** Optional Cache API store. `caches` is resolved lazily, never at import time. */
export class CacheApiArtifactCache implements ArtifactCache {
  private readonly cacheName: string;

  constructor(cacheName = CACHE_NAMESPACE) {
    this.cacheName = cacheName;
  }

  private urlFor(key: string): string {
    return `https://zkvote.invalid/artifact-cache/${encodeURIComponent(key)}`;
  }

  private async open(): Promise<Cache> {
    const store = (globalThis as { caches?: CacheStorage }).caches;
    if (!store) {
      throw new ArtifactVerificationError(
        "ARTIFACT_MISSING",
        "Cache Storage API is not available",
      );
    }
    return store.open(this.cacheName);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const cache = await this.open();
    const response = await cache.match(this.urlFor(key));
    if (!response) return null;
    return new Uint8Array(await response.arrayBuffer());
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    const cache = await this.open();
    const copy = new Uint8Array(value);
    await cache.put(
      this.urlFor(key),
      new Response(copy, {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
  }

  async delete(key: string): Promise<void> {
    const cache = await this.open();
    await cache.delete(this.urlFor(key));
  }
}

export function createDefaultCache(): ArtifactCache {
  return (globalThis as { caches?: CacheStorage }).caches
    ? new CacheApiArtifactCache()
    : new InMemoryArtifactCache();
}

// ===========================================================================
// Top-level verified load path
// ===========================================================================

async function loadManifest(
  options: LoadVerifiedArtifactsOptions,
  cache: ArtifactCache,
): Promise<SignedArtifactManifest> {
  if (options.manifest) return options.manifest;
  const key = manifestCacheKey(options.circuitId, options.version);
  if (options.offline) {
    const cached = await cache.get(key);
    if (!cached) {
      throw new ArtifactVerificationError(
        "MANIFEST_CACHE_MISS",
        `No cached manifest for ${options.circuitId} v${options.version}`,
      );
    }
    try {
      return JSON.parse(decoder.decode(cached)) as SignedArtifactManifest;
    } catch {
      throw new ArtifactVerificationError("MANIFEST_MALFORMED", "Cached manifest is not valid JSON");
    }
  }
  if (!options.manifestUrl) {
    throw new ArtifactVerificationError(
      "MANIFEST_MISSING",
      "Provide a manifest, a manifestUrl, or use offline mode with a cached manifest",
    );
  }
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(options.manifestUrl);
  } catch (err) {
    throw new ArtifactVerificationError(
      "MANIFEST_FETCH_FAILED",
      `Manifest fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new ArtifactVerificationError(
      "MANIFEST_FETCH_FAILED",
      `Manifest fetch returned ${response.status} for ${options.manifestUrl}`,
    );
  }
  try {
    return JSON.parse(await response.text()) as SignedArtifactManifest;
  } catch {
    throw new ArtifactVerificationError("MANIFEST_MALFORMED", "Downloaded manifest is not valid JSON");
  }
}

async function resolveRegistryHash(
  options: LoadVerifiedArtifactsOptions,
  cache: ArtifactCache,
): Promise<string> {
  if (options.registryHash) {
    return normalizeHex(options.registryHash, "REGISTRY_HASH_INVALID");
  }
  const key = registryCacheKey(options.circuitId, options.version);
  if (options.offline) {
    const cached = await cache.get(key);
    if (!cached) {
      throw new ArtifactVerificationError(
        "REGISTRY_UNAVAILABLE",
        "Offline bundle has no pinned registry ceremony hash",
      );
    }
    return normalizeHex(decoder.decode(cached).trim(), "REGISTRY_HASH_INVALID");
  }
  if (!options.registryReader) {
    throw new ArtifactVerificationError(
      "REGISTRY_UNAVAILABLE",
      "A registryReader or registryHash is required before artifacts can be used",
    );
  }
  let value: string | null | undefined;
  try {
    value = await options.registryReader(options.circuitId, options.version);
  } catch (err) {
    throw new ArtifactVerificationError(
      "REGISTRY_READ_FAILED",
      `Could not read ceremony hash from the registry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!value) {
    throw new ArtifactVerificationError(
      "REGISTRY_HASH_MISSING",
      `No ceremony_transcript_hash registered for ${options.circuitId} v${options.version}`,
    );
  }
  const normalized = normalizeHex(value, "REGISTRY_HASH_INVALID");
  try {
    await cache.set(key, encoder.encode(normalized));
  } catch {
    /* caching is best effort; verification does not depend on it */
  }
  return normalized;
}

function artifactFilename(kind: ArtifactKind, circuitId: string, version: number): string {
  if (kind === "vkey") return `${circuitId}_v${version}.verification_key.json`;
  return `${circuitId}_v${version}.${kind}`;
}

async function loadArtifact(
  kind: ArtifactKind,
  options: LoadVerifiedArtifactsOptions,
  manifest: SignedArtifactManifest,
  cache: ArtifactCache,
  fetchFn: typeof fetch,
): Promise<{ bytes: Uint8Array; fromCache: boolean }> {
  const cacheKey = artifactCacheKey(kind, options.circuitId, options.version);
  const cached = await cache.get(cacheKey);
  if (cached) {
    // Cached bytes are untrusted: re-run the identical streaming verification
    // and evict the poisoned entry if it fails.
    try {
      const verified = await verifyArtifactBytes(cached, manifest.artifacts[kind], kind);
      return { bytes: verified.bytes, fromCache: true };
    } catch (err) {
      await cache.delete(cacheKey).catch(() => undefined);
      throw err;
    }
  }
  if (options.offline) {
    throw new ArtifactVerificationError(
      "ARTIFACT_MISSING",
      `Offline bundle is missing ${kind} for ${options.circuitId} v${options.version}`,
    );
  }
  const url =
    options.artifactUrls?.[kind] ||
    (options.artifactBaseUrl
      ? `${options.artifactBaseUrl.replace(/\/$/, "")}/${artifactFilename(kind, options.circuitId, options.version)}`
      : undefined);
  if (!url) {
    throw new ArtifactVerificationError(
      "ARTIFACT_MISSING",
      `No URL configured for ${kind} (provide artifactUrls or artifactBaseUrl)`,
    );
  }

  let response: Response;
  try {
    response = await fetchFn(url);
  } catch (err) {
    throw new ArtifactVerificationError(
      "ARTIFACT_DOWNLOAD_FAILED",
      `Failed to download ${kind} from ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new ArtifactVerificationError(
      "ARTIFACT_DOWNLOAD_FAILED",
      `Download of ${kind} returned ${response.status} for ${url}`,
    );
  }

  const contentLength = response.headers?.get?.("content-length");
  if (contentLength) {
    const advertised = Number(contentLength);
    if (Number.isSafeInteger(advertised) && advertised !== manifest.artifacts[kind].size) {
      throw new ArtifactVerificationError(
        "ARTIFACT_SIZE_MISMATCH",
        `${kind} Content-Length ${advertised} != pinned size ${manifest.artifacts[kind].size}`,
        { expected: manifest.artifacts[kind].size, actual: advertised },
      );
    }
  }
  const body = response.body as ReadableStream<Uint8Array> | null;
  const verified = await readVerifiedStream(
    body ?? [new Uint8Array(await response.arrayBuffer())],
    manifest.artifacts[kind],
    { kind },
  );
  try {
    await cache.set(cacheKey, verified.bytes);
  } catch {
    /* caching is best effort */
  }
  return { bytes: verified.bytes, fromCache: false };
}

/**
 * Verify a complete artifact bundle and only then return its bytes.
 * This is the function witness generation must use in place of a raw fetch.
 */
export async function loadVerifiedArtifacts(
  options: LoadVerifiedArtifactsOptions,
): Promise<VerifiedArtifacts> {
  const cache = options.cache ?? createDefaultCache();
  const fetchFn = options.fetchFn ?? fetch;
  const manifest = await loadManifest(options, cache);
  assertManifestShape(manifest);
  if (manifest.circuitId !== options.circuitId) {
    throw new ArtifactVerificationError(
      "CIRCUIT_MISMATCH",
      `Manifest is for ${manifest.circuitId}, expected ${options.circuitId}`,
    );
  }
  if (manifest.version !== options.version) {
    throw new ArtifactVerificationError(
      "VERSION_MISMATCH",
      `Manifest is for v${manifest.version}, expected v${options.version}`,
    );
  }

  // Signature + release-key lifecycle first: never download artifacts for an
  // unsigned or untrusted manifest.
  const signed = await verifySignedManifest(manifest, options.trustedKeys, {
    subtle: options.subtle,
    now: options.now?.(),
  });

  // On-chain (or pinned offline) ceremony transcript hash must match exactly.
  const registryHash = await resolveRegistryHash(options, cache);
  if (registryHash !== normalizeHex(manifest.ceremonyTranscriptHash, "MANIFEST_MALFORMED")) {
    throw new ArtifactVerificationError(
      "CEREMONY_HASH_MISMATCH",
      `Registry ceremony hash ${registryHash} != signed manifest ${manifest.ceremonyTranscriptHash}`,
      { registryHash, manifestHash: manifest.ceremonyTranscriptHash },
    );
  }

  // Transparency log: the embedded hash must be internally consistent, and a
  // published entry must be fetched/loaded when a logReader is configured.
  const rebuilt = buildTransparencyLogEntry(manifest);
  const transparencyLogEntryHash = verifyTransparencyLogEntry(manifest, rebuilt);
  const logKey = logCacheKey(options.circuitId, options.version);
  if (options.logReader && !options.offline) {
    let published: TransparencyLogEntry | null;
    try {
      published = await options.logReader(manifest.transparencyLog.id, manifest.transparencyLog.index);
    } catch (err) {
      throw new ArtifactVerificationError(
        "TRANSPARENCY_LOG_MISSING",
        `Transparency log lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!published) {
      throw new ArtifactVerificationError(
        "TRANSPARENCY_LOG_MISSING",
        `No transparency log entry ${manifest.transparencyLog.id}#${manifest.transparencyLog.index}`,
      );
    }
    verifyTransparencyLogEntry(manifest, published, manifest.transparencyLog.id);
    try {
      await cache.set(logKey, encoder.encode(canonicalJson(published)));
    } catch {
      /* best effort */
    }
  } else if (options.offline) {
    const cached = await cache.get(logKey);
    if (cached) {
      try {
        verifyTransparencyLogEntry(
          manifest,
          JSON.parse(decoder.decode(cached)) as TransparencyLogEntry,
          manifest.transparencyLog.id,
        );
      } catch {
        throw new ArtifactVerificationError(
          "TRANSPARENCY_LOG_MISMATCH",
          "Cached transparency log entry does not match the signed manifest",
        );
      }
    }
  }

  const verified: Record<ArtifactKind, Uint8Array> = {
    zkey: new Uint8Array(0),
    wasm: new Uint8Array(0),
    vkey: new Uint8Array(0),
  };
  const fromCache: Record<ArtifactKind, boolean> = { zkey: false, wasm: false, vkey: false };
  for (const kind of ARTIFACT_KINDS) {
    const result = await loadArtifact(kind, options, manifest, cache, fetchFn);
    verified[kind] = result.bytes;
    fromCache[kind] = result.fromCache;
  }

  let verificationKey: unknown;
  try {
    verificationKey = JSON.parse(decoder.decode(verified.vkey));
  } catch {
    throw new ArtifactVerificationError("ARTIFACT_MALFORMED", "vkey artifact is not valid JSON");
  }

  // Persist only fully verified material for later offline use.
  try {
    await cache.set(manifestCacheKey(options.circuitId, options.version), encoder.encode(canonicalJson(manifest)));
    await cache.set(logKey, encoder.encode(canonicalJson(rebuilt)));
  } catch {
    /* best effort */
  }

  return {
    circuitId: manifest.circuitId,
    version: manifest.version,
    ceremonyTranscriptHash: manifest.ceremonyTranscriptHash,
    manifestHash: signed.manifestHash,
    manifest,
    transparencyLogEntryHash,
    releaseKeyId: manifest.releaseKeyId,
    artifacts: {
      zkey: verified.zkey,
      wasm: verified.wasm,
      vkeyBytes: verified.vkey,
      verificationKey,
    },
    fromCache,
  };
}

/** Convenience wrapper for callers that only need the verification key. */
export async function getVerifiedVerificationKey(
  options: LoadVerifiedArtifactsOptions,
): Promise<{
  circuitId: string;
  version: number;
  ceremonyTranscriptHash: string;
  verificationKey: unknown;
}> {
  const bundle = await loadVerifiedArtifacts(options);
  return {
    circuitId: bundle.circuitId,
    version: bundle.version,
    ceremonyTranscriptHash: bundle.ceremonyTranscriptHash,
    verificationKey: bundle.artifacts.verificationKey,
  };
}
