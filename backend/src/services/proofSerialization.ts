/**
 * Audit-Friendly Proof Serialization Format (ZKV1) — backend facade.
 *
 * The wire format, constants and the legacy snarkjs adapter are generated from
 * `shared/protocol-manifest.json` into `../generated/zkv1.ts`. This module
 * keeps the Buffer-based API used by the relayer and its tests while delegating
 * all format decisions to that single generated implementation.
 *
 * Wire format (big-endian throughout):
 *
 *   [ version (1B) | curve_id (1B) | A_x (32B) | A_y (32B)
 *     | B_x1 (32B) | B_x0 (32B) | B_y1 (32B) | B_y0 (32B)
 *     | C_x (32B) | C_y (32B) ]
 */

import type { Groth16Proof } from "../types/index.js";
import {
  ProofCurveId,
  ProofFormatError,
  SERIALIZED_PROOF_LEN,
  deserializeProofBytes,
  serializeProofBytes,
  snarkjsToZkv1,
  zkv1ToSnarkjs,
  encodePublicSignalsBE,
  assertSignalCount,
  PUBLIC_SIGNALS,
  PROOF_OFFSETS,
  B_COORDINATE_ORDER,
  PROOF_FORMAT,
  VK_SHAPE,
  NUM_PUBLIC_SIGNALS,
  VK_IC_LENGTH,
  CIRCUIT_IDS,
  type Zkv1Proof,
  type SnarkjsProof,
} from "../generated/zkv1.js";

export {
  ProofCurveId,
  ProofFormatError,
  SERIALIZED_PROOF_LEN,
  snarkjsToZkv1,
  zkv1ToSnarkjs,
  encodePublicSignalsBE,
  assertSignalCount,
  PUBLIC_SIGNALS,
  PROOF_OFFSETS,
  B_COORDINATE_ORDER,
  PROOF_FORMAT,
  VK_SHAPE,
  NUM_PUBLIC_SIGNALS,
  VK_IC_LENGTH,
  CIRCUIT_IDS,
  type Zkv1Proof,
  type SnarkjsProof,
};

export { PROOF_FORMAT_VERSION, G1_LEN, G2_LEN } from "../generated/zkv1.js";

/** Serialize a `Groth16Proof` (hex a/b/c) into the versioned ZKV1 byte format. */
export function serializeProof(
  proof: Groth16Proof,
  curve: ProofCurveId = ProofCurveId.Bn254,
): Buffer {
  const payload: Zkv1Proof = { a: proof.a, b: proof.b, c: proof.c };
  return Buffer.from(serializeProofBytes(payload, curve));
}

/** Deserialize a ZKV1 buffer into hex a/b/c plus the curve tag. */
export function deserializeProof(bytes: Buffer | Uint8Array): {
  proof: Groth16Proof;
  curve: ProofCurveId;
} {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const decoded = deserializeProofBytes(view);
  return {
    proof: {
      a: decoded.proof.a,
      b: decoded.proof.b,
      c: decoded.proof.c,
    } as Groth16Proof,
    curve: decoded.curve,
  };
}

/** ZKV1 bytes as a `0x`-prefixed hex string (logs / audit trails / fixtures). */
export function serializeProofToHex(
  proof: Groth16Proof,
  curve: ProofCurveId = ProofCurveId.Bn254,
): string {
  return "0x" + serializeProof(proof, curve).toString("hex");
}

/** Inverse of `serializeProofToHex`. */
export function deserializeProofFromHex(hex: string): {
  proof: Groth16Proof;
  curve: ProofCurveId;
} {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length !== SERIALIZED_PROOF_LEN * 2) {
    throw new ProofFormatError("Invalid ZKV1 hex string");
  }
  return deserializeProof(Buffer.from(clean, "hex"));
}
