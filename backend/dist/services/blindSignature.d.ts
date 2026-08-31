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
 * Wiring it into the existing registration HTTP routes/DB schema is a
 * larger, separate change and is out of scope here (see PR description).
 */
/** RSA public parameters used to blind-sign credentials. */
export interface RsaBlindPublicKey {
    n: bigint;
    e: bigint;
}
/** RSA key pair (issuer/admin holds the private exponent `d`). */
export interface RsaBlindKeyPair extends RsaBlindPublicKey {
    d: bigint;
}
export declare class BlindSignatureError extends Error {
    constructor(message: string);
}
/**
 * Generate a fresh RSA key pair for the credential issuer.
 * `modulusLength` defaults to 2048 bits (matches common RSA blind
 * signature deployments and Node's default RSA security floor).
 */
export declare function generateIssuerKeyPair(modulusLength?: number): RsaBlindKeyPair;
/** Modular exponentiation: base^exp mod modulus, for BigInt operands. */
export declare function modPow(base: bigint, exp: bigint, modulus: bigint): bigint;
/** Modular inverse of `a` mod `m`, throws if it doesn't exist. */
export declare function modInverse(a: bigint, m: bigint): bigint;
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
export declare function blind(message: bigint, pub: RsaBlindPublicKey): BlindedRequest;
/**
 * Issuer-side: sign a blinded value. The issuer never learns `message`,
 * only `blinded`.
 */
export declare function signBlinded(blinded: bigint, key: RsaBlindKeyPair): bigint;
/**
 * Requester-side: remove the blinding factor from the issuer's signature
 * on the blinded value, producing a valid signature on the original
 * (unblinded) message.
 */
export declare function unblind(blindSig: bigint, r: bigint, pub: RsaBlindPublicKey): bigint;
/** Verify that `signature` is a valid RSA signature on `message` under `pub`. */
export declare function verify(message: bigint, signature: bigint, pub: RsaBlindPublicKey): boolean;
/**
 * Convenience end-to-end helper mirroring the full registration flow:
 * voter blinds -> issuer signs -> voter unblinds -> returns the final,
 * verifiable, issuer-signed credential. Exposed mainly for tests /
 * documentation; a real deployment splits steps 2-3 across an HTTP
 * boundary (voter <-> issuer).
 */
export declare function issueCredential(message: bigint, pub: RsaBlindPublicKey, key: RsaBlindKeyPair): {
    signature: bigint;
    blindedSentToIssuer: bigint;
};
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
export declare function validateDidSignedClaim(claim: DidSignedClaim, now?: number): void;
export declare function buildDidAttributeProofSeed(claim: DidSignedClaim, minAttributeValue: number): DidAttributeProofSeed;
//# sourceMappingURL=blindSignature.d.ts.map