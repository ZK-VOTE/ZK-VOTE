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
import { createHash, generateKeyPairSync } from "node:crypto";
export class BlindSignatureError extends Error {
    constructor(message) {
        super(message);
        this.name = "BlindSignatureError";
    }
}
function b64urlToBigInt(b64url) {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(b64, "base64");
    return BigInt("0x" + (buf.toString("hex") || "0"));
}
/**
 * Generate a fresh RSA key pair for the credential issuer.
 * `modulusLength` defaults to 2048 bits (matches common RSA blind
 * signature deployments and Node's default RSA security floor).
 */
export function generateIssuerKeyPair(modulusLength = 2048) {
    const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength,
        publicExponent: 0x10001,
    });
    const jwk = privateKey.export({ format: "jwk" });
    return {
        n: b64urlToBigInt(jwk.n),
        e: b64urlToBigInt(jwk.e),
        d: b64urlToBigInt(jwk.d),
    };
}
/** Modular exponentiation: base^exp mod modulus, for BigInt operands. */
export function modPow(base, exp, modulus) {
    if (modulus === 1n)
        return 0n;
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
function egcd(a, b) {
    if (b === 0n)
        return { g: a, x: 1n, y: 0n };
    const { g, x, y } = egcd(b, a % b);
    return { g, x: y, y: x - (a / b) * y };
}
/** Modular inverse of `a` mod `m`, throws if it doesn't exist. */
export function modInverse(a, m) {
    const { g, x } = egcd(((a % m) + m) % m, m);
    if (g !== 1n) {
        throw new BlindSignatureError("modular inverse does not exist (not coprime)");
    }
    return ((x % m) + m) % m;
}
function gcd(a, b) {
    while (b !== 0n) {
        [a, b] = [b, a % b];
    }
    return a;
}
/** Cryptographically random BigInt uniformly sampled from [1, max). */
function randomBigIntBelow(max) {
    const bytesNeeded = Math.ceil(max.toString(2).length / 8) + 1;
    let candidate;
    do {
        const bytes = new Uint8Array(bytesNeeded);
        if (typeof crypto !== "undefined" && crypto.getRandomValues) {
            crypto.getRandomValues(bytes);
        }
        else {
            for (let i = 0; i < bytesNeeded; i++)
                bytes[i] = Math.floor(Math.random() * 256);
        }
        candidate = 0n;
        for (const b of bytes)
            candidate = (candidate << 8n) | BigInt(b);
        candidate = candidate % max;
    } while (candidate <= 1n);
    return candidate;
}
/**
 * Blind a message (credential commitment) so it can be sent to the issuer
 * without revealing it. Picks a fresh random blinding factor `r` coprime
 * to `n`.
 */
export function blind(message, pub) {
    if (message < 0n || message >= pub.n) {
        throw new BlindSignatureError("message must satisfy 0 <= message < n");
    }
    let r;
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
export function signBlinded(blinded, key) {
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
export function unblind(blindSig, r, pub) {
    const rInv = modInverse(r, pub.n);
    return (blindSig * rInv) % pub.n;
}
/** Verify that `signature` is a valid RSA signature on `message` under `pub`. */
export function verify(message, signature, pub) {
    if (signature < 0n || signature >= pub.n)
        return false;
    return (modPow(signature, pub.e, pub.n) === ((message % pub.n) + pub.n) % pub.n);
}
/**
 * Convenience end-to-end helper mirroring the full registration flow:
 * voter blinds -> issuer signs -> voter unblinds -> returns the final,
 * verifiable, issuer-signed credential. Exposed mainly for tests /
 * documentation; a real deployment splits steps 2-3 across an HTTP
 * boundary (voter <-> issuer).
 */
export function issueCredential(message, pub, key) {
    const { blinded, r } = blind(message, pub);
    const blindSig = signBlinded(blinded, key);
    const signature = unblind(blindSig, r, pub);
    return { signature, blindedSentToIssuer: blinded };
}
const BN254_FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function hashToField(value) {
    const digest = createHash("sha256").update(value).digest("hex");
    return BigInt(`0x${digest}`) % BN254_FR;
}
function canonicalClaimPayload(claim) {
    return JSON.stringify({
        issuer: claim.issuer,
        subjectDid: claim.subjectDid,
        attributeKey: claim.attributeKey,
        attributeValue: claim.attributeValue,
        issuedAt: claim.issuedAt,
        expiresAt: claim.expiresAt,
    });
}
export function validateDidSignedClaim(claim, now = Math.floor(Date.now() / 1000)) {
    if (!claim.issuer || !claim.subjectDid || !claim.attributeKey) {
        throw new BlindSignatureError("DID claim is missing required fields");
    }
    if (!Number.isSafeInteger(claim.attributeValue) || claim.attributeValue < 0) {
        throw new BlindSignatureError("DID claim attributeValue must be a safe non-negative integer");
    }
    if (claim.issuedAt > now || claim.expiresAt <= now) {
        throw new BlindSignatureError("DID claim is not currently valid");
    }
    if (!claim.signature) {
        throw new BlindSignatureError("DID claim signature is required");
    }
}
export function buildDidAttributeProofSeed(claim, minAttributeValue) {
    validateDidSignedClaim(claim);
    if (minAttributeValue < 0 || claim.attributeValue < minAttributeValue) {
        throw new BlindSignatureError("DID claim does not satisfy requested threshold");
    }
    return {
        issuerId: hashToField(claim.issuer).toString(),
        attributeKey: hashToField(claim.attributeKey).toString(),
        minAttributeValue: minAttributeValue.toString(),
        signedClaimHash: hashToField(`${canonicalClaimPayload(claim)}.${claim.signature}`).toString(),
        attributeValue: claim.attributeValue.toString(),
    };
}
//# sourceMappingURL=blindSignature.js.map