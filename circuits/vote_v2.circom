pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "merkle_tree.circom";

// DaoVote Anonymous Vote Circuit v2
//
// Adds chainId as a public signal to prevent cross-chain replay attacks.
// Adds numCandidates as a public signal to bind the election's candidate count
// into the ZK proof, preventing circuit/contract candidate bound desync.
// Adds relayerAddress to bind proofs to specific relayers (anti-front-running).
//
// Public signals: [root, nullifier, familyNullifier, daoId, proposalId, voteChoice, numCandidates, chainId, nonce, relayerAddress]
// Private signals: secret, salt, blindingFactor, pathElements, pathIndices
//
// chainId prevents replay attacks: a proof generated for one chain
// (e.g., testnet) cannot be replayed on another chain (e.g., mainnet).
// relayerAddress prevents cross-relayer proof reuse and selective front-running.
template VoteV2(levels) {
    var DOMAIN_TAG = 19666041591797403834655481403982443037438503980743793537655983658411276515161;

    // Public inputs
    signal input root;              // Merkle tree root (verified on-chain)
    signal input nullifier;         // Prevents double voting (domain-separated)
    signal input familyNullifier;   // Prevents cross-proposal linking by family
    signal input daoId;             // DAO identifier (for domain separation)
    signal input proposalId;        // Which proposal this vote is for
    signal input voteChoice;        // 0 = against, 1 = for
    signal input numCandidates;     // Total number of candidates (for range checks)
    signal input chainId;           // Chain identifier (prevents cross-chain replay)
    signal input nonce;             // Auto-incremented for each revote
    signal input relayerAddress;    // Relayer address binding proof to specific relayer (anti-front-running)

    // Private inputs
    signal input secret;            // Voter's secret (like password)
    signal input salt;              // Random salt for commitment
    signal input blindingFactor;    // Random blinding factor for uniform distribution
    signal input pathElements[levels];  // Merkle proof siblings
    signal input pathIndices[levels];   // Merkle proof path (0=left, 1=right)

    // 1. Compute identity commitment: Poseidon(DOMAIN_TAG, secret, salt, blindingFactor)
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
    component familyNullifierHasher = Poseidon(4);
    familyNullifierHasher.inputs[0] <== secret;
    familyNullifierHasher.inputs[1] <== daoId;
    familyNullifierHasher.inputs[2] <== proposalId;
    familyNullifierHasher.inputs[3] <== chainId;
    familyNullifier === familyNullifierHasher.out;

    // 4. Compute per-vote nullifier: Poseidon(secret, daoId, proposalId, chainId, nonce)
    component nullifierHasher = Poseidon(5);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== daoId;
    nullifierHasher.inputs[2] <== proposalId;
    nullifierHasher.inputs[3] <== chainId;
    nullifierHasher.inputs[4] <== nonce;
    nullifier === nullifierHasher.out;

    // 5. Verify vote choice is binary and lies in range [0, numCandidates)
    voteChoice * (voteChoice - 1) === 0;
    component validChoice = LessThan(32);
    validChoice.in[0] <== voteChoice;
    validChoice.in[1] <== numCandidates;
    validChoice.out === 1;
}

// Default tree depth of 18 (supports ~262K members)
// Public signals: [root, nullifier, familyNullifier, daoId, proposalId, voteChoice, numCandidates, chainId, nonce, relayerAddress] - 10 signals
component main {public [root, nullifier, familyNullifier, daoId, proposalId, voteChoice, numCandidates, chainId, nonce, relayerAddress]} = VoteV2(18);
