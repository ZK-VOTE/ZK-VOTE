pragma circom 2.0.0;

// GENERATED FILE - do not edit.
// Regenerate with: node utils/gen_depth_circuits.js
//
// Merkle depth 10: supports up to 2^10 = 1,024 members.
//
// Identical to vote.circom except for the tree depth. Proving cost is dominated
// by the 10 Poseidon hashes of the Merkle path, so a smaller depth means a
// proportionally cheaper proof for a smaller electorate.
//
// Public signals: [root, nullifier, daoId, proposalId, voteChoice, numCandidates] - 6 signals
// MUST stay in lockstep with NUM_PUBLIC_SIGNALS in
// contracts/voting/src/lib.rs; scripts/drift-guard.mjs fails the build
// otherwise. See vote_template.circom for why there is no 7th relayer signal.
// The commitment stays private; it is recomputed inside the circuit.

include "vote_template.circom";

component main {public [root, nullifier, daoId, proposalId, voteChoice, numCandidates]} = Vote(10);
