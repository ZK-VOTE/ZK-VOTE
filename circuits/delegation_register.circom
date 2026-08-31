pragma circom 2.0.0;

include "delegation.circom";

// Delegation registration entry point (issue #304).
//
// Public signals (order must match the contract's `pub_signals` vector):
//   [root, voteNullifier, delegationCommitment, daoId, proposalId, delegateTag]
//
// Tree depth 18, matching vote.circom (~262K members).
component main {public [
    root,
    voteNullifier,
    delegationCommitment,
    daoId,
    proposalId,
    delegateTag
]} = DelegationRegistration(18);
