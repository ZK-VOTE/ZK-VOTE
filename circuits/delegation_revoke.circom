pragma circom 2.0.0;

include "delegation.circom";

// Delegation revocation entry point (issue #304).
//
// Public signals (order must match the contract's `pub_signals` vector):
//   [delegationCommitment, reclaimNullifier, daoId, proposalId]
//
// No Merkle proof: the contract already knows the delegation commitment is
// registered (it stores it), so revocation only has to prove the caller can
// open it and knows the identity secret behind it.
component main {public [
    delegationCommitment,
    reclaimNullifier,
    daoId,
    proposalId
]} = DelegationRevocation();
