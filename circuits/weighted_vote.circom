pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "range_proof.circom";
include "sybil_weight.circom";

// Weighted Vote Balance Proof
//
// For weighted (token-balance-based) voting, a voter must prove their vote
// weight equals their token balance, and that the balance is a valid
// (bounded) value, without revealing the balance itself.
//
// This circuit proves, in zero knowledge:
//   1. `balance` is committed to by the public `balanceCommitment` signal:
//      balanceCommitment == Poseidon(balance, blindingFactor)
//      (the same Poseidon-commitment convention already used for identity
//      commitments in vote.circom / comment.circom, so the balance
//      commitment can be checked against an on-chain-anchored value using
//      the exact hash primitive already deployed on Soroban.)
//   2. `0 <= balance <= maxSupply` via bit-decomposition range proof
//      (RangeProof, see range_proof.circom).
//   3. `voteWeight == balance` -- the vote is weighted by the committed
//      balance, not an arbitrary voter-supplied number.
//
// Public signals: [balanceCommitment, maxSupply, voteWeight]
// Private signals: balance, blindingFactor
//
// SCOPE NOTE: this circuit proves the *balance range + weight-binding*
// property described in the issue. It intentionally does not implement the
// separate on-chain balance-commitment Merkle tree, the contract-side
// weighted-vote verification entry point, or tally accumulation -- those
// are Soroban-contract-side changes with their own storage/migration
// surface and are out of scope for this change (see PR description).
// `balanceCommitment` here is designed to be checked by the caller against
// whatever on-chain commitment source is used (e.g. a balance snapshot
// commitment stored per the token-gating design in zk-voting-protocol.md).
template WeightedVoteBalanceProof(BITS) {
    // Public inputs
    signal input balanceCommitment; // Poseidon(balance, blindingFactor), checked against on-chain state by the caller
    signal input maxSupply;         // Inclusive upper bound for balance (e.g. token total supply)
    signal input voteWeight;        // Weight the vote is cast with; must equal balance

    // Private inputs
    signal input balance;           // Voter's token balance (private)
    signal input blindingFactor;    // Blinding factor for the balance commitment

    // 1. Balance commitment check
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== balance;
    commitmentHasher.inputs[1] <== blindingFactor;
    balanceCommitment === commitmentHasher.out;

    // 2. Range proof: 0 <= balance <= maxSupply
    component range = RangeProof(BITS);
    range.in <== balance;
    range.maxValue <== maxSupply;

    // 3. Weight binding: vote is weighted exactly by the committed balance
    voteWeight === balance;
}


// The Sybil-resistance weight curve (issue #301) lives in `sybil_weight.circom`
// rather than inline here, because this file declares a `component main` and a
// circuit that wants the curve (`sybil_weighted_vote.circom`) cannot include a
// file that already has one. `SybilWeightCurve` and `AgeInDays` are therefore
// importable from both.

// 128-bit balance range, matching the issue's "128 bits -> 128 constraints"
// binary decomposition sizing for token balances.
component main {public [balanceCommitment, maxSupply, voteWeight]} = WeightedVoteBalanceProof(128);
