pragma circom 2.1.6;

// Universal tally-semantics verification circuits (ZV-112 / Issue #952).
//
// `tally.circom` is a two-vote accumulator example with no semantics
// verification: it binds a nullifier accumulator but not the voting
// semantics, so a syntactically valid tally proof could be produced for
// the wrong kind of ballot (e.g. a quadratic-voting tally reinterpreted as
// yes/no) without the circuit itself objecting. See
// docs/spikes/698-701-protocol-boundary-findings.md (#699) for the design
// recommendation this implements: pin a proposal-level
// (semanticsId, semanticsVersion) tuple and reject anything that does not
// match it.
//
// Design: rather than one branchy template, this file defines one
// template PER semantics (yes/no, quadratic voting, weighted), sharing the
// same binding convention:
//   - `semanticsId`/`semanticsVersion` are PUBLIC signals asserted equal to
//     the template's compile-time constants, so the verifier (on-chain)
//     can confirm which semantics + version it is checking a proof against
//     without having to trust the caller's label for it.
//   - a fixed-size batch of `n` ballot slots, each with an `active` flag so
//     a batch smaller than `n` is padded with inert (zero) slots.
//   - an additive nullifier accumulator (`nullifierRoot`), matching
//     `tally.circom`'s existing convention. "Additive" is a placeholder for
//     the SHA256 hash-chain the contract actually uses
//     (`Voting::accumulate_nullifier`); reconciling the two is tracked
//     below under "Still needed" rather than silently assumed compatible.
//
// Each semantics gets its own compiled circuit and therefore its own
// verification key - "VK pinned per semantics version" means exactly that:
// `set_semantics_vk(dao_id, semanticsId, semanticsVersion, vk)` on the
// voting contract stores one VK per (semanticsId, semanticsVersion), and a
// tally submitted for one semantics can never verify against another
// semantics' VK, which is how "a tally over mixed proof families without a
// compatible tuple is rejected" is actually enforced (see
// contracts/voting/src/lib.rs `submit_universal_tally`).
//
// Reference math for these three templates is mirrored exactly in
// `circuits/universal-tally-reference.js` (pure JS, no circom toolchain
// required) and exercised against labelled fixtures in
// `circuits/universal-tally.test.js` - that is the differential test the
// acceptance criteria asks for. The circuit sources below could not be
// compiled or witness-tested in this environment (no `circom` binary was
// available, see docs/recursive-proof-architecture.md and
// circuits/COMPILATION.md for the pinned-version install process); they
// are written to mirror the already-compiling `tally.circom` as closely as
// possible to minimize the risk of an uncompilable circuit, but that is
// not a substitute for actually running `circom --r1cs --wasm` against the
// pinned 2.1.8 toolchain before any VK is generated from them.

// ─── Semantics 0: Yes/No ─────────────────────────────────────────────────
// SEMANTICS_VERSION 1: initial universal-tally yes/no circuit.
template TallyYesNo(n, SEMANTICS_VERSION) {
    signal input semanticsId;
    signal input semanticsVersion;
    signal input nullifierRoot;
    signal input numActive;
    signal input yesCount;
    signal input noCount;

    signal input nullifiers[n];
    signal input active[n];
    signal input choice[n]; // 1 = yes, 0 = no (only meaningful where active[i] == 1)

    semanticsId === 0;
    semanticsVersion === SEMANTICS_VERSION;

    signal nullAcc[n + 1];
    signal activeAcc[n + 1];
    signal yesAcc[n + 1];
    nullAcc[0] <== 0;
    activeAcc[0] <== 0;
    yesAcc[0] <== 0;

    for (var i = 0; i < n; i++) {
        active[i] * (1 - active[i]) === 0;
        choice[i] * (1 - choice[i]) === 0;
        // Padding slots (active[i] == 0) must carry a zero nullifier so the
        // accumulator cannot be inflated with inert filler.
        (1 - active[i]) * nullifiers[i] === 0;

        nullAcc[i + 1] <== nullAcc[i] + nullifiers[i];
        activeAcc[i + 1] <== activeAcc[i] + active[i];
        // choice[i] is forced to 0 on padding slots by the constraint
        // below, so it never contributes to yesAcc there.
        (1 - active[i]) * choice[i] === 0;
        yesAcc[i + 1] <== yesAcc[i] + choice[i];
    }

    nullifierRoot === nullAcc[n];
    numActive === activeAcc[n];
    yesCount === yesAcc[n];
    noCount === numActive - yesCount;
}

// ─── Semantics 1: Quadratic Voting (QV) ─────────────────────────────────
// Each ballot's `creditsSpent[i]` is the already quadratic-cost-checked
// total for that ballot (see quadratic_vote.circom, which independently
// proves totalCreditsSpent == sum(voiceCredits_i^2) and range-checks every
// allocation); this circuit does not re-derive that - it only sums
// already-proven per-ballot totals under the nullifier accumulator, the
// same trust boundary `tally.circom` already uses for its two inputs.
// SEMANTICS_VERSION 1: initial universal-tally QV circuit.
template TallyQV(n, SEMANTICS_VERSION) {
    signal input semanticsId;
    signal input semanticsVersion;
    signal input nullifierRoot;
    signal input numActive;
    signal input totalCreditsSpent;

    signal input nullifiers[n];
    signal input active[n];
    signal input creditsSpent[n];

    semanticsId === 1;
    semanticsVersion === SEMANTICS_VERSION;

    signal nullAcc[n + 1];
    signal activeAcc[n + 1];
    signal creditsAcc[n + 1];
    nullAcc[0] <== 0;
    activeAcc[0] <== 0;
    creditsAcc[0] <== 0;

    for (var i = 0; i < n; i++) {
        active[i] * (1 - active[i]) === 0;
        (1 - active[i]) * nullifiers[i] === 0;
        (1 - active[i]) * creditsSpent[i] === 0;

        nullAcc[i + 1] <== nullAcc[i] + nullifiers[i];
        activeAcc[i + 1] <== activeAcc[i] + active[i];
        creditsAcc[i + 1] <== creditsAcc[i] + creditsSpent[i];
    }

    nullifierRoot === nullAcc[n];
    numActive === activeAcc[n];
    totalCreditsSpent === creditsAcc[n];
}

// ─── Semantics 2: Weighted Voting ───────────────────────────────────────
// Each ballot's `weight[i]` is the already balance/attestation-bound
// weight contribution (see weighted_vote.circom / sybil_weighted_vote.circom
// for how that weight is itself proven); same trust boundary as TallyQV.
// SEMANTICS_VERSION 1: initial universal-tally weighted circuit.
template TallyWeighted(n, SEMANTICS_VERSION) {
    signal input semanticsId;
    signal input semanticsVersion;
    signal input nullifierRoot;
    signal input numActive;
    signal input weightedTally;

    signal input nullifiers[n];
    signal input active[n];
    signal input weight[n];

    semanticsId === 2;
    semanticsVersion === SEMANTICS_VERSION;

    signal nullAcc[n + 1];
    signal activeAcc[n + 1];
    signal weightAcc[n + 1];
    nullAcc[0] <== 0;
    activeAcc[0] <== 0;
    weightAcc[0] <== 0;

    for (var i = 0; i < n; i++) {
        active[i] * (1 - active[i]) === 0;
        (1 - active[i]) * nullifiers[i] === 0;
        (1 - active[i]) * weight[i] === 0;

        nullAcc[i + 1] <== nullAcc[i] + nullifiers[i];
        activeAcc[i + 1] <== activeAcc[i] + active[i];
        weightAcc[i + 1] <== weightAcc[i] + weight[i];
    }

    nullifierRoot === nullAcc[n];
    numActive === activeAcc[n];
    weightedTally === weightAcc[n];
}

// Still needed before any of these are production artifacts (mirrors the
// honesty convention in docs/spikes/698-701-protocol-boundary-findings.md):
//   - Actual compilation against the pinned circom 2.1.8 toolchain and a
//     real witness-generation smoke test (not done here - no compiler
//     available in this environment).
//   - Reconciling the additive nullifier accumulator above with the
//     contract's SHA256 hash-chain accumulator (`accumulate_nullifier`) -
//     either the circuit must compute the same hash chain, or the contract
//     needs a parallel additive accumulator path for these semantics.
//   - A real trusted-setup ceremony per semantics/version and the
//     resulting VK, before `set_semantics_vk` is called with anything
//     other than a test key.
//   - Measured proving/verification cost per semantics (see
//     circuits/universal-tally.benchmark.js for the harness; it has not
//     been run here for the same reason).
