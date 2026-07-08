const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { convertProof } = require('../proof_to_soroban');

function beHex(num, bytes) {
  return num.toString(16).padStart(bytes * 2, '0');
}

test('proof_to_soroban preserves BE ordering and G2 component swap', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-'));
  const proofPath = path.join(tmp, 'proof.json');
  const publicPath = path.join(tmp, 'public.json');

  // Small deterministic values to inspect ordering
  const proof = {
    pi_a: ['1', '2'], // G1
    pi_b: [
      ['3', '4'],     // X = [x0, x1] in snarkjs; should swap
      ['5', '6']      // Y = [y0, y1] in snarkjs; should swap
    ],
    pi_c: ['7', '8']
  };
  const publicSignals = ['9', '10', '11', '12', '13'];

  fs.writeFileSync(proofPath, JSON.stringify(proof));
  fs.writeFileSync(publicPath, JSON.stringify(publicSignals));

  const { proof: converted, publicSignals: convertedSignals } = convertProof(proofPath, publicPath);

  // Expect big-endian 32-byte coords concatenated
  const expectedA =
    beHex(1n, 32) + // x
    beHex(2n, 32);  // y
  const expectedB =
    beHex(4n, 32) + // x1 (swapped)
    beHex(3n, 32) + // x0
    beHex(6n, 32) + // y1
    beHex(5n, 32);  // y0
  const expectedC =
    beHex(7n, 32) +
    beHex(8n, 32);

  const hex = bytes => Buffer.from(bytes).toString('hex');
  assert.equal(hex(converted.a), expectedA);
  assert.equal(hex(converted.b), expectedB);
  assert.equal(hex(converted.c), expectedC);
  assert.deepEqual(convertedSignals, publicSignals);
});
