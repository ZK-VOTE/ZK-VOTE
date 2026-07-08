// Conversion utility functions for BN254 point serialization
// Extracted for unit testing
//
// After PR #1614, Soroban's BN254 host functions use BIG-ENDIAN byte order
// per CAP-74 and EIP-196/197 (Ethereum precompile format).
//
// G1 format: be_bytes(X) || be_bytes(Y)
// G2 format: be_bytes(X.c1) || be_bytes(X.c0) || be_bytes(Y.c1) || be_bytes(Y.c0)
//
// snarkjs outputs G2 as [[c0, c1], [c0, c1]], so we need to swap within each pair.

/**
 * Convert bigint to 32-byte hex string in BIG-ENDIAN format
 * After PR #1614, Soroban BN254 host functions expect big-endian byte order!
 *
 * @param {bigint} n - Field element as bigint
 * @returns {string} 64-character hex string (32 bytes, big-endian)
 */
function toBE32ByteHex(n) {
    return BigInt(n).toString(16).padStart(64, '0');
}

/**
 * Convert G1 point (affine coordinates) to Soroban format
 * G1 point: [x, y, z] where z should be 1 for affine
 * Output: 64 bytes (32-byte x BE, 32-byte y BE)
 *
 * @param {Array<string>} point - [x, y, z] as decimal strings
 * @returns {string} 128-character hex string (64 bytes)
 */
function convertG1Point(point) {
    const x = toBE32ByteHex(BigInt(point[0]));
    const y = toBE32ByteHex(BigInt(point[1]));
    return x + y;
}

/**
 * Convert G2 point (affine coordinates in Fq2) to Soroban format
 * G2 point: [[c0, c1], [c0, c1], [z0, z1]] where z should be [1, 0] for affine
 * snarkjs outputs: [[x.c0, x.c1], [y.c0, y.c1]]
 * Soroban BE expects: X.c1 || X.c0 || Y.c1 || Y.c0 (imaginary before real per CAP-74)
 *
 * @param {Array<Array<string>>} point - [[x_c0, x_c1], [y_c0, y_c1], [z_c0, z_c1]] as decimal strings
 * @returns {string} 256-character hex string (128 bytes)
 */
function convertG2Point(point) {
    // CAP-74: c1 (imaginary) before c0 (real) for extension field elements
    const x_c1 = toBE32ByteHex(BigInt(point[0][1]));  // X imaginary
    const x_c0 = toBE32ByteHex(BigInt(point[0][0]));  // X real
    const y_c1 = toBE32ByteHex(BigInt(point[1][1]));  // Y imaginary
    const y_c0 = toBE32ByteHex(BigInt(point[1][0]));  // Y real

    return x_c1 + x_c0 + y_c1 + y_c0;
}

/**
 * Convert snarkjs Groth16 proof to Soroban format
 *
 * @param {Object} proof - snarkjs proof object with pi_a, pi_b, pi_c
 * @returns {Object} Soroban proof with a, b, c as hex strings
 */
function convertProofToSoroban(proof) {
    return {
        a: convertG1Point(proof.pi_a),
        b: convertG2Point(proof.pi_b),
        c: convertG1Point(proof.pi_c)
    };
}

/**
 * Convert snarkjs verification key to Soroban format
 *
 * @param {Object} vkey - snarkjs verification key
 * @returns {Object} Soroban VK with alpha, beta, gamma, delta, ic
 */
function convertVKeyToSoroban(vkey) {
    // Convert IC points (array of G1 points)
    const ic = vkey.IC.map(point => convertG1Point(point));

    return {
        alpha: convertG1Point(vkey.vk_alpha_1),
        beta: convertG2Point(vkey.vk_beta_2),
        gamma: convertG2Point(vkey.vk_gamma_2),
        delta: convertG2Point(vkey.vk_delta_2),
        ic
    };
}

/**
 * Reverse a hex string byte-by-byte
 * Used for converting between big-endian and little-endian
 *
 * @param {string} hex - Hex string (even length)
 * @returns {string} Byte-reversed hex string
 */
function reverseHexBytes(hex) {
    const bytes = hex.match(/.{2}/g);
    return bytes.reverse().join('');
}

module.exports = {
    toBE32ByteHex,
    convertG1Point,
    convertG2Point,
    convertProofToSoroban,
    convertVKeyToSoroban,
    reverseHexBytes
};
