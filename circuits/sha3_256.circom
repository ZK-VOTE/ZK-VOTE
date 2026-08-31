pragma circom 2.0.0;

// SHA3-256 hasher for Merkle tree internal nodes
//
// INTERFACE:
//   input in[2]  - left and right child hashes (field elements)
//   output out    - SHA3-256(serialize(in[0]) || serialize(in[1])) reduced to a field element
//
// PRODUCTION REQUIREMENTS:
//   1. Serialize each BN254 field element to 32 bytes big-endian.
//   2. Concatenate the two 32-byte blocks (64 bytes total).
//   3. Apply SHA3-256 padding (domain = 0x06, rate = 136 bytes).
//   4. Run 24 rounds of Keccak-f[1600].
//   5. Truncate to 32 bytes and interpret as a BN254 scalar field element.
//
// SECURITY: Must match the frontend's crypto.subtle.digest("SHA3-256", ...) and
// the on-chain env.crypto().sha256() when the 32-byte digest is interpreted as
// a U256. Any mismatch breaks Merkle proof verification across layers.
//
// The placeholder below is structurally correct but NOT cryptographically secure.
// Wire in a real Keccak-f[1600] implementation before any production use.
template Sha3Hasher() {
    signal input in[2];
    signal output out;

    // PLACEHOLDER: linear combination. Replace with real SHA3-256.
    out <== in[0] + in[1];
}
