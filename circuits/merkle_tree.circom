pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";

// Merkle tree inclusion proof using Poseidon hash
// Compatible with Stellar P25 on-chain Poseidon (BN254)
template MerkleTreeInclusionProof(levels) {
    // Private inputs
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels]; // 0 = left, 1 = right

    // Public output
    signal output root;

    // Intermediate hashes
    component hashers[levels];
    component selectors[levels];

    signal currentHash[levels + 1];
    currentHash[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // Ensure pathIndices is binary (0 or 1)
        pathIndices[i] * (pathIndices[i] - 1) === 0;

        // Select left and right based on path index
        // If pathIndices[i] == 0: current is left, sibling is right
        // If pathIndices[i] == 1: current is right, sibling is left
        selectors[i] = Selector();
        selectors[i].in[0] <== currentHash[i];
        selectors[i].in[1] <== pathElements[i];
        selectors[i].s <== pathIndices[i];

        // Hash the pair using Poseidon
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== selectors[i].out[0]; // left
        hashers[i].inputs[1] <== selectors[i].out[1]; // right

        currentHash[i + 1] <== hashers[i].out;
    }

    root <== currentHash[levels];
}

// Selector: swaps inputs based on selection bit
template Selector() {
    signal input in[2];
    signal input s;
    signal output out[2];

    // If s == 0: out[0] = in[0], out[1] = in[1]
    // If s == 1: out[0] = in[1], out[1] = in[0]
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}
