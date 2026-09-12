/**
 * Proof Service & Circuit Input Validation (#88)
 *
 * Circom operates over the BN254 scalar field (Fr, order r ≈ 2^254).
 * Input values larger than the field modulus silently wrap around in
 * snarkjs/circom witness generation without throwing. If inputs exceed
 * the modulus, the circuit will produce proofs for reduced values
 * (modular aliasing), proving unintended or incorrect statements.
 *
 * This service enforces strict pre-proving validation:
 * 1. All field elements must satisfy: 0 <= val < BN254_MODULUS
 * 2. Merkle tree pathIndices must be strictly binary: val in {0, 1}
 * 3. Range-checks are validated before passing inputs to prover workers or snarkjs
 */

import {
  generateVoteProof as libGenerateVoteProof,
  generateWeightedVoteProof as libGenerateWeightedVoteProof,
  generateTallyProof as libGenerateTallyProof,
  generateCommentProof as libGenerateCommentProof,
  type VoteProofInput,
  type WeightedVoteProofInput,
  type TallyProofInput,
  type CommentProofInput,
  type GeneratedProof,
} from "../lib/zkproof";

/**
 * BN254 scalar field modulus (Fr order):
 * r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
 * Matches backend/src/config.ts and frontend/src/types/index.ts
 */
export const BN254_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

/**
 * BN254 scalar field modulus in hexadecimal representation (64 chars, big-endian)
 */
export const BN254_MODULUS_HEX =
  "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";

/**
 * Parse an unknown input value into a BigInt if possible.
 * Handles decimal strings, hex strings (with or without 0x prefix), numbers, and BigInts.
 */
export function toBigInt(val: unknown): bigint | null {
  if (typeof val === "bigint") {
    return val;
  }
  if (typeof val === "number") {
    if (!Number.isFinite(val) || !Number.isInteger(val)) return null;
    return BigInt(val);
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return null;

    try {
      if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
        const hexBody = trimmed.slice(2);
        if (!/^[0-9a-fA-F]+$/.test(hexBody)) return null;
        return BigInt(trimmed);
      }
      if (/^\d+$/.test(trimmed)) {
        return BigInt(trimmed);
      }
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return BigInt(`0x${trimmed}`);
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Check if a value is a valid BN254 scalar field element:
 * 0 <= value < BN254_MODULUS
 */
export function isValidFieldElement(val: unknown): boolean {
  const big = toBigInt(val);
  if (big === null) return false;
  return big >= 0n && big < BN254_MODULUS;
}

/**
 * Assert that a value is a valid field element (< BN254_MODULUS).
 * Throws a descriptive Error on failure.
 */
export function assertValidFieldElement(val: unknown, name = "value"): void {
  const big = toBigInt(val);
  if (big === null) {
    throw new Error(
      `Invalid field element for ${name}: unable to parse integer representation`,
    );
  }
  if (big < 0n) {
    throw new Error(`Field element ${name} must be non-negative, got ${big}`);
  }
  if (big >= BN254_MODULUS) {
    throw new Error(
      `Field element overflow for ${name}: value ${big.toString()} exceeds or equals BN254 scalar field modulus (${BN254_MODULUS.toString()})`,
    );
  }
}

/**
 * Verify that a path index is strictly binary (0 or 1).
 */
export function isBinaryPathIndex(val: unknown): boolean {
  if (typeof val === "number") {
    return val === 0 || val === 1;
  }
  if (typeof val === "bigint") {
    return val === 0n || val === 1n;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    return trimmed === "0" || trimmed === "1";
  }
  return false;
}

/**
 * Assert that a path index is binary (0 or 1).
 */
export function assertBinaryPathIndex(val: unknown, name = "pathIndex"): void {
  if (!isBinaryPathIndex(val)) {
    throw new Error(
      `Invalid path index for ${name}: must be binary (0 or 1), got ${String(val)}`,
    );
  }
}

/**
 * Validate an array of path indices to ensure every element is binary (0 or 1).
 */
export function validateBinaryPathIndices(
  indices: unknown[],
  arrayName = "pathIndices",
): void {
  if (!Array.isArray(indices)) {
    throw new Error(`${arrayName} must be an array`);
  }
  for (let i = 0; i < indices.length; i++) {
    assertBinaryPathIndex(indices[i], `${arrayName}[${i}]`);
  }
}

/**
 * Validate an array of field elements ensuring every item is < BN254_MODULUS.
 */
export function validateFieldElementArray(
  elements: unknown[],
  arrayName = "elements",
): void {
  if (!Array.isArray(elements)) {
    throw new Error(`${arrayName} must be an array`);
  }
  for (let i = 0; i < elements.length; i++) {
    assertValidFieldElement(elements[i], `${arrayName}[${i}]`);
  }
}

/**
 * Set of signal keys that represent binary path indices.
 */
const BINARY_INDEX_KEYS = new Set([
  "pathIndices",
  "votingPathIndices",
  "sbtPathIndices",
]);

/**
 * Set of signal keys that represent nested arrays of path indices.
 */
const NESTED_BINARY_INDEX_KEYS = new Set(["pathIndicesArray"]);

/**
 * Set of signal keys that represent arrays of field elements.
 */
const FIELD_ELEMENT_ARRAY_KEYS = new Set([
  "pathElements",
  "votingPathElements",
  "sbtPathElements",
  "nullifiers",
  "voteChoices",
  "weights",
  "voteWeights",
]);

/**
 * Validate all inputs to a circuit before executing proof generation.
 * Enforces BN254 scalar field bounds and binary path index constraints.
 */
export function validateCircuitInputs(inputs: Record<string, unknown>): void {
  if (!inputs || typeof inputs !== "object") {
    throw new Error("Circuit inputs must be a valid non-null object");
  }

  for (const [key, val] of Object.entries(inputs)) {
    if (val === undefined || val === null) {
      continue;
    }

    if (BINARY_INDEX_KEYS.has(key)) {
      if (Array.isArray(val)) {
        validateBinaryPathIndices(val, key);
      } else {
        assertBinaryPathIndex(val, key);
      }
      continue;
    }

    if (
      NESTED_BINARY_INDEX_KEYS.has(key) ||
      (key === "pathIndices" && Array.isArray(val) && Array.isArray(val[0]))
    ) {
      const nested = val as unknown[][];
      for (let i = 0; i < nested.length; i++) {
        validateBinaryPathIndices(nested[i], `${key}[${i}]`);
      }
      continue;
    }

    if (FIELD_ELEMENT_ARRAY_KEYS.has(key)) {
      if (Array.isArray(val)) {
        if (Array.isArray(val[0])) {
          const nested = val as unknown[][];
          for (let i = 0; i < nested.length; i++) {
            validateFieldElementArray(nested[i], `${key}[${i}]`);
          }
        } else {
          validateFieldElementArray(val, key);
        }
      }
      continue;
    }

    // Array of elements that are not explicitly binary indices
    if (Array.isArray(val)) {
      validateFieldElementArray(val, key);
      continue;
    }

    // Scalar inputs: check if it's a numeric/hex field element
    const parsed = toBigInt(val);
    if (parsed !== null) {
      assertValidFieldElement(val, key);
    }
  }
}

/**
 * Proof Service wrapping proof generation with mandatory pre-proving input validation.
 */
export const proofService = {
  BN254_MODULUS,
  BN254_MODULUS_HEX,
  isValidFieldElement,
  assertValidFieldElement,
  isBinaryPathIndex,
  assertBinaryPathIndex,
  validateBinaryPathIndices,
  validateFieldElementArray,
  validateCircuitInputs,

  /**
   * Validate and generate a vote proof.
   */
  async generateVoteProof(
    input: VoteProofInput,
    wasmPath: string | Uint8Array,
    zkeyPath: string | Uint8Array,
  ): Promise<GeneratedProof> {
    validateCircuitInputs(input as unknown as Record<string, unknown>);
    return libGenerateVoteProof(input, wasmPath, zkeyPath);
  },

  /**
   * Validate and generate a weighted vote proof.
   */
  async generateWeightedVoteProof(
    input: WeightedVoteProofInput,
    wasmPath: string | Uint8Array,
    zkeyPath: string | Uint8Array,
  ): Promise<GeneratedProof> {
    validateCircuitInputs(input as unknown as Record<string, unknown>);
    return libGenerateWeightedVoteProof(input, wasmPath, zkeyPath);
  },

  /**
   * Validate and generate a tally proof.
   */
  async generateTallyProof(
    input: TallyProofInput,
    wasmPath?: string | Uint8Array,
    zkeyPath?: string | Uint8Array,
  ): Promise<GeneratedProof> {
    validateCircuitInputs(input as unknown as Record<string, unknown>);
    return libGenerateTallyProof(input, wasmPath, zkeyPath);
  },

  /**
   * Validate and generate a comment proof.
   */
  async generateCommentProof(
    input: CommentProofInput,
    wasmPath: string | Uint8Array,
    zkeyPath: string | Uint8Array,
  ): Promise<GeneratedProof> {
    validateCircuitInputs(input as unknown as Record<string, unknown>);
    return libGenerateCommentProof(input, wasmPath, zkeyPath);
  },
};
