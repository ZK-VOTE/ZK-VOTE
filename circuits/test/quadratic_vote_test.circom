pragma circom 2.0.0;

include "../quadratic_vote.circom";

// Small test instantiation used by circuits/quadratic.test.js.
//
// Matches the scenario in the issue: 3 proposals, a budget of 10 credits and a
// per-allocation range of 0..5. Uses a shallow tree (depth 4) so the circuit
// compiles quickly under Jest.
//
//   levels=4, N=3, CREDIT_BITS=4 (0..15), MAX_CREDITS=5, BUDGET_BITS=8, MAX_BUDGET=10
component main {public [root, daoId, proposalId, nullifier, totalCreditsSpent, allocationsHash]} =
    QuadraticVote(4, 3, 4, 5, 8, 10);
