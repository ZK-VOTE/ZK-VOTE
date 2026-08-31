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
//
// The actual conversion lives in conversion-utils.js (shared with the parity
// test suite) so the tested code path is byte-for-byte the one used here.

const fs = require('fs');
const { convertVKeyToSoroban } = require('./conversion-utils');

// Read verification key
const vkeyFile = process.argv[2] || 'build/verification_key.json';
const vkey = JSON.parse(fs.readFileSync(vkeyFile, 'utf8'));

console.log('Converting verification key to Soroban format (BIG-ENDIAN per PR #1614)...\n');

// Convert alpha (G1): X || Y
// Convert beta (G2): X.c1 || X.c0 || Y.c1 || Y.c0
// snarkjs output: [[x.c0, x.c1], [y.c0, y.c1]]
// Soroban expects: c1 || c0 for each coordinate pair
// Convert gamma (G2)
// Convert delta (G2)
// Convert IC points (G1 array): X || Y for each
const sorobanVK = convertVKeyToSoroban(vkey);
const { alpha, beta, gamma, delta, ic } = sorobanVK;

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

// Save to file
// Optional argv[3] lets the parity CLI tests direct output to a temp dir;
// when omitted, the historical default paths are used (backwards compatible).
const outputFile = process.argv[3] || 'build/verification_key_soroban.json';
fs.writeFileSync(outputFile, JSON.stringify(sorobanVK, null, 2));

console.log(`Saved to ${outputFile}`);

// Also save to frontend (only when running with the default output path)
if (!process.argv[3]) {
    const frontendOutputFile = '../frontend/src/lib/verification_key_soroban.json';
    fs.writeFileSync(frontendOutputFile, JSON.stringify(sorobanVK, null, 2));
    console.log(`Saved to ${frontendOutputFile}\n`);
} else {
    console.log('');
}

console.log('=== Encoding Notes ===');
console.log('- G1 points: X || Y (big-endian, 64 bytes total)');
console.log('- G2 points: X.c1 || X.c0 || Y.c1 || Y.c0 (big-endian, 128 bytes total)');
console.log('- Extension field: c1 (imaginary) before c0 (real) per CAP-74');
console.log('');

