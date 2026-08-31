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

// ---------------------------------------------------------------------------
// Reverse conversions (Soroban big-endian -> snarkjs decimal) so round-trip
// parity tests can decode a Soroban byte string back to the exact snarkjs
// field elements it was produced from.
// ---------------------------------------------------------------------------

/**
 * Parse a 32-byte (64-hex-char) big-endian hex string back to a BigInt.
 *
 * @param {string} hex - 64-character hex string
 * @returns {bigint} Parsed value
 */
function beHexToBigInt(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(`beHexToBigInt: expected 64 hex chars, got ${JSON.stringify(hex)}`);
    }
    return BigInt('0x' + hex);
}

/**
 * Decode a Soroban-format G1 point (64 bytes: be32(X) || be32(Y)) back to
 * snarkjs format: [x, y, "1"] as decimal strings.
 *
 * @param {string} hex - 128-hex-char (64-byte) Soroban G1 encoding
 * @returns {Array<string>} snarkjs G1 point [x, y, "1"]
 */
function sorobanG1ToSnarkjs(hex) {
    if (typeof hex !== 'string' || hex.length !== 128) {
        throw new Error(`sorobanG1ToSnarkjs: expected 128 hex chars, got ${JSON.stringify(hex)}`);
    }
    const x = beHexToBigInt(hex.slice(0, 64));
    const y = beHexToBigInt(hex.slice(64, 128));
    return [x.toString(), y.toString(), '1'];
}

/**
 * Decode a Soroban-format G2 point (128 bytes:
 * be32(X.c1) || be32(X.c0) || be32(Y.c1) || be32(Y.c0)) back to snarkjs
 * format: [[x.c0, x.c1], [y.c0, y.c1], ["1", "0"]] as decimal strings.
 *
 * @param {string} hex - 256-hex-char (128-byte) Soroban G2 encoding
 * @returns {Array<Array<string>>} snarkjs G2 point
 */
function sorobanG2ToSnarkjs(hex) {
    if (typeof hex !== 'string' || hex.length !== 256) {
        throw new Error(`sorobanG2ToSnarkjs: expected 256 hex chars, got ${JSON.stringify(hex)}`);
    }
    const x_c1 = beHexToBigInt(hex.slice(0, 64));   // imaginary (first, per CAP-74)
    const x_c0 = beHexToBigInt(hex.slice(64, 128)); // real
    const y_c1 = beHexToBigInt(hex.slice(128, 192));
    const y_c0 = beHexToBigInt(hex.slice(192, 256));

    // snarkjs order is [c0, c1]; the "1" / "0" z-coordinate is restored too.
    return [
        [x_c0.toString(), x_c1.toString()],
        [y_c0.toString(), y_c1.toString()],
        ['1', '0']
    ];
}

/**
 * Reverse of `convertProofToSoroban`: decode a Soroban BE proof object
 * ({a, b, c} hex strings) back into the snarkjs proof shape
 * {pi_a, pi_b, pi_c}.
 *
 * @param {Object} sorobanProof - {a: string, b: string, c: string}
 * @returns {Object} snarkjs proof {pi_a, pi_b, pi_c}
 */
function sorobanProofToSnarkjs(sorobanProof) {
    if (!sorobanProof || typeof sorobanProof !== 'object') {
        throw new Error('sorobanProofToSnarkjs: expected a proof object');
    }
    return {
        pi_a: sorobanG1ToSnarkjs(sorobanProof.a),
        pi_b: sorobanG2ToSnarkjs(sorobanProof.b),
        pi_c: sorobanG1ToSnarkjs(sorobanProof.c)
    };
}

/**
 * Reverse of `convertVKeyToSoroban`: decode a Soroban BE verification key
 * ({alpha, beta, gamma, delta, ic} hex strings) back into the snarkjs vkey
 * shape {vk_alpha_1, vk_beta_2, vk_gamma_2, vk_delta_2, IC}.
 *
 * @param {Object} sorobanVK - {alpha, beta, gamma, delta, ic: string[]}
 * @returns {Object} snarkjs verification key
 */
function sorobanVKeyToSnarkjs(sorobanVK) {
    if (!sorobanVK || typeof sorobanVK !== 'object' || !Array.isArray(sorobanVK.ic)) {
        throw new Error('sorobanVKeyToSnarkjs: expected {alpha, beta, gamma, delta, ic}');
    }
    return {
        vk_alpha_1: sorobanG1ToSnarkjs(sorobanVK.alpha),
        vk_beta_2: sorobanG2ToSnarkjs(sorobanVK.beta),
        vk_gamma_2: sorobanG2ToSnarkjs(sorobanVK.gamma),
        vk_delta_2: sorobanG2ToSnarkjs(sorobanVK.delta),
        IC: sorobanVK.ic.map(point => sorobanG1ToSnarkjs(point))
    };
}

module.exports = {
    toBE32ByteHex,
    convertG1Point,
    convertG2Point,
    convertProofToSoroban,
    convertVKeyToSoroban,
    reverseHexBytes,
    beHexToBigInt,
    sorobanG1ToSnarkjs,
    sorobanG2ToSnarkjs,
    sorobanProofToSnarkjs,
    sorobanVKeyToSnarkjs
};
