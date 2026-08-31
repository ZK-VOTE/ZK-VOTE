/**
 * RSA Blind Signatures (Chaum, 1983) for Anonymous Credential Distribution
 *
 * Addresses the "voter deanonymization at registration" problem described
 * in Issue #122: today the admin sees every `(voter_address, commitment)`
 * pair as voters register, so it can correlate identity with the
 * commitment used later inside the ZK proof. A full oblivious-transfer
 * protocol is one way to fix this; the issue explicitly calls out RSA
 * blind signatures as "a simpler alternative to full OT for this specific
 * use case", so that's what this module implements.
 *
 * Protocol:
 *   1. The voter picks their identity commitment `m` (the same Poseidon/
 *      Pedersen commitment they already generate client-side, see
 *      `frontend/src/lib/crypto.ts`) and a secret random blinding factor
 *      `r` coprime to the issuer's RSA modulus `n`.
 *   2. The voter computes the blinded commitment `m' = m * r^e mod n` and
 *      sends only `m'` to the admin/issuer, together with proof of voter
 *      eligibility (e.g. a signed wallet challenge) that does NOT reveal
 *      `m`.
 *   3. The issuer verifies eligibility, signs the blinded value
 *      (`s' = m'^d mod n`), and returns `s'`. The issuer never sees `m`.
 *   4. The voter unblinds: `s = s' * r^-1 mod n`. Because RSA blinding is
 *      multiplicatively homomorphic, `s` is now a valid RSA signature on
 *      the *original* `m`, even though the issuer only ever saw `m'`.
 *   5. Later, anyone (including the issuer) can verify `s` is a valid
 *      signature on `m` — but the issuer cannot link this `(m, s)` pair
 *      back to the specific registration session (blinded value `m'`) that
 *      produced it, because `m' = m * r^e mod n` is (for a uniformly
 *      random `r`) statistically indistinguishable from a uniformly random
 *      element of `Z_n*`, independent of `m`.
 *
 * This provides *issuer-side unlinkability*: the admin still enforces
 * eligibility (one blind signature per eligible voter, exactly as before)
 * but can no longer map the commitment used in the ZK proof back to the
 * voter identity that requested the credential.
 *
 * This module implements the cryptographic primitive (key generation,
 * blind/sign/unblind/verify) with real modular-exponentiation arithmetic.
 * It also provides the issuer-side one-credential-per-voter and
 * anti-farming coordination needed by the registration HTTP routes.
 */

import { createHash, generateKeyPairSync, KeyObject } from "node:crypto";

/** RSA public parameters used to blind-sign credentials. */
export interface RsaBlindPublicKey {
  n: bigint;
  e: bigint;
}

/** RSA key pair (issuer/admin holds the private exponent `d`). */
export interface RsaBlindKeyPair extends RsaBlindPublicKey {
  d: bigint;
}

export class BlindSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlindSignatureError";
  }
}

function b64urlToBigInt(b64url: string): bigint {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const buf = Buffer.from(b64, "base64");
  return BigInt("0x" + (buf.toString("hex") || "0"));
}

/**
 * Generate a fresh RSA key pair for the credential issuer.
 * `modulusLength` defaults to 2048 bits (matches common RSA blind
 * signature deployments and Node's default RSA security floor).
 */
export function generateIssuerKeyPair(modulusLength = 2048): RsaBlindKeyPair {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength,
    publicExponent: 0x10001,
  });
  const jwk = (privateKey as KeyObject).export({ format: "jwk" }) as {
    n: string;
    e: string;
    d: string;
  };
  return {
    n: b64urlToBigInt(jwk.n),
    e: b64urlToBigInt(jwk.e),
    d: b64urlToBigInt(jwk.d),
  };
}

/** Modular exponentiation: base^exp mod modulus, for BigInt operands. */
export function modPow(base: bigint, exp: bigint, modulus: bigint): bigint {
  if (modulus === 1n) return 0n;
  let result = 1n;
  let b = ((base % modulus) + modulus) % modulus;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % modulus;
    }
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

function egcd(a: bigint, b: bigint): { g: bigint; x: bigint; y: bigint } {
  if (b === 0n) return { g: a, x: 1n, y: 0n };
  const { g, x, y } = egcd(b, a % b);
  return { g, x: y, y: x - (a / b) * y };
}

/** Modular inverse of `a` mod `m`, throws if it doesn't exist. */
export function modInverse(a: bigint, m: bigint): bigint {
  const { g, x } = egcd(((a % m) + m) % m, m);
  if (g !== 1n) {
    throw new BlindSignatureError(
      "modular inverse does not exist (not coprime)",
    );
  }
  return ((x % m) + m) % m;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

/** Cryptographically random BigInt uniformly sampled from [1, max). */
function randomBigIntBelow(max: bigint): bigint {
  const bytesNeeded = Math.ceil(max.toString(2).length / 8) + 1;
  let candidate: bigint;
  do {
    const bytes = new Uint8Array(bytesNeeded);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytesNeeded; i++)
        bytes[i] = Math.floor(Math.random() * 256);
    }
    candidate = 0n;
    for (const b of bytes) candidate = (candidate << 8n) | BigInt(b);
    candidate = candidate % max;
  } while (candidate <= 1n);
  return candidate;
}

export interface BlindedRequest {
  /** The blinded message sent to the issuer. Reveals nothing about `message`. */
  blinded: bigint;
  /** Secret blinding factor; must be kept by the requester to unblind later. */
  r: bigint;
}

/**
 * Blind a message (credential commitment) so it can be sent to the issuer
 * without revealing it. Picks a fresh random blinding factor `r` coprime
 * to `n`.
 */
export function blind(message: bigint, pub: RsaBlindPublicKey): BlindedRequest {
  if (message < 0n || message >= pub.n) {
    throw new BlindSignatureError("message must satisfy 0 <= message < n");
  }
  let r: bigint;
  do {
    r = randomBigIntBelow(pub.n);
  } while (gcd(r, pub.n) !== 1n);

  const rPowE = modPow(r, pub.e, pub.n);
  const blinded = (message * rPowE) % pub.n;
  return { blinded, r };
}

/**
 * Issuer-side: sign a blinded value. The issuer never learns `message`,
 * only `blinded`.
 */
export function signBlinded(blinded: bigint, key: RsaBlindKeyPair): bigint {
  if (blinded < 0n || blinded >= key.n) {
    throw new BlindSignatureError("blinded value out of range");
  }
  return modPow(blinded, key.d, key.n);
}

/**
 * Requester-side: remove the blinding factor from the issuer's signature
 * on the blinded value, producing a valid signature on the original
 * (unblinded) message.
 */
export function unblind(
  blindSig: bigint,
  r: bigint,
  pub: RsaBlindPublicKey,
): bigint {
  const rInv = modInverse(r, pub.n);
  return (blindSig * rInv) % pub.n;
}

/** Verify that `signature` is a valid RSA signature on `message` under `pub`. */
export function verify(
  message: bigint,
  signature: bigint,
  pub: RsaBlindPublicKey,
): boolean {
  if (signature < 0n || signature >= pub.n) return false;
  return (
    modPow(signature, pub.e, pub.n) === ((message % pub.n) + pub.n) % pub.n
  );
}

/**
 * Convenience end-to-end helper mirroring the full registration flow:
 * voter blinds -> issuer signs -> voter unblinds -> returns the final,
 * verifiable, issuer-signed credential. Exposed mainly for tests /
 * documentation; a real deployment splits steps 2-3 across an HTTP
 * boundary (voter <-> issuer).
 */
export function issueCredential(
  message: bigint,
  pub: RsaBlindPublicKey,
  key: RsaBlindKeyPair,
): { signature: bigint; blindedSentToIssuer: bigint } {
  const { blinded, r } = blind(message, pub);
  const blindSig = signBlinded(blinded, key);
  const signature = unblind(blindSig, r, pub);
  return { signature, blindedSentToIssuer: blinded };
}

const BN254_FR =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface DidSignedClaim {
  issuer: string;
  subjectDid: string;
  attributeKey: string;
  attributeValue: number;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export interface DidAttributeProofSeed {
  issuerId: string;
  attributeKey: string;
  minAttributeValue: string;
  signedClaimHash: string;
  attributeValue: string;
}

function hashToField(value: string): bigint {
  const digest = createHash("sha256").update(value).digest("hex");
  return BigInt(`0x${digest}`) % BN254_FR;
}

function canonicalClaimPayload(claim: DidSignedClaim): string {
  return JSON.stringify({
    issuer: claim.issuer,
    subjectDid: claim.subjectDid,
    attributeKey: claim.attributeKey,
    attributeValue: claim.attributeValue,
    issuedAt: claim.issuedAt,
    expiresAt: claim.expiresAt,
  });
}

export function validateDidSignedClaim(
  claim: DidSignedClaim,
  now = Math.floor(Date.now() / 1000),
): void {
  if (!claim.issuer || !claim.subjectDid || !claim.attributeKey) {
    throw new BlindSignatureError("DID claim is missing required fields");
  }
  if (!Number.isSafeInteger(claim.attributeValue) || claim.attributeValue < 0) {
    throw new BlindSignatureError(
      "DID claim attributeValue must be a safe non-negative integer",
    );
  }
  if (claim.issuedAt > now || claim.expiresAt <= now) {
    throw new BlindSignatureError("DID claim is not currently valid");
  }
  if (!claim.signature) {
    throw new BlindSignatureError("DID claim signature is required");
  }
}

export function buildDidAttributeProofSeed(
  claim: DidSignedClaim,
  minAttributeValue: number,
): DidAttributeProofSeed {
  validateDidSignedClaim(claim);
  if (minAttributeValue < 0 || claim.attributeValue < minAttributeValue) {
    throw new BlindSignatureError(
      "DID claim does not satisfy requested threshold",
    );
  }

  return {
    issuerId: hashToField(claim.issuer).toString(),
    attributeKey: hashToField(claim.attributeKey).toString(),
    minAttributeValue: minAttributeValue.toString(),
    signedClaimHash: hashToField(
      `${canonicalClaimPayload(claim)}.${claim.signature}`,
    ).toString(),
    attributeValue: claim.attributeValue.toString(),
  };
}
/**
 * Issued-credential table DDL for an anonymous credential issuance store.
 * Only `voter_id` is retained. The blinded commitment and final RSA
 * signature are intentionally not persisted; storing either would create
 * a link between the voter and the later anonymous ZK proof.
 */
export const CREDENTIAL_ISSUANCE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS issued_credentials (
  voter_id TEXT PRIMARY KEY,
  issued_at INTEGER NOT NULL
);
`;

/** Persistence contract used by the end-to-end credential issuer. */
export interface CredentialIssuerStore {
  hasCredential(voterId: string): boolean;
  markCredentialIssued(voterId: string, issuedAt: number): void;
}

/** In-memory implementation of [[CredentialIssuerStore]] for tests/dev. */
export class InMemoryCredentialIssuerStore implements CredentialIssuerStore {
  private readonly issued = new Set<string>();

  hasCredential(voterId: string): boolean {
    return this.issued.has(voterId);
  }

  markCredentialIssued(voterId: string, _issuedAt: number): void {
    this.issued.add(voterId);
  }
}

/** Sliding-window rate limiter for anti-farming of blind signatures. */
export class SignatureFarmingRateLimiter {
  private readonly requests = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {
    if (maxRequests <= 0 || windowMs <= 0) {
      throw new BlindSignatureError(
        "rate limiter requires positive maxRequests and windowMs",
      );
    }
  }

  /** Returns true if the request is allowed, false if it should be rejected. */
  isAllowed(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const timestamps = (this.requests.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (timestamps.length >= this.maxRequests) {
      this.requests.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    this.requests.set(key, timestamps);
    return true;
  }
}

/**
 * Issuer-side coordinator that signs blinded credentials while enforcing
 * one credential per voter and optional anti-farming limits.
 *
 * The store keeps only the fact that a voter already received a credential.
 * The blinded commitment is passed to [[signBlinded]] but is never recorded,
 * so the issuer cannot later link `(message, signature)` to a voter id.
 */
export class BlindSignatureIssuer {
  constructor(
    private readonly key: RsaBlindKeyPair,
    private readonly store: CredentialIssuerStore,
    private readonly rateLimiter?: SignatureFarmingRateLimiter,
  ) {}

  hasCredential(voterId: string): boolean {
    return this.store.hasCredential(voterId);
  }

  issue(voterId: string, blinded: bigint, rateLimitKey = voterId): bigint {
    if (this.store.hasCredential(voterId)) {
      throw new BlindSignatureError(
        "voter has already been issued a credential",
      );
    }
    if (this.rateLimiter && !this.rateLimiter.isAllowed(rateLimitKey)) {
      throw new BlindSignatureError(
        "too many blind signature requests; try again later",
      );
    }
    const signature = signBlinded(blinded, this.key);
    this.store.markCredentialIssued(voterId, Date.now());
    return signature;
  }
}

/**
 * Server-side helper for a registration HTTP handler that has already
 * received a blinded commitment from the voter.
 */
export function issueVoterCredential(
  voterId: string,
  blinded: bigint,
  key: RsaBlindKeyPair,
  store: CredentialIssuerStore,
  rateLimiter?: SignatureFarmingRateLimiter,
  rateLimitKey = voterId,
): bigint {
  const issuer = new BlindSignatureIssuer(key, store, rateLimiter);
  return issuer.issue(voterId, blinded, rateLimitKey);
}

/**
 * End-to-end registration helper for tests and local development. It
 * blinds, obtains the issuer signature, and unblinds while enforcing the
 * one-credential-per-voter store.
 */
export function issueCredentialForVoter(
  voterId: string,
  message: bigint,
  pub: RsaBlindPublicKey,
  key: RsaBlindKeyPair,
  store: CredentialIssuerStore,
  rateLimiter?: SignatureFarmingRateLimiter,
  rateLimitKey = voterId,
): { signature: bigint; blindedSentToIssuer: bigint } {
  const { blinded, r } = blind(message, pub);
  const blindSig = new BlindSignatureIssuer(key, store, rateLimiter).issue(
    voterId,
    blinded,
    rateLimitKey,
  );
  const signature = unblind(blindSig, r, pub);
  return { signature, blindedSentToIssuer: blinded };
}
