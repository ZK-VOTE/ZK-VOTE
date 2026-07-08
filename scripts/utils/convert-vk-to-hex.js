// Convert snarkjs verification_key.json to Soroban hex format
// Usage: node scripts/convert-vk-to-hex.js <path-to-verification_key.json>

const fs = require('fs');

// Convert a decimal string to big-endian hex (32 bytes = 64 chars)
function toHexBE(decimalStr) {
  const bigInt = BigInt(decimalStr);
  return bigInt.toString(16).padStart(64, '0');
}

// G1 point: [x, y, 1] -> x || y (64 bytes)
function encodeG1(point) {
  const x = toHexBE(point[0]);
  const y = toHexBE(point[1]);
  return x + y;
}

// G2 point: [[x_c0, x_c1], [y_c0, y_c1], [1, 0]] -> x_c1 || x_c0 || y_c1 || y_c0 (128 bytes)
// snarkjs: [c0=real, c1=imag], Soroban wants [c1, c0] ordering
function encodeG2(point) {
  const x_c0 = toHexBE(point[0][0]);
  const x_c1 = toHexBE(point[0][1]);
  const y_c0 = toHexBE(point[1][0]);
  const y_c1 = toHexBE(point[1][1]);
  // Swap within each pair: c1 first, then c0
  return x_c1 + x_c0 + y_c1 + y_c0;
}

const vkPath = process.argv[2] || 'frontend/public/circuits/comment/verification_key.json';
const vk = JSON.parse(fs.readFileSync(vkPath, 'utf8'));

console.log('# Verification key in hex format for Soroban');
console.log(`# Source: ${vkPath}`);
console.log(`# Public inputs: ${vk.nPublic}`);
console.log(`# IC points: ${vk.IC.length}`);
console.log('');

console.log(`ALPHA="${encodeG1(vk.vk_alpha_1)}"`);
console.log(`BETA="${encodeG2(vk.vk_beta_2)}"`);
console.log(`GAMMA="${encodeG2(vk.vk_gamma_2)}"`);
console.log(`DELTA="${encodeG2(vk.vk_delta_2)}"`);

vk.IC.forEach((ic, i) => {
  console.log(`IC${i}="${encodeG1(ic)}"`);
});

console.log('');
console.log('# JSON format for stellar contract invoke:');
const icArray = vk.IC.map(ic => encodeG1(ic));
console.log(`IC_JSON='["${icArray.join('", "')}"]'`);
