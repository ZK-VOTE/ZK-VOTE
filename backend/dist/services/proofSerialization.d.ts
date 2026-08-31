/**
 * Audit-Friendly Proof Serialization Format (ZKV1)
 *
 * This is the canonical, versioned wire format for a Groth16 proof shared
 * across the ZK-VOTE stack (circom/snarkjs -> backend -> Soroban contract).
 * It mirrors the Rust reference implementation in
 * `contracts/zkvote-groth16/src/serialization.rs` byte-for-byte, so a proof
 * serialized here can be decoded there (and vice versa) without any
 * additional translation layer.
 *
 * Wire format (big-endian throughout):
 *
 *   [ version (1B) | curve_id (1B) | A_x (32B) | A_y (32B)
 *     | B_x1 (32B) | B_x2 (32B) | B_y1 (32B) | B_y2 (32B)
 *     | C_x (32B) | C_y (32B) ]
 *
 * - version:  format version, currently `1` (PROOF_FORMAT_VERSION). Any
 *             incompatible layout change must bump this byte.
 * - curve_id: 0x00 = BN254, 0x01 = BLS12-381.
 * - A, C:     G1 points, 64 bytes each (X || Y).
 * - B:        G2 point, 128 bytes (X_c1 || X_c0 || Y_c1 || Y_c0), matching
 *             the existing `G2Hex` convention used by `proofToScVal` in
 *             `stellar.ts`.
 *
 * Total length for the BN254/BLS12-381 G1×G2×G1 proof shape currently used
 * on-chain: 1 + 1 + 64 + 128 + 64 = 258 bytes.
 */
import type { Groth16Proof } from "../types/index.js";
/** Current wire-format version. Bump on any incompatible layout change. */
export declare const PROOF_FORMAT_VERSION = 1;
export declare enum ProofCurveId {
    Bn254 = 0,
    Bls12381 = 1
}
/** Total length in bytes of a ZKV1-serialized proof. */
export declare const SERIALIZED_PROOF_LEN: number;
export declare class ProofFormatError extends Error {
    constructor(message: string);
}
/**
 * Serialize a `Groth16Proof` (hex-encoded a/b/c) into the versioned ZKV1
 * byte format.
 */
export declare function serializeProof(proof: Groth16Proof, curve?: ProofCurveId): Buffer;
/**
 * Deserialize a ZKV1 byte buffer back into a `{ proof, curve }` pair.
 * Validates the version byte, curve id byte, and total length before
 * slicing out the fixed-size point components.
 */
export declare function deserializeProof(bytes: Buffer): {
    proof: Groth16Proof;
    curve: ProofCurveId;
};
/**
 * Convenience helper returning the ZKV1 bytes as a `0x`-prefixed hex string,
 * useful for logging / audit trails / example vectors.
 */
export declare function serializeProofToHex(proof: Groth16Proof, curve?: ProofCurveId): string;
/** Inverse of {@link serializeProofToHex}. */
export declare function deserializeProofFromHex(hex: string): {
    proof: Groth16Proof;
    curve: ProofCurveId;
};
//# sourceMappingURL=proofSerialization.d.ts.map