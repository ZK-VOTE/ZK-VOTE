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
import { hexToBytes, isAllZeros } from "./stellar.js";
/** Current wire-format version. Bump on any incompatible layout change. */
export const PROOF_FORMAT_VERSION = 1;
export var ProofCurveId;
(function (ProofCurveId) {
    ProofCurveId[ProofCurveId["Bn254"] = 0] = "Bn254";
    ProofCurveId[ProofCurveId["Bls12381"] = 1] = "Bls12381";
})(ProofCurveId || (ProofCurveId = {}));
const G1_LEN = 64;
const G2_LEN = 128;
/** Total length in bytes of a ZKV1-serialized proof. */
export const SERIALIZED_PROOF_LEN = 1 + 1 + G1_LEN + G2_LEN + G1_LEN;
export class ProofFormatError extends Error {
    constructor(message) {
        super(message);
        this.name = "ProofFormatError";
    }
}
/**
 * Serialize a `Groth16Proof` (hex-encoded a/b/c) into the versioned ZKV1
 * byte format.
 */
export function serializeProof(proof, curve = ProofCurveId.Bn254) {
    if (!proof || typeof proof !== "object") {
        throw new ProofFormatError("Invalid proof: must be an object");
    }
    if (!proof.a || !proof.b || !proof.c) {
        throw new ProofFormatError("Invalid proof: missing a, b, or c fields");
    }
    const aBytes = hexToBytes(proof.a, G1_LEN);
    const bBytes = hexToBytes(proof.b, G2_LEN);
    const cBytes = hexToBytes(proof.c, G1_LEN);
    if (isAllZeros(aBytes) || isAllZeros(bBytes) || isAllZeros(cBytes)) {
        throw new ProofFormatError("Invalid proof: proof components cannot be point at infinity (all zeros)");
    }
    return Buffer.concat([
        Buffer.from([PROOF_FORMAT_VERSION]),
        Buffer.from([curve]),
        aBytes,
        bBytes,
        cBytes,
    ]);
}
/**
 * Deserialize a ZKV1 byte buffer back into a `{ proof, curve }` pair.
 * Validates the version byte, curve id byte, and total length before
 * slicing out the fixed-size point components.
 */
export function deserializeProof(bytes) {
    if (!Buffer.isBuffer(bytes)) {
        throw new ProofFormatError("Invalid input: expected a Buffer");
    }
    if (bytes.length !== SERIALIZED_PROOF_LEN) {
        throw new ProofFormatError(`Invalid proof length: expected ${SERIALIZED_PROOF_LEN} bytes, got ${bytes.length}`);
    }
    const version = bytes[0];
    if (version !== PROOF_FORMAT_VERSION) {
        throw new ProofFormatError(`Unsupported proof format version: ${version} (expected ${PROOF_FORMAT_VERSION})`);
    }
    const curveByte = bytes[1];
    if (curveByte !== ProofCurveId.Bn254 && curveByte !== ProofCurveId.Bls12381) {
        throw new ProofFormatError(`Unknown curve id: ${curveByte}`);
    }
    const curve = curveByte;
    let offset = 2;
    const aBytes = bytes.subarray(offset, offset + G1_LEN);
    offset += G1_LEN;
    const bBytes = bytes.subarray(offset, offset + G2_LEN);
    offset += G2_LEN;
    const cBytes = bytes.subarray(offset, offset + G1_LEN);
    const proof = {
        a: "0x" + aBytes.toString("hex"),
        b: "0x" + bBytes.toString("hex"),
        c: "0x" + cBytes.toString("hex"),
    };
    return { proof, curve };
}
/**
 * Convenience helper returning the ZKV1 bytes as a `0x`-prefixed hex string,
 * useful for logging / audit trails / example vectors.
 */
export function serializeProofToHex(proof, curve = ProofCurveId.Bn254) {
    return "0x" + serializeProof(proof, curve).toString("hex");
}
/** Inverse of {@link serializeProofToHex}. */
export function deserializeProofFromHex(hex) {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    return deserializeProof(Buffer.from(clean, "hex"));
}
//# sourceMappingURL=proofSerialization.js.map