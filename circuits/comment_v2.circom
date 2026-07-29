pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "merkle_tree.circom";

// DAO domain separation tag for commitment scheme
// SHA-256("ZK-VOTE-COMMITMENT") reduced mod BN254 scalar field
// Prevents cross-protocol attacks where commitments from other systems
// could be valid in ZK-VOTE
var DOMAIN_TAG = 19666041591797403834655481403982443037438503980743793537655983658411276515161;

// DaoVote Anonymous Comment Circuit v2
//
// Adds parentCommentId as a public signal for proper threading support.
// Upgraded from v1 which had 6 public signals.
//
// Public signals: [root, nullifier, daoId, proposalId, commentNonce, commitment, parentCommentId]
// Private signals: secret, salt, blindingFactor, pathElements, pathIndices
//
// parentCommentId enables reply threading: comments can reference a parent
// comment for nested discussion. 0 = top-level comment.
template CommentV2(levels) {
    // Public inputs
    signal input root;              // Merkle tree root (verified on-chain)
    signal input nullifier;         // Prevents duplicate comments with same nonce
    signal input daoId;             // DAO identifier (for domain separation)
    signal input proposalId;        // Which proposal this comment is for
    signal input commentNonce;      // Nonce for multiple comments (0, 1, 2, ...)
    signal input commitment;        // Identity commitment (allows revocation checks)
    signal input parentCommentId;   // Parent comment for threading (0 = top-level)

    // Private inputs
    signal input secret;            // Commenter's secret (like password)
    signal input salt;              // Salt for commitment
    signal input blindingFactor;    // Random blinding factor for uniform distribution
    signal input pathElements[levels];  // Merkle proof siblings
    signal input pathIndices[levels];   // Merkle proof path (0=left, 1=right)

    // 1. Compute identity commitment: Poseidon(DOMAIN_TAG, secret, salt, blindingFactor)
    // and verify it matches the public commitment input
    // Domain-separated commitment prevents cross-protocol attacks.
    // Blinding factor ensures uniform distribution across the field.
    component commitmentHasher = Poseidon(4);
    commitmentHasher.inputs[0] <== DOMAIN_TAG;
    commitmentHasher.inputs[1] <== secret;
    commitmentHasher.inputs[2] <== salt;
    commitmentHasher.inputs[3] <== blindingFactor;

    commitment === commitmentHasher.out;

    // 2. Verify Merkle tree inclusion
    component merkleProof = MerkleTreeInclusionProof(levels);
    merkleProof.leaf <== commitment;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }

    root === merkleProof.root;

    // 3. Compute nullifier: Poseidon(secret, daoId, proposalId, commentNonce)
    component nullifierHasher = Poseidon(4);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== daoId;
    nullifierHasher.inputs[2] <== proposalId;
    nullifierHasher.inputs[3] <== commentNonce;

    nullifier === nullifierHasher.out;
}

// Default tree depth of 18 (supports ~262K members)
// Public signals: [root, nullifier, daoId, proposalId, commentNonce, commitment, parentCommentId] - 7 signals
component main {public [root, nullifier, daoId, proposalId, commentNonce, commitment, parentCommentId]} = CommentV2(18);
