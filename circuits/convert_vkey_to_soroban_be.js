#!/usr/bin/env node
// Convert snarkjs verification key to Soroban format (BIG-ENDIAN)
//
// After PR #1614, Soroban's BN254 host functions use BIG-ENDIAN byte order
// per CAP-74 and EIP-196/197 (Ethereum precompile format).
//
// G1 format: be_bytes(X) || be_bytes(Y)
// G2 format: be_bytes(X.c1) || be_bytes(X.c0) || be_bytes(Y.c1) || be_bytes(Y.c0)
//
// snarkjs outputs G2 as [[c0, c1], [c0, c1]], so we need to swap within each pair.

const fs = require('fs');

// Convert bigint to 32-byte hex string (BIG-ENDIAN - no reversal needed)
function toBE32ByteHex(n) {
    return BigInt(n).toString(16).padStart(64, '0');
}

// Read verification key
const vkeyFile = process.argv[2] || 'build/verification_key.json';
const vkey = JSON.parse(fs.readFileSync(vkeyFile, 'utf8'));

console.log('Converting verification key to Soroban format (BIG-ENDIAN per PR #1614)...\n');

// Convert alpha (G1): X || Y
const alpha_x = toBE32ByteHex(vkey.vk_alpha_1[0]);
const alpha_y = toBE32ByteHex(vkey.vk_alpha_1[1]);
const alpha = alpha_x + alpha_y;

// Convert beta (G2): X.c1 || X.c0 || Y.c1 || Y.c0
// snarkjs output: [[x.c0, x.c1], [y.c0, y.c1]]
// Soroban expects: c1 || c0 for each coordinate pair
const beta_x_c1 = toBE32ByteHex(vkey.vk_beta_2[0][1]);  // X.c1 (imaginary)
const beta_x_c0 = toBE32ByteHex(vkey.vk_beta_2[0][0]);  // X.c0 (real)
const beta_y_c1 = toBE32ByteHex(vkey.vk_beta_2[1][1]);  // Y.c1 (imaginary)
const beta_y_c0 = toBE32ByteHex(vkey.vk_beta_2[1][0]);  // Y.c0 (real)
const beta = beta_x_c1 + beta_x_c0 + beta_y_c1 + beta_y_c0;

// Convert gamma (G2)
const gamma_x_c1 = toBE32ByteHex(vkey.vk_gamma_2[0][1]);
const gamma_x_c0 = toBE32ByteHex(vkey.vk_gamma_2[0][0]);
const gamma_y_c1 = toBE32ByteHex(vkey.vk_gamma_2[1][1]);
const gamma_y_c0 = toBE32ByteHex(vkey.vk_gamma_2[1][0]);
const gamma = gamma_x_c1 + gamma_x_c0 + gamma_y_c1 + gamma_y_c0;

// Convert delta (G2)
const delta_x_c1 = toBE32ByteHex(vkey.vk_delta_2[0][1]);
const delta_x_c0 = toBE32ByteHex(vkey.vk_delta_2[0][0]);
const delta_y_c1 = toBE32ByteHex(vkey.vk_delta_2[1][1]);
const delta_y_c0 = toBE32ByteHex(vkey.vk_delta_2[1][0]);
const delta = delta_x_c1 + delta_x_c0 + delta_y_c1 + delta_y_c0;

// Convert IC points (G1 array): X || Y for each
const ic = vkey.IC.map((point) => {
    const x = toBE32ByteHex(point[0]);
    const y = toBE32ByteHex(point[1]);
    return x + y;
});

console.log('=== Verification Key (Hex, BIG-ENDIAN) ===');
console.log(`Alpha (G1, 64 bytes): ${alpha}`);
console.log(`Beta  (G2, 128 bytes): ${beta}`);
console.log(`Gamma (G2, 128 bytes): ${gamma}`);
console.log(`Delta (G2, 128 bytes): ${delta}`);
console.log(`IC (${ic.length} G1 points):`);
ic.forEach((point, i) => {
    console.log(`  IC[${i}]: ${point}`);
});
console.log('');

// Build Soroban VK object
const sorobanVK = {
    alpha,
    beta,
    gamma,
    delta,
    ic
};

// Save to file
const outputFile = 'build/verification_key_soroban.json';
fs.writeFileSync(outputFile, JSON.stringify(sorobanVK, null, 2));

// Also save to frontend
const frontendOutputFile = '../frontend/src/lib/verification_key_soroban.json';
fs.writeFileSync(frontendOutputFile, JSON.stringify(sorobanVK, null, 2));

console.log(`Saved to ${outputFile}`);
console.log(`Saved to ${frontendOutputFile}\n`);

console.log('=== Encoding Notes ===');
console.log('- G1 points: X || Y (big-endian, 64 bytes total)');
console.log('- G2 points: X.c1 || X.c0 || Y.c1 || Y.c0 (big-endian, 128 bytes total)');
console.log('- Extension field: c1 (imaginary) before c0 (real) per CAP-74');
console.log('');
