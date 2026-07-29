pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "merkle_tree.circom";

// DAO domain separation tag for commitment scheme
// SHA-256("ZK-VOTE-COMMITMENT") reduced mod BN254 scalar field
// Prevents cross-protocol attacks where commitments from other systems
// could be valid in ZK-VOTE
var DOMAIN_TAG = 19666041591797403834655481403982443037438503980743793537655983658411276515161;

// DaoVote Anonymous Vote Circuit v2
//
// Adds chainId as a public signal to prevent cross-chain replay attacks.
// Adds numCandidates as a public signal to bind the election's candidate count
// into the ZK proof, preventing circuit/contract candidate bound desync.
//
// Public signals: [root, nullifier, familyNullifier, daoId, proposalId, voteChoice, numCandidates, chainId, nonce]
// Private signals: secret, salt, blindingFactor, pathElements, pathIndices
//
// chainId prevents replay attacks: a proof generated for one chain
// (e.g., testnet) cannot be replayed on another chain (e.g., mainnet).
template VoteV2(levels) {
    // Public inputs
    signal input root;              // Merkle tree root (verified on-chain)
    signal input nullifier;         // Unique per vote attempt
    signal input familyNullifier;   // Links revotes of the same voter without revealing identity
    signal input daoId;             // DAO identifier (for domain separation)
    signal input proposalId;        // Which proposal this vote is for
    signal input voteChoice;        // Candidate index the voter selected
    signal input numCandidates;     // Total number of candidates (set by election config)
    signal input chainId;           // Chain identifier (prevents cross-chain replay)
    signal input nonce;             // Auto-incremented for each revote

    // Private inputs
    signal input secret;            // Voter's secret (like password)
    signal input salt;              // Salt for commitment
    signal input blindingFactor;    // Random blinding factor for uniform distribution
    signal input pathElements[levels];  // Merkle proof siblings
    signal input pathIndices[levels];   // Merkle proof path (0=left, 1=right)

    // 1. Compute identity commitment: Poseidon(DOMAIN_TAG, secret, salt, blindingFactor)
    // Domain-separated commitment prevents cross-protocol attacks.
    // Blinding factor ensures uniform distribution across the field even
    // if secret and salt are correlated (e.g., derived from same wallet signature).
    component commitmentHasher = Poseidon(4);
    commitmentHasher.inputs[0] <== DOMAIN_TAG;
    commitmentHasher.inputs[1] <== secret;
    commitmentHasher.inputs[2] <== salt;
    commitmentHasher.inputs[3] <== blindingFactor;

    signal commitment;
    commitment <== commitmentHasher.out;

    // 2. Verify Merkle tree inclusion
    component merkleProof = MerkleTreeInclusionProof(levels);
    merkleProof.leaf <== commitment;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }

    root === merkleProof.root;

    // 3. Compute family nullifier: Poseidon(secret, daoId, proposalId, chainId)
    // Links revotes together for the same proposal, preventing duplicate tallies.
    component familyHasher = Poseidon(4);
    familyHasher.inputs[0] <== secret;
    familyHasher.inputs[1] <== daoId;
    familyHasher.inputs[2] <== proposalId;
    familyHasher.inputs[3] <== chainId;

    familyNullifier === familyHasher.out;

    // 4. Compute nullifier: Poseidon(secret, daoId, proposalId, chainId, nonce)
    // Unique nullifier for each vote attempt
    component nullifierHasher = Poseidon(5);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== daoId;
    nullifierHasher.inputs[2] <== proposalId;
    nullifierHasher.inputs[3] <== chainId;
    nullifierHasher.inputs[4] <== nonce;

    nullifier === nullifierHasher.out;

    // 4. Verify candidate index is within bounds: voteChoice < numCandidates
    // Uses 32-bit LessThan comparator from circomlib.
    // This prevents a voter from proving a vote for a non-existent candidate.
    component validChoice = LessThan(32);
    validChoice.in[0] <== voteChoice;
    validChoice.in[1] <== numCandidates;
    validChoice.out === 1;
}

// Default tree depth of 18 (supports ~262K members)
// Public signals: [root, nullifier, familyNullifier, daoId, proposalId, voteChoice, numCandidates, chainId, nonce] - 9 signals
component main {public [root, nullifier, familyNullifier, daoId, proposalId, voteChoice, numCandidates, chainId, nonce]} = VoteV2(18);
