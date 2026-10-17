/**
 * Boundary and adversarial range-proof tests (SPIKE-112 / #774).
 *
 * The general RangeProof behaviour is already covered in quadratic.test.js.
 * This file targets the specific numeric-integrity gaps called out in SPIKE-112:
 *
 *   1. Field-element "negative" values (BN254 prime − 1, prime − 2, …) must not
 *      bypass the bit-decomposition bound even though they are valid field elements.
 *      SPIKE-112 names this the "field-vs-integer semantic gap": in-circuit 2^254
 *      wraps silently while Soroban traps — a prover submitting a huge field
 *      element as a "weight" or "amount" must be rejected.
 *
 *   2. maxValue = 0 (zero-credit ballot / zero-balance voter) is a valid edge case:
 *      only in = 0 may satisfy [0, 0].
 *
 *   3. in = maxValue = 2^BITS − 1 (exact top of the representable range) must be
 *      accepted; in = 2^BITS (one above) must be rejected.
 *
 *   4. Parametric off-by-one: in = maxValue + 1 must fail for a range of bounds,
 *      guarding against an off-by-one in the LessEqThan comparator.
 *
 * Run with: npm test -- --testPathPattern=range_proof
 * Requires: circom >= 2.2 on PATH.
 */

"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");

// Extend PATH so `circom` is found in common install locations.
for (const p of [
  path.join(os.homedir(), ".cargo", "bin"),
  "/home/runner/.cargo/bin",
  "/usr/local/bin",
  "/usr/bin",
]) {
  if (
    fs.existsSync(path.join(p, "circom")) &&
    !(process.env.PATH || "").includes(p)
  ) {
    process.env.PATH = `${p}:${process.env.PATH || ""}`;
  }
}

const wasm_tester = require("circom_tester").wasm;

// BN254 scalar-field prime.
// In circom every signal is a residue modulo this prime.  A "negative" value
// like −1 is represented as FIELD_PRIME − 1 — a valid field element that the
// range proof must reject because it cannot recompose from a bounded number of
// bits while equalling that field residue.
const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Expect the circuit to throw (constraint or assertion failure). */
async function expectInvalid(circuit, input) {
  let threw = false;
  try {
    const w = await circuit.calculateWitness(input, true);
    await circuit.checkConstraints(w);
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
}

describe("range_proof.circom — SPIKE-112 numeric-integrity edge cases (#774)", () => {
  // circuits/test/range_proof_test.circom instantiates RangeProof(4):
  // 4-bit decomposition, representable range [0, 2^4 − 1] = [0, 15].
  const BITS = 4;
  const MAX_REPRESENTABLE = (1n << BigInt(BITS)) - 1n; // 15n

  let circuit;
  beforeAll(async () => {
    circuit = await wasm_tester(
      path.join(__dirname, "test", "range_proof_test.circom")
    );
  }, 120_000);

  // ── 1. Field-element "negative" values ───────────────────────────────────────
  // Attackers who control witness generation can supply FIELD_PRIME − k instead
  // of a small integer.  The bit-decomposition constraint acc === in must fail
  // because a BITS-bit accumulator tops out at 2^BITS − 1, which is nowhere
  // near FIELD_PRIME − 1 as a field residue.

  test("rejects FIELD_PRIME − 1 (field-representation of −1)", async () => {
    await expectInvalid(circuit, {
      in: FIELD_PRIME - 1n,
      maxValue: MAX_REPRESENTABLE,
    });
  });

  test("rejects FIELD_PRIME − 2 (field-representation of −2)", async () => {
    await expectInvalid(circuit, {
      in: FIELD_PRIME - 2n,
      maxValue: MAX_REPRESENTABLE,
    });
  });

  // A value just above 2^BITS but still far below FIELD_PRIME also fails the
  // bit-decomposition recomposition, confirming the check is not only triggered
  // by extreme values.
  test("rejects a value that requires more than BITS bits (256, << FIELD_PRIME)", async () => {
    await expectInvalid(circuit, { in: 256n, maxValue: MAX_REPRESENTABLE });
  });

  // ── 2. maxValue = 0 (zero-credit / zero-balance boundary) ──────────────────
  // A DAO may legitimately issue zero-balance participation tokens.  The range
  // [0, 0] must accept only in = 0 and reject everything else.

  test("accepts in = 0 with maxValue = 0 (only valid zero-credit value)", async () => {
    const w = await circuit.calculateWitness({ in: 0, maxValue: 0 }, true);
    await circuit.checkConstraints(w);
    await circuit.assertOut(w, { out: 0n });
  });

  test("rejects in = 1 with maxValue = 0", async () => {
    await expectInvalid(circuit, { in: 1, maxValue: 0 });
  });

  // ── 3. Exact top of the representable range ────────────────────────────────
  // in = maxValue = 2^BITS − 1 is the largest legitimate value; it must be
  // accepted.  in = 2^BITS is one bit too wide and must be rejected even when
  // maxValue is naïvely set to 2^BITS (a caller error that could happen if the
  // bound is computed as max_credits rather than max_credits − 1).

  test("accepts in = maxValue = 2^BITS − 1 (top of representable range)", async () => {
    const w = await circuit.calculateWitness(
      { in: MAX_REPRESENTABLE, maxValue: MAX_REPRESENTABLE },
      true
    );
    await circuit.checkConstraints(w);
    await circuit.assertOut(w, { out: MAX_REPRESENTABLE });
  });

  test("rejects in = 2^BITS (one above the representable range)", async () => {
    // 2^4 = 16 requires a 5th bit; the 4-bit recomposition accumulates at most 15,
    // so acc === in fails.
    await expectInvalid(circuit, {
      in: MAX_REPRESENTABLE + 1n,
      maxValue: MAX_REPRESENTABLE + 1n,
    });
  });

  // ── 4. Parametric off-by-one (in = maxValue + 1 for several bounds) ─────────
  // Guards against an off-by-one in the LessEqThan comparator where the
  // exclusive upper bound is accidentally treated as inclusive (or vice versa).

  test("rejects in = maxValue + 1 across a range of bounds", async () => {
    for (const maxVal of [0n, 1n, 5n, 10n, 13n, 14n]) {
      // Each of these requires BITS < 5 bits, so the bit-decomposition itself is
      // well-formed; the rejection comes from the LessEqThan comparator alone.
      await expectInvalid(circuit, { in: maxVal + 1n, maxValue: maxVal });
    }
  });

  // ── 5. Regression: mid-range values still accepted after edge-case additions ─

  test("accepts in = 7 with maxValue = 10 (mid-range regression)", async () => {
    const w = await circuit.calculateWitness({ in: 7, maxValue: 10 }, true);
    await circuit.checkConstraints(w);
    await circuit.assertOut(w, { out: 7n });
  });

  test("accepts in = 1 with maxValue = 1 (single non-zero boundary)", async () => {
    const w = await circuit.calculateWitness({ in: 1, maxValue: 1 }, true);
    await circuit.checkConstraints(w);
    await circuit.assertOut(w, { out: 1n });
  });
});
