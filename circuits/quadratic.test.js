/**
 * Circuit tests for ZK Quadratic Voting with range proofs.
 *
 * Exercises the real Circom toolchain via circom_tester (witness generation +
 * constraint checking), covering:
 *   - the standalone bit-decomposition range proof, and
 *   - the full quadratic-vote circuit (membership, nullifier, sum-of-squares
 *     cost, allocations-hash binding, per-allocation range, and budget cap).
 *
 * Run with: npm test -- --testPathPattern=quadratic
 * Requires the `circom` compiler (>= 2.2) on PATH.
 */
const path = require("path");
const wasm_tester = require("circom_tester").wasm;
const { buildPoseidon } = require("circomlibjs");

// Test circuit parameters (must mirror circuits/test/quadratic_vote_test.circom).
const LEVELS = 4;
const N = 3;
const MAX_CREDITS = 5;
const MAX_BUDGET = 10;

let poseidon;
let F;

// Poseidon over the BN254 scalar field, returned as a native BigInt.
function hash(inputs) {
  return F.toObject(poseidon(inputs.map((x) => BigInt(x))));
}

// Merkle root for a leaf at index 0 in an all-zero tree of depth LEVELS.
// Returns { root, pathElements, pathIndices }.
function merkleForLeafZero(leaf, levels) {
  const zeros = [0n];
  for (let i = 0; i < levels; i++) {
    zeros.push(hash([zeros[i], zeros[i]]));
  }
  const pathElements = [];
  const pathIndices = [];
  let cur = BigInt(leaf);
  for (let i = 0; i < levels; i++) {
    pathElements.push(zeros[i]); // sibling on the right
    pathIndices.push(0); // current node is always the left child
    cur = hash([cur, zeros[i]]);
  }
  return { root: cur, pathElements, pathIndices };
}

// Build a full, valid input for the quadratic-vote test circuit.
function buildQvInput({ voiceCredits, allocProposalIds, overrides = {} }) {
  const secret = 111n;
  const salt = 222n;
  const daoId = 1n;
  const proposalId = 7n;

  const commitment = hash([secret, salt]);
  const { root, pathElements, pathIndices } = merkleForLeafZero(commitment, LEVELS);
  const nullifier = hash([secret, daoId, proposalId]);

  const totalCreditsSpent = voiceCredits.reduce(
    (acc, v) => acc + BigInt(v) * BigInt(v),
    0n
  );

  const allocFlat = [];
  for (let i = 0; i < voiceCredits.length; i++) {
    allocFlat.push(BigInt(voiceCredits[i]));
    allocFlat.push(BigInt(allocProposalIds[i]));
  }
  const allocationsHash = hash(allocFlat);

  return {
    root,
    daoId,
    proposalId,
    nullifier,
    totalCreditsSpent,
    allocationsHash,
    secret,
    salt,
    pathElements,
    pathIndices,
    voiceCredits: voiceCredits.map((v) => BigInt(v)),
    allocProposalIds: allocProposalIds.map((v) => BigInt(v)),
    ...overrides,
  };
}

async function expectInvalid(circuit, input) {
  let threw = false;
  try {
    const witness = await circuit.calculateWitness(input, true);
    await circuit.checkConstraints(witness);
  } catch (e) {
    threw = true;
  }
  expect(threw).toBe(true);
}

beforeAll(async () => {
  poseidon = await buildPoseidon();
  F = poseidon.F;
});

describe("range_proof.circom (bit-decomposition range proof)", () => {
  let circuit;
  beforeAll(async () => {
    circuit = await wasm_tester(
      path.join(__dirname, "test", "range_proof_test.circom")
    );
  }, 120000);

  test("accepts a value inside [0, maxValue]", async () => {
    const witness = await circuit.calculateWitness({ in: 3, maxValue: 5 }, true);
    await circuit.checkConstraints(witness);
    await circuit.assertOut(witness, { out: 3 });
  });

  test("accepts the inclusive upper bound", async () => {
    const witness = await circuit.calculateWitness({ in: 5, maxValue: 5 }, true);
    await circuit.checkConstraints(witness);
  });

  test("accepts zero", async () => {
    const witness = await circuit.calculateWitness({ in: 0, maxValue: 5 }, true);
    await circuit.checkConstraints(witness);
  });

  test("rejects a value above maxValue", async () => {
    await expectInvalid(circuit, { in: 6, maxValue: 5 });
  });

  test("rejects a value that does not fit in BITS bits", async () => {
    // 16 requires 5 bits; the 4-bit recomposition cannot equal it.
    await expectInvalid(circuit, { in: 16, maxValue: 15 });
  });
});

describe("quadratic_vote.circom (QV with range proofs)", () => {
  let circuit;
  beforeAll(async () => {
    circuit = await wasm_tester(
      path.join(__dirname, "test", "quadratic_vote_test.circom")
    );
  }, 120000);

  test("accepts a valid ballot within budget and range (3+1+0 => 10 credits)", async () => {
    const input = buildQvInput({
      voiceCredits: [3, 1, 0],
      allocProposalIds: [10, 20, 30],
    });
    expect(input.totalCreditsSpent).toBe(BigInt(MAX_BUDGET)); // 9 + 1 + 0
    const witness = await circuit.calculateWitness(input, true);
    await circuit.checkConstraints(witness);
  });

  test("accepts a strictly-under-budget ballot", async () => {
    const input = buildQvInput({
      voiceCredits: [2, 1, 1],
      allocProposalIds: [10, 20, 30],
    });
    expect(input.totalCreditsSpent).toBe(6n); // 4 + 1 + 1
    const witness = await circuit.calculateWitness(input, true);
    await circuit.checkConstraints(witness);
  });

  test("rejects overspending the budget (sum of squares > MAX_BUDGET)", async () => {
    // 3^2 + 2^2 + 1^2 = 14 > 10, each allocation still within range.
    const input = buildQvInput({
      voiceCredits: [3, 2, 1],
      allocProposalIds: [10, 20, 30],
    });
    expect(input.totalCreditsSpent).toBeGreaterThan(BigInt(MAX_BUDGET));
    await expectInvalid(circuit, input);
  });

  test("rejects a per-allocation value out of range (caught by range proof)", async () => {
    // 6 > MAX_CREDITS (5); total 36 also over budget, but range proof fails first.
    const input = buildQvInput({
      voiceCredits: [6, 0, 0],
      allocProposalIds: [10, 20, 30],
    });
    await expectInvalid(circuit, input);
  });

  test("rejects understating totalCreditsSpent", async () => {
    const input = buildQvInput({
      voiceCredits: [3, 1, 0],
      allocProposalIds: [10, 20, 30],
      overrides: { totalCreditsSpent: 5n }, // real cost is 10
    });
    await expectInvalid(circuit, input);
  });

  test("rejects a tampered allocationsHash", async () => {
    const input = buildQvInput({
      voiceCredits: [2, 1, 0],
      allocProposalIds: [10, 20, 30],
      overrides: { allocationsHash: 12345n },
    });
    await expectInvalid(circuit, input);
  });

  test("rejects a wrong nullifier", async () => {
    const input = buildQvInput({
      voiceCredits: [2, 1, 0],
      allocProposalIds: [10, 20, 30],
      overrides: { nullifier: 999n },
    });
    await expectInvalid(circuit, input);
  });

  test("rejects a non-member (wrong Merkle root)", async () => {
    const input = buildQvInput({
      voiceCredits: [2, 1, 0],
      allocProposalIds: [10, 20, 30],
      overrides: { root: 424242n },
    });
    await expectInvalid(circuit, input);
  });
});
