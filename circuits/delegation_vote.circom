pragma circom 2.0.0;

include "delegation.circom";

// Vote-on-behalf entry point (issue #304).
//
// Public signals (order must match the contract's `pub_signals` vector):
//   [delegationRoot, delegationNullifier, daoId, proposalId, voteChoice, numCandidates]
//
// Tree depth 18: the delegation tree is sized like the membership tree, since
// in the limit every member delegates.
component main {public [
    delegationRoot,
    delegationNullifier,
    daoId,
    proposalId,
    voteChoice,
    numCandidates
]} = VoteOnBehalf(18);
