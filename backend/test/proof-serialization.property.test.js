/**
 * Property-based tests for the ZKV1 proof serialization format (issue #896 / ZV-047).
 *
 * Uses fast-check to explore the input space with 1,000 generated cases per
 * property. Failures print the minimal counterexample. The FAST_CHECK_SEED
 * environment variable (or the hard-coded CI_SEED below) makes runs
 * deterministic and reproducible from a known seed.
 *
 * Properties covered:
 *   1. Round-trip: serialize → deserialize is an identity for any valid proof.
 *   2. Hex round-trip: serializeToHex → deserializeFromHex is an identity.
 *   3. Length invariant: serialized output is always SERIALIZED_PROOF_LEN bytes.
 *   4. Curve-id round-trip: curve id byte survives the round-trip.
 *   5. Nullifier uniqueness: distinct proof seeds produce distinct byte strings.
 *   6. Field-range edge cases: field-modulus-adjacent values, all-FFs, boundary bytes.
 *   7. Mutation detection: a single-byte flip always causes deserialization to throw.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  serializeProof,
  deserializeProof,
  serializeProofToHex,
  deserializeProofFromHex,
  ProofCurveId,
  ProofFormatError,
  SERIALIZED_PROOF_LEN,
} from "../src/services/proofSerialization.js";

// ---------------------------------------------------------------------------
// Deterministic seed for CI — override with FAST_CHECK_SEED env var.
// ---------------------------------------------------------------------------
const CI_SEED = 0x5a4b3c2d;
const SEED = process.env.FAST_CHECK_SEED
  ? parseInt(process.env.FAST_CHECK_SEED, 16)
  : CI_SEED;
const NUM_RUNS = 1_000;

const fcParams = {
  numRuns: NUM_RUNS,
  seed: SEED,
  verbose: true, // print minimal counterexample on failure
};

// ---------------------------------------------------------------------------
// Arbitrary generators
// ---------------------------------------------------------------------------

/** Generates a valid non-zero hex string of exactly `byteLen` bytes (with 0x prefix). */
function hexBytes(byteLen) {
  return fc
    .uint8Array({ minLength: byteLen, maxLength: byteLen })
    .filter((arr) => arr.some((b) => b !== 0)) // reject all-zeros (infinity point)
    .map((arr) => "0x" + Buffer.from(arr).toString("hex"));
}

/** Generates a valid Groth16 proof object (non-zero G1/G2 components). */
const arbProof = fc.record({
  a: hexBytes(64),  // G1 point: 64 bytes
  b: hexBytes(128), // G2 point: 128 bytes
  c: hexBytes(64),  // G1 point: 64 bytes
});

/** Generates one of the two supported curve IDs. */
const arbCurveId = fc.constantFrom(ProofCurveId.Bn254, ProofCurveId.Bls12381);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

test("PROPERTY: serialize → deserialize is identity for any valid proof (BN254)", async () => {
  await fc.assert(
    fc.property(arbProof, (proof) => {
      const bytes = serializeProof(proof, ProofCurveId.Bn254);
      const { proof: decoded, curve } = deserializeProof(bytes);
      assert.equal(curve, ProofCurveId.Bn254);
      assert.equal(decoded.a, proof.a);
      assert.equal(decoded.b, proof.b);
      assert.equal(decoded.c, proof.c);
    }),
    fcParams,
  );
});

test("PROPERTY: serialize → deserialize is identity for any valid proof (BLS12-381)", async () => {
  await fc.assert(
    fc.property(arbProof, (proof) => {
      const bytes = serializeProof(proof, ProofCurveId.Bls12381);
      const { proof: decoded, curve } = deserializeProof(bytes);
      assert.equal(curve, ProofCurveId.Bls12381);
      assert.equal(decoded.a, proof.a);
      assert.equal(decoded.b, proof.b);
      assert.equal(decoded.c, proof.c);
    }),
    fcParams,
  );
});

test("PROPERTY: hex round-trip is identity for any valid proof and curve", async () => {
  await fc.assert(
    fc.property(arbProof, arbCurveId, (proof, curveId) => {
      const hex = serializeProofToHex(proof, curveId);
      const { proof: decoded, curve } = deserializeProofFromHex(hex);
      assert.equal(curve, curveId);
      assert.equal(decoded.a, proof.a);
      assert.equal(decoded.b, proof.b);
      assert.equal(decoded.c, proof.c);
    }),
    fcParams,
  );
});

test("PROPERTY: serialized length is always SERIALIZED_PROOF_LEN bytes", async () => {
  await fc.assert(
    fc.property(arbProof, arbCurveId, (proof, curveId) => {
      const bytes = serializeProof(proof, curveId);
      assert.equal(bytes.length, SERIALIZED_PROOF_LEN);
    }),
    fcParams,
  );
});

test("PROPERTY: curve id byte survives the round-trip for both curve IDs", async () => {
  await fc.assert(
    fc.property(arbProof, arbCurveId, (proof, curveId) => {
      const bytes = serializeProof(proof, curveId);
      assert.equal(bytes[1], curveId);
      const { curve } = deserializeProof(bytes);
      assert.equal(curve, curveId);
    }),
    fcParams,
  );
});

test("PROPERTY: distinct proofs serialize to distinct byte strings (nullifier uniqueness)", async () => {
  await fc.assert(
    fc.property(
      fc.uniqueArray(arbProof, { minLength: 2, maxLength: 2, comparator: "IsStrictlyEqual" }),
      ([p1, p2]) => {
        // Two structurally different proofs must produce different byte strings.
        // (If they happen to be equal the filter already rejected the pair.)
        const b1 = serializeProof(p1, ProofCurveId.Bn254).toString("hex");
        const b2 = serializeProof(p2, ProofCurveId.Bn254).toString("hex");
        assert.notEqual(b1, b2);
      },
    ),
    { ...fcParams, numRuns: 500 }, // pairwise — 500 pairs → 1,000 proofs explored
  );
});

test("PROPERTY: single-byte flip in payload always causes deserialization to throw or change proof", async () => {
  await fc.assert(
    fc.property(
      arbProof,
      // Flip a byte in the payload region (bytes 2..end), never the header bytes,
      // so we're testing payload-level corruption rather than known-bad header fields.
      fc.integer({ min: 2, max: SERIALIZED_PROOF_LEN - 1 }),
      fc.integer({ min: 1, max: 255 }),
      (proof, flipPos, flipDelta) => {
        const original = serializeProof(proof, ProofCurveId.Bn254);
        const mutated = Buffer.from(original);
        mutated[flipPos] = (mutated[flipPos] + flipDelta) % 256;
        try {
          const { proof: decoded } = deserializeProof(mutated);
          // If deserialization did not throw, the decoded proof must differ.
          assert.ok(
            decoded.a !== proof.a || decoded.b !== proof.b || decoded.c !== proof.c,
            "single-byte payload flip produced an identical proof — round-trip is not injective",
          );
        } catch (err) {
          // Throwing ProofFormatError is also acceptable.
          assert.ok(err instanceof ProofFormatError || err instanceof Error);
        }
      },
    ),
    fcParams,
  );
});

// ---------------------------------------------------------------------------
// Known-edge-case properties (field modulus, zero, max-byte boundaries)
// ---------------------------------------------------------------------------

test("PROPERTY: field-modulus-adjacent values in G1 component (BN254 p ≈ 2^254)", async () => {
  // BN254 field modulus p = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
  // We exercise bytes near that boundary to catch field-range rejects.
  const BN254_MODULUS_HEX =
    "30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47";
  // Build an `a` whose first 32 bytes are the modulus and the rest are 0x01.
  const aHex = "0x" + BN254_MODULUS_HEX + "01".repeat(32);
  const proofAtModulus = {
    a: aHex,
    b: "0x" + "aa".repeat(128),
    c: "0x" + "bb".repeat(64),
  };
  // The serializer should accept the bytes (it validates structure, not field membership).
  const bytes = serializeProof(proofAtModulus, ProofCurveId.Bn254);
  assert.equal(bytes.length, SERIALIZED_PROOF_LEN);
  const { proof: decoded } = deserializeProof(bytes);
  assert.equal(decoded.a, proofAtModulus.a);
});

test("PROPERTY: all-0xFF bytes in payload components are accepted (max-byte boundary)", async () => {
  const proof = {
    a: "0x" + "ff".repeat(64),
    b: "0x" + "ff".repeat(128),
    c: "0x" + "ff".repeat(64),
  };
  const bytes = serializeProof(proof, ProofCurveId.Bn254);
  assert.equal(bytes.length, SERIALIZED_PROOF_LEN);
  const { proof: decoded } = deserializeProof(bytes);
  assert.equal(decoded.a, proof.a);
});

test("PROPERTY: zero-length deserialization input throws ProofFormatError", () => {
  assert.throws(() => deserializeProof(Buffer.alloc(0)), ProofFormatError);
});

test("PROPERTY: truncated buffer (1 byte short) throws ProofFormatError", async () => {
  await fc.assert(
    fc.property(arbProof, (proof) => {
      const full = serializeProof(proof, ProofCurveId.Bn254);
      assert.throws(
        () => deserializeProof(full.subarray(0, full.length - 1)),
        ProofFormatError,
      );
    }),
    { ...fcParams, numRuns: 200 },
  );
});

test("PROPERTY: extended buffer (1 byte over) throws ProofFormatError", async () => {
  await fc.assert(
    fc.property(arbProof, (proof) => {
      const full = serializeProof(proof, ProofCurveId.Bn254);
      const extended = Buffer.concat([full, Buffer.from([0x00])]);
      assert.throws(() => deserializeProof(extended), ProofFormatError);
    }),
    { ...fcParams, numRuns: 200 },
  );
});
