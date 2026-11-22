// Benchmark / cost-estimate harness for tally_universal.circom (ZV-112 /
// Issue #952).
//
// Honesty note (same convention as weighted_vote.benchmark.js and
// docs/spikes/698-701-protocol-boundary-findings.md): this is a *static*
// constraint-count estimate computed from the circuit's own structure, not
// a measured proving/verification wall-clock time. No circom compiler was
// available in the environment this was written in (see
// circuits/COMPILATION.md for the pinned-version install process), so the
// real numbers - witness generation time, proving time, verification
// time, and peak memory, per semantics and per batch size `n` - still need
// to be collected by running this against actual compiled artifacts:
//
//   circom circuits/tally_universal.circom --r1cs --wasm --sym -o build/
//   snarkjs groth16 setup build/tally_universal.r1cs ...
//   snarkjs groth16 fullprove ... (per semantics, per n)
//
// Until that is done, treat every number below as a *budget estimate*,
// not a measurement, and do not cite it as "within agreed budgets" for a
// production decision.

const PER_SLOT_CONSTRAINTS = {
  // active[i]*(1-active[i])===0, (1-active[i])*nullifiers[i]===0,
  // nullAcc/activeAcc running sums (1 each), plus the semantics-specific
  // per-slot cost below.
  yesNo: 2 /* active bool + nullifier-zeroing */ + 2 /* nullAcc, activeAcc */ +
    1 /* choice boolean */ + 1 /* choice zeroing on padding */ + 1 /* yesAcc */,
  qv: 2 + 2 + 1 /* creditsSpent zeroing on padding */ + 1 /* creditsAcc */,
  weighted: 2 + 2 + 1 /* weight zeroing on padding */ + 1 /* weightAcc */,
};

const FIXED_CONSTRAINTS = {
  // semanticsId === SEMANTICS_ID, semanticsVersion === SEMANTICS_VERSION,
  // plus the final nullifierRoot/numActive/<output> bindings.
  yesNo: 2 + 3,
  qv: 2 + 3,
  weighted: 2 + 3,
};

function estimateConstraints(semantics, n) {
  return FIXED_CONSTRAINTS[semantics] + PER_SLOT_CONSTRAINTS[semantics] * n;
}

function run() {
  const batchSizes = [1, 8, 16, 32, 64];
  console.log("Static constraint-count estimate (NOT a measured proving time):\n");
  console.log("n\tyesNo\tqv\tweighted");
  for (const n of batchSizes) {
    console.log(
      [
        n,
        estimateConstraints("yesNo", n),
        estimateConstraints("qv", n),
        estimateConstraints("weighted", n),
      ].join("\t")
    );
  }
  console.log(
    "\nFor reference, tally.circom's fixed 2-vote accumulator is ~10-12 constraints total."
  );
  console.log(
    "These three templates are linear in n per semantics and comparable to each other,"
  );
  console.log(
    "which is expected: they share the same accumulator skeleton and differ only in the"
  );
  console.log("per-ballot output arithmetic. Actual proving/verification wall-clock time,");
  console.log("witness-generation time, and peak memory are NOT estimated here and require");
  console.log("the real circom + snarkjs pipeline (see header comment).");
}

if (require.main === module) {
  run();
}

module.exports = { estimateConstraints };
