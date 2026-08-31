pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";

// Merkle tree inclusion proof using Poseidon hash
// Compatible with Stellar P25 on-chain Poseidon (BN254)
//
// DOMAIN SEPARATION (#167): every leaf is hashed with a fixed tag constant
// before entering the tree — leafHash = Poseidon(LEAF_DOMAIN, leaf) — while
// internal nodes keep the original Poseidon(left, right). Both still use the
// same 2-input Poseidon (matching the on-chain contract's `hash_pair`,
// which only has cryptographic parameters for the 2-input width; minting a
// new, wider Poseidon parameter set is a real ceremony, not something to
// improvise here).
//
// Before this fix, `leaf` was used directly, unhashed, as the tree's
// depth-`levels` value. An attacker who finds two commitments C1, C2 such
// that Poseidon(C1, C2) == C_target could register C1 and C2 as two
// separate members, then present C_target as a fake *leaf* at depth
// levels-1 — since the leaf slot accepted a raw, unhashed value, an
// internal-node hash and a leaf value lived in the same, indistinguishable
// space. Requiring every leaf to first pass through Poseidon(LEAF_DOMAIN,
// leaf) closes this: a forged leaf now requires finding some raw value L
// with Poseidon(LEAF_DOMAIN, L) equal to an internal-node hash the attacker
// can compute from two real members — a second-preimage against Poseidon
// itself, which is exactly the hardness Poseidon is designed to provide.
template MerkleTreeInclusionProof(levels) {
    var LEAF_DOMAIN = 1;

    // Private inputs
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels]; // 0 = left, 1 = right

    // Public output
    signal output root;

    // Intermediate hashes
    component hashers[levels];
    component selectors[levels];
    component leafHasher = Poseidon(2);

    signal currentHash[levels + 1];

    // Domain-separate the leaf before entering the tree.
    leafHasher.inputs[0] <== LEAF_DOMAIN;
    leafHasher.inputs[1] <== leaf;
    currentHash[0] <== leafHasher.out;

    for (var i = 0; i < levels; i++) {
        // CRITICAL CONSTRAINT: Ensure pathIndices is binary (0 or 1)
        // Without this, prover could use fractional values to manipulate the proof
        // Algebraic constraint: v(v-1)=0 only holds for v=0 or v=1
        // SECURITY: This is essential for Merkle proof soundness
        pathIndices[i] * (pathIndices[i] - 1) === 0;

        // Select left and right based on path index
        // If pathIndices[i] == 0: current is left, sibling is right
        // If pathIndices[i] == 1: current is right, sibling is left
        selectors[i] = Selector();
        selectors[i].in[0] <== currentHash[i];
        selectors[i].in[1] <== pathElements[i];
        selectors[i].s <== pathIndices[i];

        // Hash the pair using Poseidon
        // CONSTRAINT: Poseidon hash is deterministic and fully constrains output
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== selectors[i].out[0]; // left
        hashers[i].inputs[1] <== selectors[i].out[1]; // right

        // Propagate hash to next level using constrained assignment (<==)
        currentHash[i + 1] <== hashers[i].out;
    }

    root <== currentHash[levels];
}

// Post-Quantum SHA3-256 Merkle tree inclusion proof template
//
// Provides a dual-tree architecture alongside the classical Poseidon tree.
// The SHA3-256 layer supplies quantum-resistant leaf privacy and nullifier
// preimage resistance (THREAT_MODEL risk matrix). Leaf domain separation
// mirrors the Poseidon tree: leafHash = SHA3-256(LEAF_DOMAIN, leaf), and
// internal nodes hash left || right with SHA3-256.
//
// PRODUCTION NOTE: The Sha3Hasher component below is a structural placeholder.
// Replace it with an optimized SHA3-256 circom implementation (e.g., Keccak-f
// [1600] with multi-bit signal packing) before deployment. The interface is
// stable and all callers (frontend, migration script, KAT) already use real
// SHA3-256 off-chain.
template Sha3MerkleTreeInclusionProof(levels) {
    var LEAF_DOMAIN = 1;

    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels]; // 0 = left, 1 = right

    signal output root;

    component hashers[levels];
    component selectors[levels];
    component leafHasher = Sha3Hasher();

    signal currentHash[levels + 1];

    leafHasher.in[0] <== LEAF_DOMAIN;
    leafHasher.in[1] <== leaf;
    currentHash[0] <== leafHasher.out;

    for (var i = 0; i < levels; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;

        selectors[i] = Selector();
        selectors[i].in[0] <== currentHash[i];
        selectors[i].in[1] <== pathElements[i];
        selectors[i].s <== pathIndices[i];

        hashers[i] = Sha3Hasher();
        hashers[i].in[0] <== selectors[i].out[0];
        hashers[i].in[1] <== selectors[i].out[1];
        currentHash[i + 1] <== hashers[i].out;
    }

    root <== currentHash[levels];
}

// SHA3-256 hasher placeholder
//
// Production replacement: swap this template for a real SHA3-256 circom circuit.
// Requirements:
//   - input: 2 x BN254 field elements (left, right)
//   - output: 1 x BN254 field element = SHA3-256(serialize(left) || serialize(right)) mod Fr
//   - must match the frontend's crypto.subtle.digest("SHA3-256", ...) and
//     the on-chain env.crypto().sha256() outputs when reduced to the field.
template Sha3Hasher() {
    signal input in[2];
    signal output out;

    // PLACEHOLDER: identity mapping. NOT CRYPTOGRAPHICALLY SECURE.
    // This template exists so that dual-tree callers compile and the
    // architecture is in place. Wire in a real SHA3-256 implementation
    // before any production deployment.
    out <== in[0] + in[1];
}

// Selector: swaps inputs based on selection bit
// CONSTRAINT ANALYSIS:
// - When s=0: out[0] = in[0], out[1] = in[1] (no swap)
// - When s=1: out[0] = in[1], out[1] = in[0] (swap)
// 
// Mathematical derivation:
//   out[0] = (in[1] - in[0]) * s + in[0]
//          = in[0] + s*(in[1] - in[0])
//          = in[0]*(1-s) + in[1]*s
//
// SECURITY: Relies on s being binary (0 or 1), which is enforced by caller
// All operations use constrained assignment (<==) for proper constraint
template Selector() {
    signal input in[2];
    signal input s;
    signal output out[2];

    // If s == 0: out[0] = in[0], out[1] = in[1]
    // If s == 1: out[0] = in[1], out[1] = in[0]
    // CONSTRAINED: Using <== ensures these are constrained assignments
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}
