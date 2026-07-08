#!/usr/bin/env node
// Convert snarkjs Groth16 proof to Soroban format (BIG-ENDIAN)
//
// After PR #1614, BN254 host functions in Soroban expect big-endian byte order!
// This matches CAP-74 and EVM precompile specifications (EIP-196, EIP-197).
// snarkjs outputs big-endian natively, so NO byte reversal is needed.

const fs = require('fs');

// Convert bigint to 32-byte hex string (BIG-ENDIAN - no reversal!)
function toBE32ByteHex(n) {
    return n.toString(16).padStart(64, '0');
}

// Read proof
const proofFile = process.argv[2] || 'build/proof.json';
const publicFile = process.argv[3] || 'build/public.json';

const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
const publicSignals = JSON.parse(fs.readFileSync(publicFile, 'utf8'));

// Convert proof points to big-endian hex
// G1 point: [x, y, z] where z should be "1" for affine
// We store only [x, y] in 64 bytes (32 + 32), BIG-ENDIAN
const pi_a_x = toBE32ByteHex(BigInt(proof.pi_a[0]));
const pi_a_y = toBE32ByteHex(BigInt(proof.pi_a[1]));

// G2 point: [[x0, x1], [y0, y1], [z0, z1]] where z should be ["1", "0"] for affine
// snarkjs outputs [c0, c1] where c0=real part, c1=imaginary part
// Soroban BE format expects: [x_c1, x_c0, y_c1, y_c0] (imaginary first)
// So we swap the order within each coordinate pair
const pi_b_x0 = toBE32ByteHex(BigInt(proof.pi_b[0][0])); // x0 (real)
const pi_b_x1 = toBE32ByteHex(BigInt(proof.pi_b[0][1])); // x1 (imaginary)
const pi_b_y0 = toBE32ByteHex(BigInt(proof.pi_b[1][0])); // y0 (real)
const pi_b_y1 = toBE32ByteHex(BigInt(proof.pi_b[1][1])); // y1 (imaginary)

const pi_c_x = toBE32ByteHex(BigInt(proof.pi_c[0]));
const pi_c_y = toBE32ByteHex(BigInt(proof.pi_c[1]));

// Build proof object
// G2 format: swap real/imaginary within each coordinate [c1, c0, c1, c0]
const sorobanProof = {
    a: pi_a_x + pi_a_y,
    b: pi_b_x1 + pi_b_x0 + pi_b_y1 + pi_b_y0,  // [imag_x, real_x, imag_y, real_y]
    c: pi_c_x + pi_c_y
};

console.log('Converting proof to Soroban format (BIG-ENDIAN)...\n');

console.log('=== Proof (Hex, BE) ===');
console.log(`A (G1, 64 bytes): ${sorobanProof.a}`);
console.log(`B (G2, 128 bytes): ${sorobanProof.b}`);
console.log(`C (G1, 64 bytes): ${sorobanProof.c}`);
console.log('');

console.log('=== Public Signals ===');
const labels = ['Root', 'Nullifier', 'DAO ID', 'Proposal ID', 'Vote Choice', 'Commitment'];
publicSignals.forEach((sig, i) => {
    console.log(`[${i}] ${labels[i] || `Signal ${i}`}: ${sig}`);
});
console.log('');

// Save to file
const outputFile = proofFile.replace('.json', '_soroban_be.json');
fs.writeFileSync(outputFile, JSON.stringify(sorobanProof, null, 2));

console.log(`Saved to ${outputFile}\n`);

console.log('=== Stellar CLI Vote Command ===\n');
console.log(`stellar contract invoke \\`);
console.log(`  --id <VOTING_CONTRACT_ID> \\`);
console.log(`  --source-account relayer \\`);
console.log(`  -- vote \\`);
console.log(`  --dao_id ${publicSignals[2]} \\`);
console.log(`  --proposal_id ${publicSignals[3]} \\`);
console.log(`  --vote_choice ${publicSignals[4] === '1' ? 'true' : 'false'} \\`);
console.log(`  --nullifier ${publicSignals[1]} \\`);
console.log(`  --root ${publicSignals[0]} \\`);
console.log(`  --commitment ${publicSignals[5]} \\`);
console.log(`  --proof '${JSON.stringify(sorobanProof)}'`);
console.log('');
