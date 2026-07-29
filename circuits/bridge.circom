pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "merkle_tree.circom";

// DAO domain separation tag for commitment scheme
// SHA-256("ZK-VOTE-COMMITMENT") reduced mod BN254 scalar field
// Prevents cross-protocol attacks where commitments from other systems
// could be valid in ZK-VOTE
var DOMAIN_TAG = 19666041591797403834655481403982443037438503980743793537655983658411276515161;

// BridgeVote Circuit
//
// Proves cross-chain SBT membership for voting from Ethereum.
//
// Flow:
// 1. Relayer watches Soroban chain, builds an SBT state tree,
//    posts sbtRoot to EVM bridge contract.
// 2. User generates this proof: proves they have an active SBT
//    (inclusion in SBT state tree) AND a voting commitment
//    (inclusion in voting Merkle tree).
// 3. EVM bridge contract verifies the Groth16 proof, emits
//    VoteForwarded event.
// 4. Soroban relay watches for VoteForwarded, records the vote.
//
// Public signals: [sbtContractAddr, memberAddr, daoId, proposalId,
//                  nullifier, voteChoice, voteRoot, sbtRoot]
// Private signals: secret, salt, blindingFactor, votingPathElements, votingPathIndices,
//                  sbtPathElements, sbtPathIndices, sbtLeaf
//
// Security:
// - nullifier domain-separates by (secret, daoId, proposalId)
// - voteChoice constrained to {0,1}
// - SBT leaf = Poseidon(sbtContractAddr, memberAddr, daoId, 1)
//   where 1 = isActive (unrevoked)
// - sbtRoot is posted by relayer; circuit verifies inclusion
template BridgeVote(levels) {
    // === Public inputs ===
    signal input sbtContractAddr;   // Soroban SBT contract address (U256)
    signal input memberAddr;        // Stellar address of the member (U256)
    signal input daoId;             // DAO identifier (U256)
    signal input proposalId;        // Proposal identifier (U256)
    signal input nullifier;         // Prevents double voting (U256)
    signal input voteChoice;        // 0 = against, 1 = for (U256)
    signal input voteRoot;          // Merkle root of voting tree (U256)
    signal input sbtRoot;           // Merkle root of SBT state tree (U256)

    // === Private inputs ===
    signal input secret;                    // Voter's secret
    signal input salt;                      // Salt for commitment
    signal input blindingFactor;            // Random blinding factor for uniform distribution
    signal input votingPathElements[levels]; // Voting Merkle proof siblings
    signal input votingPathIndices[levels];  // Voting Merkle proof path (0=left, 1=right)
    signal input sbtPathElements[levels];    // SBT state Merkle proof siblings
    signal input sbtPathIndices[levels];     // SBT state Merkle proof path
    signal input sbtLeaf;                   // SBT state leaf data

    // ============================================
    // 1. Compute identity commitment: Poseidon(DOMAIN_TAG, secret, salt, blindingFactor)
    //    Domain-separated commitment prevents cross-protocol attacks.
    //    Blinding factor ensures uniform distribution across the field.
    //    This is the leaf in the voting Merkle tree
    // ============================================
    component commitmentHasher = Poseidon(4);
    commitmentHasher.inputs[0] <== DOMAIN_TAG;
    commitmentHasher.inputs[1] <== secret;
    commitmentHasher.inputs[2] <== salt;
    commitmentHasher.inputs[3] <== blindingFactor;

    signal commitment;
    commitment <== commitmentHasher.out;

    // ============================================
    // 2. Verify voting Merkle tree inclusion
    //    Proves the commitment is in the voting tree
    // ============================================
    component votingProof = MerkleTreeInclusionProof(levels);
    votingProof.leaf <== commitment;
    for (var i = 0; i < levels; i++) {
        votingProof.pathElements[i] <== votingPathElements[i];
        votingProof.pathIndices[i] <== votingPathIndices[i];
    }

    // Constrain computed root to match public voteRoot
    voteRoot === votingProof.root;

    // ============================================
    // 3. Compute nullifier: Poseidon(secret, daoId, proposalId)
    //    Domain separation prevents cross-DAO linkability
    // ============================================
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== daoId;
    nullifierHasher.inputs[2] <== proposalId;

    // Constrain computed nullifier to match public nullifier
    nullifier === nullifierHasher.out;

    // ============================================
    // 4. Verify vote choice is binary (0 or 1)
    // ============================================
    voteChoice * (voteChoice - 1) === 0;

    // ============================================
    // 5. Verify SBT state inclusion
    //    Proves the member has an active SBT in the SBT state tree
    //    rooted at sbtRoot (posted by relayer to EVM bridge contract)
    // ============================================
    component sbtProof = MerkleTreeInclusionProof(levels);
    sbtProof.leaf <== sbtLeaf;
    for (var i = 0; i < levels; i++) {
        sbtProof.pathElements[i] <== sbtPathElements[i];
        sbtProof.pathIndices[i] <== sbtPathIndices[i];
    }

    // Constrain computed root to match public sbtRoot
    sbtRoot === sbtProof.root;

    // ============================================
    // 6. Verify SBT leaf structure
    //    sbtLeaf = Poseidon(sbtContractAddr, memberAddr, daoId, isActive)
    //    where isActive = 1 (unrevoked)
    //
    //    This ensures:
    //    - The leaf is for the correct SBT contract
    //    - The leaf is for the correct member
    //    - The leaf is for the correct DAO
    //    - The member's SBT is active (not revoked)
    // ============================================
    component sbtLeafHasher = Poseidon(4);
    sbtLeafHasher.inputs[0] <== sbtContractAddr;
    sbtLeafHasher.inputs[1] <== memberAddr;
    sbtLeafHasher.inputs[2] <== daoId;
    sbtLeafHasher.inputs[3] <== 1; // isActive = 1 (unrevoked)

    // Constrain computed leaf to match provided leaf
    sbtLeafHasher.out === sbtLeaf;
}

// Default tree depth of 18 (supports ~262K members)
// Public signals: [sbtContractAddr, memberAddr, daoId, proposalId,
//                  nullifier, voteChoice, voteRoot, sbtRoot] - 8 signals
component main {public [sbtContractAddr, memberAddr, daoId, proposalId,
                        nullifier, voteChoice, voteRoot, sbtRoot]} = BridgeVote(18);
