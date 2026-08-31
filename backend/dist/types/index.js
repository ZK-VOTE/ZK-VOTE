/**
 * Shared Type Definitions for ZKVote Backend
 */
// ============================================
// CRYPTO CONSTANTS
// ============================================
/**
 * BN254 scalar field modulus (Fr) - all public signals must be < this value
 * r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
 */
export const BN254_FR_MODULUS = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");
/**
 * BN254 scalar field modulus as hex string (big-endian, 64 chars)
 */
export const BN254_FR_MODULUS_HEX = "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";
/**
 * BN254 base field modulus (Fq) — NOT the same as BN254_FR_MODULUS (Fr).
 * G1/G2 point coordinates (proof.a, proof.b, proof.c) live in Fq; only
 * public signals (root, nullifier, etc.) live in Fr. Used for Groth16 proof
 * canonicalization (#167): a G1 point's Y-coordinate must be reduced to the
 * lower half of Fq before storage, so the two malleable representations of
 * a proof — (A, B, C) and (-A, -B, C) — always canonicalize to the same
 * stored form.
 * q = 21888242871839275222246405745257275088696311157297823662689037894645226208583
 */
export const BN254_FQ_MODULUS = BigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583");
// ============================================
// ERROR TYPES
// ============================================
export var ErrorCode;
(function (ErrorCode) {
    ErrorCode["VOTE_ALREADY_CAST"] = "VOTE_ALREADY_CAST";
    ErrorCode["VOTING_PERIOD_CLOSED"] = "VOTING_PERIOD_CLOSED";
    ErrorCode["INVALID_PROOF"] = "INVALID_PROOF";
    ErrorCode["NOT_ELIGIBLE"] = "NOT_ELIGIBLE";
    ErrorCode["PROPOSAL_NOT_FOUND"] = "PROPOSAL_NOT_FOUND";
    ErrorCode["DAO_NOT_FOUND"] = "DAO_NOT_FOUND";
    ErrorCode["INTERNAL_ERROR"] = "INTERNAL_ERROR";
    ErrorCode["RATE_LIMITED"] = "RATE_LIMITED";
    ErrorCode["UNAUTHORIZED"] = "UNAUTHORIZED";
    ErrorCode["VALIDATION_ERROR"] = "VALIDATION_ERROR";
    ErrorCode["SERVICE_UNAVAILABLE"] = "SERVICE_UNAVAILABLE";
    ErrorCode["TIMEOUT"] = "TIMEOUT";
    ErrorCode["NOT_FOUND"] = "NOT_FOUND";
    ErrorCode["VOTE_REJECTED"] = "VOTE_REJECTED";
})(ErrorCode || (ErrorCode = {}));
//# sourceMappingURL=index.js.map