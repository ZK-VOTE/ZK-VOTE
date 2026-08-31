pragma circom 2.0.0;

// GENERATED FILE - do not edit.
// Regenerate with: node utils/gen_depth_circuits.js
//
// Merkle depth 20: supports up to 2^20 = 1,048,576 members.
//
// Identical to vote.circom except for the tree depth. Proving cost is dominated
// by the 20 Poseidon hashes of the Merkle path, so a smaller depth means a
// proportionally cheaper proof for a smaller electorate.
//
// Public signals: [root, nullifier, daoId, proposalId, voteChoice, numCandidates, relayerAddress] - 7 signals
// The commitment stays private; it is recomputed inside the circuit.

include "vote_template.circom";

component main {public [root, nullifier, daoId, proposalId, voteChoice, numCandidates, relayerAddress]} = Vote(20);
