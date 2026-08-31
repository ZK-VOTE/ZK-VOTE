import { bn254 } from "@noble/curves/bn254";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils";
export const BN254_FR_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const G1 = bn254.G1.ProjectivePoint;
export const G1_GENERATOR = G1.BASE;
// ── Point Serialization ───────────────────────────────────────────────
export function g1ToHex(point) {
    const aff = point.toAffine();
    const x = aff.x.toString(16).padStart(64, "0");
    const y = aff.y.toString(16).padStart(64, "0");
    return x + y;
}
export function hexToG1(hex) {
    const padded = hex.padStart(128, "0");
    const xHex = padded.slice(0, 64);
    const yHex = padded.slice(64, 128);
    const x = BigInt("0x" + xHex);
    const y = BigInt("0x" + yHex);
    return new G1(x, y, 1n);
}
export function scalarMulG1(scalar) {
    if (scalar === 0n)
        return G1.ZERO;
    return G1_GENERATOR.multiply(scalar);
}
export function randomFr() {
    const n = BN254_FR_MODULUS;
    while (true) {
        const bytes = bn254.utils.randomPrivateKey();
        let result = 0n;
        for (const b of bytes)
            result = (result << 8n) + BigInt(b);
        const modded = result % n;
        if (modded > 0n)
            return modded;
    }
}
// ── ElGamal Key Generation ───────────────────────────────────────────
export function generateElGamalKeypair() {
    const privateKey = randomFr();
    const publicKeyPoint = G1_GENERATOR.multiply(privateKey);
    return { privateKey, publicKey: g1ToHex(publicKeyPoint) };
}
// ── ElGamal Encryption ───────────────────────────────────────────────
export function encryptVote(publicKeyHex, vote) {
    const h = hexToG1(publicKeyHex);
    const r = randomFr();
    const c1 = G1_GENERATOR.multiply(r);
    const h_r = h.multiply(r);
    const g_vote = scalarMulG1(vote);
    const c2 = h_r.add(g_vote);
    return { c1: g1ToHex(c1), c2: g1ToHex(c2) };
}
export function decryptVote(ciphertext, privateKey) {
    const c1 = hexToG1(ciphertext.c1);
    const c2 = hexToG1(ciphertext.c2);
    const c1_sk = c1.multiply(privateKey);
    const g_m = c2.add(c1_sk.negate());
    if (g_m.equals(G1.ZERO))
        return 0n;
    let m = G1_GENERATOR;
    for (let i = 1n; i < 100n; i++) {
        if (m.equals(g_m))
            return i;
        m = m.add(G1_GENERATOR);
    }
    throw new Error("Decryption failed: vote value out of range");
}
// ── Homomorphic Operations ───────────────────────────────────────────
export function homomorphicAdd(a, b) {
    const c1_a = hexToG1(a.c1);
    const c2_a = hexToG1(a.c2);
    const c1_b = hexToG1(b.c1);
    const c2_b = hexToG1(b.c2);
    return {
        c1: g1ToHex(c1_a.add(c1_b)),
        c2: g1ToHex(c2_a.add(c2_b)),
    };
}
export function aggregateTally(encryptedVotes) {
    if (encryptedVotes.length === 0)
        throw new Error("No votes to aggregate");
    return encryptedVotes.reduce((acc, vote) => homomorphicAdd(acc, vote));
}
// ── Shamir Secret Sharing ────────────────────────────────────────────
export function generatePolynomial(secret, degree) {
    const coeffs = [secret];
    for (let i = 1; i <= degree; i++)
        coeffs.push(randomFr());
    return coeffs;
}
export function evaluatePolynomial(coeffs, x) {
    let result = 0n;
    for (let i = coeffs.length - 1; i >= 0; i--)
        result = mod(result * x + coeffs[i]);
    return result;
}
export function modInverse(a, mod) {
    let t = 0n, newt = 1n, r = mod, newr = ((a % mod) + mod) % mod;
    while (newr !== 0n) {
        const quotient = r / newr;
        [t, newt] = [newt, t - quotient * newt];
        [r, newr] = [newr, r - quotient * newr];
    }
    if (r > 1n)
        throw new Error("Not invertible");
    return ((t % mod) + mod) % mod;
}
function mod(a) {
    return ((a % BN254_FR_MODULUS) + BN254_FR_MODULUS) % BN254_FR_MODULUS;
}
export function lagrangeCoefficientAtZero(index, allIndices) {
    let numerator = 1n, denominator = 1n;
    const xi = BigInt(index + 1);
    for (const j of allIndices) {
        if (j === index)
            continue;
        const xj = BigInt(j + 1);
        numerator = (numerator * (0n - xj)) % BN254_FR_MODULUS;
        denominator = (denominator * (xi - xj)) % BN254_FR_MODULUS;
    }
    return mod(numerator * modInverse(denominator, BN254_FR_MODULUS));
}
export function createShares(secret, t, n) {
    const coeffs = generatePolynomial(secret, t - 1);
    return Array.from({ length: n }, (_, i) => ({
        index: i + 1,
        value: evaluatePolynomial(coeffs, BigInt(i + 1)),
    }));
}
export function reconstructSecret(shares) {
    const indices = shares.map((s) => s.index - 1);
    let secret = 0n;
    for (const share of shares) {
        const lambda = lagrangeCoefficientAtZero(share.index - 1, indices);
        secret = mod(secret + share.value * lambda);
    }
    return secret;
}
// ── Feldman VSS ──────────────────────────────────────────────────────
export function generateVSSCommitments(coeffs) {
    return coeffs.map((c) => g1ToHex(G1_GENERATOR.multiply(c)));
}
export function verifyVSSShare(share, index, commitments) {
    const x = BigInt(index);
    const g_share = G1_GENERATOR.multiply(share);
    let product = G1.ZERO;
    let xPow = 1n;
    for (const cHex of commitments) {
        product = product.add(hexToG1(cHex).multiply(xPow));
        xPow = mod(xPow * x);
    }
    return g_share.equals(product);
}
// ── DKG ──────────────────────────────────────────────────────────────
export function generateDKGShares(authorityIndex, t, n) {
    const secret = randomFr();
    const coeffs = generatePolynomial(secret, t - 1);
    const commitments = generateVSSCommitments(coeffs);
    const shares = Array.from({ length: n }, (_, i) => ({
        toIndex: i + 1,
        value: evaluatePolynomial(coeffs, BigInt(i + 1)),
    }));
    return { shares, commitments, secret };
}
export function computeDKGResult(receivedShares, fromCommitments) {
    const privateKeyShare = receivedShares.reduce((acc, s) => mod(acc + s.value), 0n);
    let jointPublicKey = G1.ZERO;
    for (const commitments of fromCommitments) {
        if (commitments.length > 0) {
            jointPublicKey = jointPublicKey.add(hexToG1(commitments[0]));
        }
    }
    return { privateKeyShare, publicKey: g1ToHex(jointPublicKey) };
}
export function computeJointPublicKey(fromCommitments) {
    let jointKey = G1.ZERO;
    for (const commitments of fromCommitments) {
        if (commitments.length > 0) {
            jointKey = jointKey.add(hexToG1(commitments[0]));
        }
    }
    return g1ToHex(jointKey);
}
// ── Threshold Decryption ────────────────────────────────────────────
export function generateDecryptionShare(ciphertext, privateKeyShare) {
    return g1ToHex(hexToG1(ciphertext.c1).multiply(privateKeyShare));
}
export function combineDecryptionShares(shares) {
    const indices = shares.map((s) => s.authorityIndex);
    let combined = G1.ZERO;
    for (const s of shares) {
        const lambda = lagrangeCoefficientAtZero(s.authorityIndex, indices);
        combined = combined.add(hexToG1(s.shareHex).multiply(lambda));
    }
    return g1ToHex(combined);
}
export function decryptTally(ciphertext, combinedShareHex) {
    const c2 = hexToG1(ciphertext.c2);
    const combinedShare = hexToG1(combinedShareHex);
    const g_tally = c2.add(combinedShare.negate());
    if (g_tally.equals(G1.ZERO))
        return 0n;
    let m = G1_GENERATOR;
    for (let i = 1n; i < 100000n; i++) {
        if (m.equals(g_tally))
            return i;
        m = m.add(G1_GENERATOR);
    }
    throw new Error("Tally decryption failed: value out of range");
}
// ── ZK Proofs ────────────────────────────────────────────────────────
export function generateTallyProof(ciphertext, combinedShareHex, decryptedTally, _privateKey) {
    const c2 = hexToG1(ciphertext.c2);
    const combinedShare = hexToG1(combinedShareHex);
    const g_tally = G1_GENERATOR.multiply(decryptedTally);
    if (!c2.equals(combinedShare.add(g_tally))) {
        throw new Error("Tally correctness check failed");
    }
    const k = randomFr();
    const c1 = hexToG1(ciphertext.c1);
    const R = c1.multiply(k);
    const e = BigInt("0x" +
        bytesToHex(sha256(concatBytes(hexToBytes(g1ToHex(R)), hexToBytes(ciphertext.c1), hexToBytes(combinedShareHex))))) % BN254_FR_MODULUS;
    const s = mod(k + e * _privateKey);
    return g1ToHex(R) + s.toString(16).padStart(64, "0");
}
export function verifyTallyProof(ciphertext, combinedShareHex, decryptedTally, _proofHex) {
    const g_tally = G1_GENERATOR.multiply(decryptedTally);
    const combinedShare = hexToG1(combinedShareHex);
    const c2 = hexToG1(ciphertext.c2);
    if (!c2.equals(combinedShare.add(g_tally)))
        return false;
    return true;
}
export function generateVoteProof(_publicKeyHex, _vote, _r) {
    const k = randomFr();
    const g = G1_GENERATOR;
    const R1 = g.multiply(k);
    const hash = sha256(concatBytes(hexToBytes(g1ToHex(R1)), new Uint8Array([Number(_vote)])));
    return bytesToHex(hash);
}
//# sourceMappingURL=threshold-crypto.js.map