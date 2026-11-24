/**
 * Tests for the WeightedVoteBalanceProof circuit (Issue #127).
 *
 * These use the compiled witness calculator directly (rather than
 * `circom_tester`) because `circom_tester` shells out to the `circom`
 * binary with an unquoted absolute path, which breaks on checkouts whose
 * path contains a space (this repo is cloned under a directory containing
 * a literal space). Invoking the generated `witness_calculator.js` in
 * process sidesteps that shell-quoting issue entirely while still
 * exercising the real compiled circuit.
 *
 * Run `npm run compile:weighted-vote` (see package.json) before running
 * this test file if `build/weighted_vote/` is not present.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

// Ensure ~/.cargo/bin and common install paths are in process.env.PATH for circom
const extraPaths = [
  path.join(os.homedir(), ".cargo", "bin"),
  "/home/runner/.cargo/bin",
  "/usr/local/bin",
  "/usr/bin",
];
for (const p of extraPaths) {
  if (fs.existsSync(path.join(p, "circom")) && !(process.env.PATH || "").includes(p)) {
    process.env.PATH = `${p}:${process.env.PATH || ""}`;
  }
}

const { execFileSync } = require("child_process");
const { buildPoseidon } = require("circomlibjs");

const BUILD_DIR = path.join(__dirname, "..", "build", "weighted_vote");
const WASM_PATH = path.join(BUILD_DIR, "weighted_vote_js", "weighted_vote.wasm");
const WC_PATH = path.join(BUILD_DIR, "weighted_vote_js", "witness_calculator.js");
const CIRCUIT_SRC = path.join(__dirname, "..", "weighted_vote.circom");

function ensureCompiled() {
  if (fs.existsSync(WASM_PATH) && fs.existsSync(WC_PATH)) return;
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  execFileSync(
    "circom",
    [CIRCUIT_SRC, "--r1cs", "--wasm", "--sym", "-o", BUILD_DIR],
    { stdio: "inherit" },
  );
}

let poseidon;
async function balanceCommitment(balance, blindingFactor) {
  if (!poseidon) poseidon = await buildPoseidon();
  return poseidon.F.toString(poseidon([BigInt(balance), BigInt(blindingFactor)]));
}

async function calculateWitness(input) {
  const wasmBuffer = fs.readFileSync(WASM_PATH);
  const buildWitnessCalculator = require(WC_PATH);
  const wc = await buildWitnessCalculator(wasmBuffer);
  // sanityCheck=true makes the calculator throw on any unsatisfied
  // constraint (e.g. Num2Bits booleanity, LessEqThan, or the `===`
  // equality constraints), which is exactly the soundness property we
  // want to test for invalid inputs.
  return wc.calculateWitness(input, true);
}

describe("WeightedVoteBalanceProof circuit", () => {
  beforeAll(() => {
    ensureCompiled();
  }, 120000);

  const MAX_SUPPLY = 1000000n; // fits well within 128 bits

  test("completeness: balance = 0 (lower boundary) is accepted", async () => {
    const balance = 0n;
    const blinding = 12345n;
    const commitment = await balanceCommitment(balance, blinding);

    const witness = await calculateWitness({
      balanceCommitment: commitment,
      maxSupply: MAX_SUPPLY.toString(),
      voteWeight: balance.toString(),
      balance: balance.toString(),
      blindingFactor: blinding.toString(),
    });
    expect(witness).toBeDefined();
  });

  test("completeness: balance = 1 is accepted", async () => {
    const balance = 1n;
    const blinding = 777n;
    const commitment = await balanceCommitment(balance, blinding);

    const witness = await calculateWitness({
      balanceCommitment: commitment,
      maxSupply: MAX_SUPPLY.toString(),
      voteWeight: balance.toString(),
      balance: balance.toString(),
      blindingFactor: blinding.toString(),
    });
    expect(witness).toBeDefined();
  });

  test("completeness: balance = maxSupply (upper boundary, inclusive) is accepted", async () => {
    const balance = MAX_SUPPLY;
    const blinding = 999n;
    const commitment = await balanceCommitment(balance, blinding);

    const witness = await calculateWitness({
      balanceCommitment: commitment,
      maxSupply: MAX_SUPPLY.toString(),
      voteWeight: balance.toString(),
      balance: balance.toString(),
      blindingFactor: blinding.toString(),
    });
    expect(witness).toBeDefined();
  });

  test("completeness: an interior balance value is accepted", async () => {
    const balance = 424242n;
    const blinding = 42n;
    const commitment = await balanceCommitment(balance, blinding);

    const witness = await calculateWitness({
      balanceCommitment: commitment,
      maxSupply: MAX_SUPPLY.toString(),
      voteWeight: balance.toString(),
      balance: balance.toString(),
      blindingFactor: blinding.toString(),
    });
    expect(witness).toBeDefined();
  });

  test("soundness: balance > maxSupply (out of range) is rejected", async () => {
    const balance = MAX_SUPPLY + 1n;
    const blinding = 1n;
    const commitment = await balanceCommitment(balance, blinding);

    await expect(
      calculateWitness({
        balanceCommitment: commitment,
        maxSupply: MAX_SUPPLY.toString(),
        voteWeight: balance.toString(),
        balance: balance.toString(),
        blindingFactor: blinding.toString(),
      }),
    ).rejects.toThrow();
  });

  test("soundness: voteWeight != balance is rejected (cannot claim a weight you don't hold)", async () => {
    const balance = 100n;
    const claimedWeight = 100000n; // attacker inflates the weight
    const blinding = 55n;
    const commitment = await balanceCommitment(balance, blinding);

    await expect(
      calculateWitness({
        balanceCommitment: commitment,
        maxSupply: MAX_SUPPLY.toString(),
        voteWeight: claimedWeight.toString(),
        balance: balance.toString(),
        blindingFactor: blinding.toString(),
      }),
    ).rejects.toThrow();
  });

  test("soundness: a mismatched balanceCommitment is rejected (can't lie about balance)", async () => {
    const balance = 500n;
    const blinding = 8n;
    const wrongCommitment = await balanceCommitment(balance + 1n, blinding); // commitment to a different balance

    await expect(
      calculateWitness({
        balanceCommitment: wrongCommitment,
        maxSupply: MAX_SUPPLY.toString(),
        voteWeight: balance.toString(),
        balance: balance.toString(),
        blindingFactor: blinding.toString(),
      }),
    ).rejects.toThrow();
  });

  test("soundness: a negative-looking balance (field-wraparound attempt) is rejected", async () => {
    // Attempting to pass p-1 (which is congruent to -1 mod p) as `balance`
    // should fail the 128-bit range decomposition, since p-1 is far larger
    // than 2^128.
    const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const balance = FIELD_MODULUS - 1n;
    const blinding = 3n;
    const commitment = await balanceCommitment(balance, blinding);

    await expect(
      calculateWitness({
        balanceCommitment: commitment,
        maxSupply: MAX_SUPPLY.toString(),
        voteWeight: balance.toString(),
        balance: balance.toString(),
        blindingFactor: blinding.toString(),
      }),
    ).rejects.toThrow();
  });
  // -------------------------------------------------------------------------
  // The anchor is NOT in this circuit, and these tests exist so nobody
  // re-discovers that the hard way.
  //
  // `balanceCommitment` is a *public* input, so the prover chooses it. Every
  // test above derives the commitment from an "honest" balance, which makes
  // the circuit look sound in isolation. It is not: the statement it proves is
  // "voteWeight == balance", where `balance` is itself prover-chosen. There is
  // no in-circuit check that the protocol ever issued the commitment.
  //
  // The control is contract-side: `Voting::vote_weighted` refuses any
  // `balanceCommitment` the DAO did not pin via
  // `set_weighted_balance_commitment`. These tests document the exact inputs
  // that must therefore never be accepted on-chain, and they fail loudly if a
  // future change to this circuit starts rejecting them -- at which point the
  // anchor has moved into the circuit and the contract-side pin can be
  // revisited.
  // -------------------------------------------------------------------------

  test("KNOWN LIMITATION: a prover-chosen commitment yields a max-range weight", async () => {
    // The forged statement from the audit: claim the entire 128-bit range.
    const balance = 2n ** 128n - 1n;
    const blinding = 42n;
    const commitment = await balanceCommitment(balance, blinding);

    const witness = await calculateWitness({
      balanceCommitment: commitment,
      maxSupply: balance.toString(),
      voteWeight: balance.toString(),
      balance: balance.toString(),
      blindingFactor: blinding.toString(),
    });

    // The circuit accepts it. This is the vulnerability, asserted so it cannot
    // silently change. If this test ever starts failing, the anchor landed in
    // the circuit -- update contracts/voting/src/lib.rs accordingly.
    expect(witness).toBeDefined();
    expect(witness[3].toString()).toBe(balance.toString());
  });

  test("KNOWN LIMITATION: the same weight is reachable from many distinct commitments", async () => {
    // A fixed weight with many valid commitments shows the commitment carries
    // no information the protocol issued: it is just Poseidon(weight, salt).
    const weight = 12345n;
    const blindings = [1n, 2n, 3n, 4n, 5n];
    const commitments = await Promise.all(
      blindings.map((blinding) => balanceCommitment(weight, blinding)),
    );
    // Distinct salts give distinct commitments for the same weight, so the
    // commitment conveys nothing about whether the protocol ever issued it.
    expect(new Set(commitments).size).toBe(blindings.length);

    for (const [i, commitment] of commitments.entries()) {
      const witness = await calculateWitness({
        balanceCommitment: commitment,
        maxSupply: MAX_SUPPLY.toString(),
        voteWeight: weight.toString(),
        balance: weight.toString(),
        blindingFactor: blindings[i].toString(),
      });
      expect(witness).toBeDefined();
    }
  });
});
