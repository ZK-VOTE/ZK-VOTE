pragma circom 2.0.0;

include "quadratic_vote.circom";

// Production instantiation of the ZK Quadratic Voting circuit.
//
//   levels      = 18   -> tree depth 18 (~262K members, matches vote.circom)
//   N           = 5    -> up to 5 proposals allocated per ballot
//   CREDIT_BITS = 4    -> per-allocation range proof over 4 bits (0..15)
//   MAX_CREDITS = 10   -> inclusive per-allocation cap
//   BUDGET_BITS = 16   -> budget comparison over 16 bits (max sum-of-squares
//                         5 * 10^2 = 500 < 65536)
//   MAX_BUDGET  = 100  -> fixed quadratic credit budget per snapshot
//
// Public signals: [root, daoId, proposalId, nullifier, totalCreditsSpent, allocationsHash]
component main {public [root, daoId, proposalId, nullifier, totalCreditsSpent, allocationsHash]} =
    QuadraticVote(18, 5, 4, 10, 16, 100);
