/**
 * Poseidon parameter validation tests (#91).
 *
 * These tests are the executable form of the acceptance criteria in issue #91:
 * they re-derive the Poseidon parameters from the published specification and
 * assert that the values shipped by circomlib — and therefore compiled into the
 * circuits, circomlibjs and the vendored on-chain copy — are exactly those.
 *
 * A failure here means the hash the protocol relies on is no longer the one the
 * security analysis covers.
 */

const path = require("path");
const fs = require("fs");

const audit = require("./utils/poseidon_param_audit.js");

const GOLDEN_PATH = path.join(__dirname, "utils", "poseidon_params_golden.json");

describe("Poseidon parameter derivation (Grain LFSR, hadeshash reference)", () => {
  const reference = audit.loadCircomlibConstants();

  // t = 3, 4, 5 are the widths ZK-VOTE instantiates: Merkle node hashing,
  // nullifier derivation and identity commitments respectively.
  const widths = audit.WIDTHS_IN_USE.map((w) => w.t);

  test.each(widths)(
    "t=%i round constants regenerate from the specified seed",
    (t) => {
      const roundsP = audit.CIRCOMLIB_ROUNDS_P[t - 2];
      const stream = audit.grainStream(t, audit.ROUNDS_F, roundsP);
      const derived = audit.generateRoundConstants(stream, t, audit.ROUNDS_F, roundsP);
      const shipped = reference.C[t - 2].map(BigInt);

      expect(derived).toHaveLength((audit.ROUNDS_F + roundsP) * t);
      expect(derived).toHaveLength(shipped.length);
      expect(derived.map(String)).toEqual(shipped.map(String));
    },
  );

  test.each(widths)("t=%i MDS matrix regenerates from the same seed", (t) => {
    const roundsP = audit.CIRCOMLIB_ROUNDS_P[t - 2];
    const derived = audit.deriveParameters(t, audit.ROUNDS_F, roundsP);
    const shipped = reference.M[t - 2].map((row) => row.map(BigInt));

    expect(derived.mds.map((r) => r.map(String))).toEqual(
      shipped.map((r) => r.map(String)),
    );
  });

  test("the derivation is seed-sensitive, not a hard-coded copy", () => {
    // Perturbing R_P changes the LFSR seed, so the stream must diverge.
    const withDeclaredRounds = audit.generateRoundConstants(
      audit.grainStream(3, 8, 57),
      3,
      8,
      57,
    );
    const withOtherRounds = audit.generateRoundConstants(
      audit.grainStream(3, 8, 58),
      3,
      8,
      58,
    );
    expect(withOtherRounds[0]).not.toEqual(withDeclaredRounds[0]);
  });
});

describe("MDS matrix security (algorithms 1-3 of generate_parameters_grain.sage)", () => {
  const reference = audit.loadCircomlibConstants();
  const widths = audit.WIDTHS_IN_USE.map((w) => w.t);

  test.each(widths)("t=%i has no invariant subspace (algorithm 1)", (t) => {
    const m = reference.M[t - 2].map((row) => row.map(BigInt));
    expect(audit.algorithm1(m, t)).toEqual({ secure: true });
  });

  test.each(widths)("t=%i has no subspace trail (algorithm 2)", (t) => {
    const m = reference.M[t - 2].map((row) => row.map(BigInt));
    expect(audit.algorithm2(m, t)).toEqual({ secure: true });
  });

  test.each(widths)("t=%i has no iterated subspace trail (algorithm 3)", (t) => {
    const m = reference.M[t - 2].map((row) => row.map(BigInt));
    expect(audit.algorithm3(m, t)).toEqual({ secure: true });
  });

  test("a matrix with an invariant subspace is rejected", () => {
    // Block-triangular: span{e_1, e_2} is invariant, so e_0's Krylov space
    // cannot reach the full space and algorithm 2 must reject it.
    const bad = [
      [2n, 0n, 0n],
      [0n, 3n, 5n],
      [0n, 7n, 11n],
    ];
    expect(audit.algorithm2(bad, 3).secure).toBe(false);
  });

  test("a scalar matrix is rejected", () => {
    const scalar = [
      [4n, 0n, 0n],
      [0n, 4n, 0n],
      [0n, 0n, 4n],
    ];
    expect(audit.algorithm1(scalar, 3).secure).toBe(false);
  });
});

describe("round numbers against the published security bounds", () => {
  const widths = audit.WIDTHS_IN_USE.map((w) => w.t);

  test.each(widths)("t=%i satisfies sat_inequiv_alpha as shipped", (t) => {
    const roundsP = audit.CIRCOMLIB_ROUNDS_P[t - 2];
    expect(audit.satInequivAlpha(t, audit.ROUNDS_F, roundsP).satisfied).toBe(true);
  });

  test.each(widths)("t=%i still satisfies it with the designers' margin removed", (t) => {
    const roundsP = audit.CIRCOMLIB_ROUNDS_P[t - 2];
    const bare = audit.satInequivAlpha(t, audit.ROUNDS_F - 2, Math.ceil(roundsP / 1.075));
    expect(bare.satisfied).toBe(true);
  });

  test.each(widths)("t=%i meets the reference parameter search", (t) => {
    const roundsP = audit.CIRCOMLIB_ROUNDS_P[t - 2];
    const recommended = audit.findRoundNumbers(t);
    expect(audit.ROUNDS_F).toBeGreaterThanOrEqual(recommended.roundsF);
    expect(roundsP).toBeGreaterThanOrEqual(recommended.roundsP);
  });

  test("too few rounds are detected as insecure", () => {
    // One partial round cannot clear the interpolation bound.
    expect(audit.satInequivAlpha(3, 8, 1).satisfied).toBe(false);
  });
});

describe("full audit", () => {
  test("every width ZK-VOTE instantiates passes all checks", () => {
    const results = audit.audit(audit.WIDTHS_IN_USE.map((w) => w.t));
    for (const r of results) {
      expect({ t: r.t, failures: r.failures }).toEqual({ t: r.t, failures: [] });
    }
  });
});

describe("golden vectors shared with the on-chain vendored parameters", () => {
  // The Rust contracts vendor a copy of the t=3 parameters (soroban-sdk keeps
  // its own module private). `contracts/membership-tree/src/poseidon_params.rs`
  // has a test that hashes its vendored tables and compares against this file,
  // so the two copies cannot drift apart silently.
  test("golden file matches the freshly derived parameters", () => {
    expect(fs.existsSync(GOLDEN_PATH)).toBe(true);
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));

    for (const entry of golden.widths) {
      const derived = audit.deriveParameters(entry.t, entry.rounds_f, entry.rounds_p);
      expect(derived.roundConstants.map((v) => v.toString(16).padStart(64, "0"))).toEqual(
        entry.round_constants,
      );
      expect(derived.mds.map((row) => row.map((v) => v.toString(16).padStart(64, "0")))).toEqual(
        entry.mds,
      );
    }
  });

  test("golden file records the field and round parameters the contracts assume", () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
    expect(golden.modulus).toBe(audit.P.toString());
    expect(golden.sbox_exponent).toBe(audit.ALPHA);
    const t3 = golden.widths.find((w) => w.t === 3);
    expect(t3).toBeDefined();
    expect(t3.rounds_f).toBe(8);
    expect(t3.rounds_p).toBe(57);
  });
});
