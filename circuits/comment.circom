pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "merkle_tree.circom";

// DaoVote Anonymous Comment Circuit
//
// Proves:
// 1. Commenter knows secret & salt that hash to a leaf in the Merkle tree
// 2. Nullifier is correctly derived from secret, daoId, proposalId, and commentNonce
// 3. Commitment matches Poseidon(secret, salt)
//
// Public signals: [root, nullifier, daoId, proposalId, commentNonce, commitment]
// Private signals: secret, salt, pathElements, pathIndices
//
// NOTE: Unlike votes, comments don't have a "choice" field.
// The commentNonce allows multiple comments per user per proposal (increment nonce for each).
// Users track their own nonce locally.
template Comment(levels) {
    // Public inputs
    signal input root;              // Merkle tree root (verified on-chain)
    signal input nullifier;         // Prevents duplicate comments with same nonce
    signal input daoId;             // DAO identifier (for domain separation)
    signal input proposalId;        // Which proposal this comment is for
    signal input commentNonce;      // Nonce for multiple comments (0, 1, 2, ...)
    signal input commitment;        // Identity commitment (allows revocation checks)

    // Private inputs
    signal input secret;            // Commenter's secret (like password)
    signal input salt;              // Random salt for commitment
    signal input pathElements[levels];  // Merkle proof siblings
    signal input pathIndices[levels];   // Merkle proof path (0=left, 1=right)

    // 1. Compute identity commitment: Poseidon(secret, salt)
    // and verify it matches the public commitment input
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== secret;
    commitmentHasher.inputs[1] <== salt;

    // Constrain computed commitment to match public commitment
    commitment === commitmentHasher.out;

    // 2. Verify Merkle tree inclusion
    component merkleProof = MerkleTreeInclusionProof(levels);
    merkleProof.leaf <== commitment;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }

    // Constrain computed root to match public root
    root === merkleProof.root;

    // 3. Compute nullifier: Poseidon(secret, daoId, proposalId, commentNonce)
    // Domain separation: includes daoId to prevent cross-DAO nullifier linkability
    // The commentNonce allows multiple comments per proposal from the same user
    component nullifierHasher = Poseidon(4);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== daoId;
    nullifierHasher.inputs[2] <== proposalId;
    nullifierHasher.inputs[3] <== commentNonce;

    // Constrain computed nullifier to match public nullifier
    nullifier === nullifierHasher.out;

    // No vote choice constraint - comments don't have a choice
}

// Default tree depth of 18 (supports ~262K members)
component main {public [root, nullifier, daoId, proposalId, commentNonce, commitment]} = Comment(18);
