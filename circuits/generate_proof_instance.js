#!/usr/bin/env node
/**
 * Parameterized Groth16 proof generator for Soroban integration tests.
 *
 * Usage:
 *   node generate_proof_instance.js --label member2 --secret 222 --salt 333 --dao 1 --proposal 1 --vote 1 --index 1 --depth 20
 *
 * Defaults mirror the existing test proof:
 *   secret=123456789, salt=987654321, dao=1, proposal=1, vote=1, index=0, depth=18
 *
 * Requires:
 *   - circomlibjs
 *   - snarkjs
 *   - vote.wasm and vote_final.zkey in ../frontend/public/circuits
 */

const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');
const circomlibjs = require('circomlibjs');

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const val = args[i + 1];
    if (!val) continue;
    switch (key) {
      case '--label':
        result.label = val;
        break;
      case '--secret':
        result.secret = BigInt(val);
        break;
      case '--salt':
        result.salt = BigInt(val);
        break;
      case '--dao':
        result.daoId = BigInt(val);
        break;
      case '--proposal':
        result.proposalId = BigInt(val);
        break;
      case '--vote':
        result.voteChoice = BigInt(val);
        break;
      case '--index':
        result.index = parseInt(val, 10);
        break;
      case '--depth':
        result.depth = parseInt(val, 10);
        break;
      default:
        console.warn(`Unknown arg: ${key}`);
    }
  }
  return result;
}

async function main() {
  const {
    label = 'member_default',
    secret = 123456789n,
    salt = 987654321n,
    daoId = 1n,
    proposalId = 1n,
    voteChoice = 1n,
    index = 0,
    depth = 18,
  } = parseArgs();

  const poseidon = await circomlibjs.buildPoseidon();

  const commitment = poseidon.F.toObject(poseidon([secret, salt]));
  const nullifier = poseidon.F.toObject(poseidon([secret, daoId, proposalId]));

  // Precompute zero hashes
  const zeros = [0n];
  let currentZero = 0n;
  for (let i = 0; i < depth; i++) {
    currentZero = poseidon.F.toObject(poseidon([currentZero, currentZero]));
    zeros.push(currentZero);
  }

  // Build path for a given index in an empty tree
  let currentHash = commitment;
  const pathIndices = [];
  const pathElements = [];
  let idx = index;

  for (let i = 0; i < depth; i++) {
    const bit = idx & 1;
    pathIndices.push(bit);
    const sibling = zeros[i];
    pathElements.push(sibling.toString());

    if (bit === 0) {
      currentHash = poseidon.F.toObject(poseidon([currentHash, sibling]));
    } else {
      currentHash = poseidon.F.toObject(poseidon([sibling, currentHash]));
    }
    idx >>= 1;
  }

  const root = currentHash;

  const input = {
    root: root.toString(),
    nullifier: nullifier.toString(),
    daoId: daoId.toString(),
    proposalId: proposalId.toString(),
    voteChoice: voteChoice.toString(),
    commitment: commitment.toString(),
    secret: secret.toString(),
    salt: salt.toString(),
    pathElements,
    pathIndices,
  };

  const wasmPath = path.join(__dirname, '..', 'frontend', 'public', 'circuits', 'vote.wasm');
  const zkeyPath = path.join(__dirname, '..', 'frontend', 'public', 'circuits', 'vote_final.zkey');

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);

  const bigIntToHex = (n) => BigInt(n).toString(16).padStart(64, '0');
  const formatG1 = (x, y) => bigIntToHex(x) + bigIntToHex(y);
  const formatG2 = (x, y) =>
    bigIntToHex(x[0]) + bigIntToHex(x[1]) + bigIntToHex(y[0]) + bigIntToHex(y[1]);

  const proofA = formatG1(proof.pi_a[0], proof.pi_a[1]);
  const proofB = formatG2(proof.pi_b[0], proof.pi_b[1]);
  const proofC = formatG1(proof.pi_c[0], proof.pi_c[1]);

  const outDir = path.join(__dirname, 'generated');
  fs.mkdirSync(outDir, { recursive: true });

  const data = {
    label,
    inputs: {
      secret: secret.toString(),
      salt: salt.toString(),
      daoId: daoId.toString(),
      proposalId: proposalId.toString(),
      voteChoice: voteChoice.toString(),
      index,
      depth,
    },
    computed: {
      commitment: commitment.toString(),
      commitmentHex: '0x' + commitment.toString(16).padStart(64, '0'),
      nullifier: nullifier.toString(),
      nullifierHex: '0x' + nullifier.toString(16).padStart(64, '0'),
      root: root.toString(),
      rootHex: '0x' + root.toString(16).padStart(64, '0'),
    },
    proof: {
      a: proofA,
      b: proofB,
      c: proofC,
    },
    publicSignals,
  };

  const jsonPath = path.join(outDir, `proof_${label}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  console.log(`✓ wrote ${jsonPath}`);

  // Save raw proof/public signals for converter scripts
  const rawPath = path.join(outDir, `proof_${label}_raw.json`);
  const raw = {
    proof,
    publicSignals,
  };
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2));
  console.log(`✓ wrote raw proof/public to ${rawPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
