pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "merkle_tree.circom";

// Exclusion Proof Circuit
//
// Proves that a commitment has been revoked and is no longer in the membership tree.
// Used to enforce that revoked members cannot vote in future proposals.
//
// Proves:
// 1. A leaf index corresponds to a specific membership commitment (Poseidon hash)
// 2. The commitment was in a valid historical root
// 3. The commitment was zeroed out (revoked) in the current tree
//
// Public signals: [historicalRoot, currentRoot, daoId, leafIndex, commitment]
// Private signals: pathElements, pathIndices (for both historical and current proofs)

template ExclusionProof(levels) {
    var DOMAIN_TAG = 19666041591797403834655481403982443037438503980743793537655983658411276515161;

    // Public inputs
    signal input historicalRoot;      // Merkle root when member was active
    signal input currentRoot;         // Current tree root (should not contain member)
    signal input daoId;               // DAO identifier (for domain separation)
    signal input leafIndex;           // Index in tree (public for efficiency)
    signal input commitment;          // Member's identity commitment

    // Private inputs
    signal input historicalPathElements[levels];  // Merkle path in historical tree
    signal input historicalPathIndices[levels];   // Merkle path bits for historical
    signal input currentPathElements[levels];     // Merkle path in current tree
    signal input currentPathIndices[levels];      // Merkle path bits for current
    signal input secret;              // Voter's secret (for commitment reconstruction)
    signal input salt;                // Salt for commitment
    signal input blindingFactor;      // Blinding factor

    // 1. Reconstruct commitment from secret components
    signal reconstructedCommitment;
    component commitmentHasher = Poseidon(4);
    commitmentHasher.inputs[0] <== DOMAIN_TAG;
    commitmentHasher.inputs[1] <== secret;
    commitmentHasher.inputs[2] <== salt;
    commitmentHasher.inputs[3] <== blindingFactor;
    reconstructedCommitment <== commitmentHasher.out;

    // Verify reconstruction matches public commitment input
    commitment === reconstructedCommitment;

    // 2. Verify historical proof: commitment was in historicalRoot at leafIndex
    component historicalProof = MerkleProofV(levels);
    historicalProof.leaf <== commitment;
    historicalProof.leafIndex <== leafIndex;
    for (var i = 0; i < levels; i++) {
        historicalProof.pathElements[i] <== historicalPathElements[i];
        historicalProof.pathIndices[i] <== historicalPathIndices[i];
    }
    historicalRoot === historicalProof.root;

    // 3. Verify current proof: leaf at leafIndex is ZERO (revoked) in currentRoot
    // The zero leaf represents a revoked/removed member
    signal zeroLeaf <== 0;
    component currentProof = MerkleProofV(levels);
    currentProof.leaf <== zeroLeaf;
    currentProof.leafIndex <== leafIndex;
    for (var i = 0; i < levels; i++) {
        currentProof.pathElements[i] <== currentPathElements[i];
        currentProof.pathIndices[i] <== currentPathIndices[i];
    }
    currentRoot === currentProof.root;

    // Constraint: We now know this member is revoked
    // - The commitment was valid in historicalRoot
    // - The same leaf index contains zero in currentRoot
    // - Therefore, this member has been revoked
}

// Helper template to verify a Merkle proof
// Accounts for leaf hashing (domain-separating leaf nodes from internal nodes)
template MerkleProofV(levels) {
    signal input leaf;
    signal input leafIndex;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    var LEAF_DOMAIN_TAG = 21888242871839275222246405745257275088548364400416034343698204186575808495616;

    component leafHasher = Poseidon(2);
    leafHasher.inputs[0] <== LEAF_DOMAIN_TAG;
    leafHasher.inputs[1] <== leaf;

    signal currentHash[levels + 1];
    currentHash[0] <== leafHasher.out;

    component hashers[levels];
    for (var i = 0; i < levels; i++) {
        hashers[i] = Poseidon(2);

        if (pathIndices[i] == 0) {
            hashers[i].inputs[0] <== currentHash[i];
            hashers[i].inputs[1] <== pathElements[i];
        } else {
            hashers[i].inputs[0] <== pathElements[i];
            hashers[i].inputs[1] <== currentHash[i];
        }

        currentHash[i + 1] <== hashers[i].out;
    }

    root <== currentHash[levels];
}

// ---------------------------------------------------------------------------
// Compiled entry points for each supported depth (ZV-051 / #899).
//
// Previously this file had no `component main`, so circom produced no R1CS or
// WASM and there was no verification key to register. Each `component main`
// below produces a separate compiled circuit for its depth. The build script
// (circuits/compile.sh) already iterates over SUPPORTED_DEPTHS; adding these
// entry points is the missing half of that convention for the exclusion circuit.
//
// The default depth (18) is the production default and is what the relayer
// uses when no explicit merkle_depth is passed. The other depths mirror the
// generated vote-circuit wrappers in circuits/vote_d*.circom.
// ---------------------------------------------------------------------------
component main { public [historicalRoot, currentRoot, daoId, leafIndex, commitment] } = ExclusionProof(18);
