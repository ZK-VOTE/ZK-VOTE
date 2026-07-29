pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "merkle_tree.circom";
include "range_proof.circom";

// DaoVote ZK Quadratic Voting Circuit
//
// A single proof lets an eligible member allocate `voiceCredits` across N
// proposals under a quadratic cost function while keeping the individual
// allocations private.
//
// Proves, in one proof:
//   1. Membership   - Poseidon(secret, salt) is a leaf under the Merkle root.
//   2. Nullifier    - Poseidon(secret, daoId, proposalId), domain-separated so
//                     a member casts at most one quadratic ballot per round.
//   3. Cost         - totalCreditsSpent == sum(voiceCredits_i ^ 2)  (the
//                     quadratic cost of the ballot).
//   4. Commitment   - allocationsHash == Poseidon(vc_0, pid_0, vc_1, pid_1, ...)
//                     binds the (hidden) per-proposal allocations so they can be
//                     revealed and tallied later without being changed.
//   5. Range        - every voiceCredits_i is in [0, MAX_CREDITS] via a
//                     bit-decomposition range proof (makes overspend on a single
//                     allocation impossible).
//   6. Budget       - totalCreditsSpent <= MAX_BUDGET (members have a fixed
//                     credit budget per snapshot; makes overspend impossible).
//
// Public signals : [root, daoId, proposalId, nullifier, totalCreditsSpent, allocationsHash]
// Private signals: secret, salt, pathElements, pathIndices, voiceCredits, allocProposalIds
//
// PRIVACY: individual allocations (voiceCredits_i, allocProposalIds_i) are never
// revealed by the proof - only their quadratic total and the binding hash are
// public. This is a template library (no `main`); see quadratic_vote_main.circom
// for the production instantiation and circuits/test/ for the test wiring.
//
//   levels      : Merkle tree depth
//   N           : number of proposals a ballot may allocate across
//   CREDIT_BITS : bit-width of each per-allocation range proof (2^CREDIT_BITS > MAX_CREDITS)
//   MAX_CREDITS : inclusive per-allocation cap on voice credits
//   BUDGET_BITS : bit-width of the budget comparison (2^BUDGET_BITS > N*MAX_CREDITS^2)
//   MAX_BUDGET  : inclusive cap on sum(voiceCredits_i ^ 2)
template QuadraticVote(levels, N, CREDIT_BITS, MAX_CREDITS, BUDGET_BITS, MAX_BUDGET) {
    // Public inputs
    signal input root;
    signal input daoId;
    signal input proposalId;
    signal input nullifier;
    signal input totalCreditsSpent;
    signal input allocationsHash;

    // Private inputs
    signal input secret;
    signal input salt;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal input voiceCredits[N];
    signal input allocProposalIds[N];

    // 1. Identity commitment = Poseidon(secret, salt), verified against the root.
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== secret;
    commitmentHasher.inputs[1] <== salt;

    signal commitment;
    commitment <== commitmentHasher.out;

    component merkleProof = MerkleTreeInclusionProof(levels);
    merkleProof.leaf <== commitment;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    root === merkleProof.root;

    // 2. Nullifier = Poseidon(secret, daoId, proposalId) - one ballot per round,
    //    domain-separated by daoId to prevent cross-DAO linkability.
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== daoId;
    nullifierHasher.inputs[2] <== proposalId;
    nullifier === nullifierHasher.out;

    // 3 + 5. Range-check each allocation and accumulate the quadratic cost.
    component rp[N];
    signal squares[N];
    signal partialSum[N + 1];
    partialSum[0] <== 0;
    for (var i = 0; i < N; i++) {
        rp[i] = RangeProof(CREDIT_BITS);
        rp[i].in <== voiceCredits[i];
        rp[i].maxValue <== MAX_CREDITS;

        squares[i] <== voiceCredits[i] * voiceCredits[i];
        partialSum[i + 1] <== partialSum[i] + squares[i];
    }

    // 4. Reveal the quadratic cost; keep allocations hidden.
    totalCreditsSpent === partialSum[N];

    // Binding commitment to the (hidden) allocations for later reveal/tally:
    // allocationsHash = Poseidon(vc_0, pid_0, vc_1, pid_1, ...).
    component allocHasher = Poseidon(2 * N);
    for (var i = 0; i < N; i++) {
        allocHasher.inputs[2 * i] <== voiceCredits[i];
        allocHasher.inputs[2 * i + 1] <== allocProposalIds[i];
    }
    allocationsHash === allocHasher.out;

    // 6. Budget: totalCreditsSpent <= MAX_BUDGET. Because every square is bounded
    //    by the range proofs, partialSum[N] < 2^BUDGET_BITS, so this is exact.
    component budgetCheck = LessEqThan(BUDGET_BITS);
    budgetCheck.in[0] <== totalCreditsSpent;
    budgetCheck.in[1] <== MAX_BUDGET;
    budgetCheck.out === 1;
}
