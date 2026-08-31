pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "merkle_tree.circom";

// Commit-Phase Eligibility Proof (issue #302)
//
// The proof accompanying `commit_vote`. It is exactly `vote.circom` with the
// choice removed: membership in the eligible set, and correct derivation of the
// nullifier being spent — nothing about *how* the member is voting.
//
// ## Why a proof is required at all to commit
//
// Committing spends the member's nullifier. If anyone could commit under any
// nullifier, an attacker would grief the election by spending every voter's
// nullifier with a commitment they cannot open — the votes would be
// permanently lost and the tally would never move. Requiring the same
// membership proof `vote` requires makes the commit exactly as authorised as
// the vote it replaces.
//
// ## Why the choice is not in this circuit
//
// The choice is bound by the commitment itself, which the contract verifies
// directly at reveal:
//
//     commitment = SHA256(domain ‖ daoId ‖ proposalId ‖ nullifier ‖ choice ‖ blinding)
//
// SHA-256 is collision-resistant, so the committed choice cannot be changed;
// the 32-byte blinding factor is what hides it. Proving that relation in-circuit
// would mean a SHA-256 gadget (tens of thousands of constraints) to establish
// a property the contract can check natively with one host-function call. The
// nullifier is inside the preimage so a commitment cannot be lifted from one
// voter's slot into another's.
//
// Public signals: [root, nullifier, daoId, proposalId]
// Private: secret, salt, blindingFactor, pathElements, pathIndices
template VoteCommit(levels) {
    // Identical to vote.circom, so an existing member's leaf works unchanged.
    var DOMAIN_TAG = 19666041591797403834655481403982443037438503980743793537655983658411276515161;

    signal input root;
    signal input nullifier;
    signal input daoId;
    signal input proposalId;

    signal input secret;
    signal input salt;
    signal input blindingFactor;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // 1. Identity commitment.
    component commitmentHasher = Poseidon(4);
    commitmentHasher.inputs[0] <== DOMAIN_TAG;
    commitmentHasher.inputs[1] <== secret;
    commitmentHasher.inputs[2] <== salt;
    commitmentHasher.inputs[3] <== blindingFactor;

    signal commitment;
    commitment <== commitmentHasher.out;

    // 2. Merkle membership under the election's eligible root.
    component merkleProof = MerkleTreeInclusionProof(levels);
    merkleProof.leaf <== commitment;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }
    root === merkleProof.root;

    // 3. Nullifier — the same derivation `vote.circom` uses, so committing and
    //    voting directly draw on one namespace and a member gets one or the
    //    other, never both.
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== daoId;
    nullifierHasher.inputs[2] <== proposalId;
    nullifier === nullifierHasher.out;
}

// Tree depth 18, matching vote.circom.
component main {public [root, nullifier, daoId, proposalId]} = VoteCommit(18);
