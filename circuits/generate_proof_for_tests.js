#!/usr/bin/env node
/**
 * Generate real Groth16 proofs for Rust integration tests
 *
 * Usage:
 *   node generate_proof_for_tests.js
 *
 * This script:
 * 1. Computes Poseidon commitment and nullifier
 * 2. Builds Merkle tree and gets siblings
 * 3. Generates Groth16 proof using snarkjs
 * 4. Outputs Rust code ready to paste into tests
 */

const snarkjs = require('snarkjs');
const circomlibjs = require('circomlibjs');
const fs = require('fs');

async function generateTestProof() {
  const poseidon = await circomlibjs.buildPoseidon();

  // Test values (customize these for different test scenarios)
  const secret = 123456789n;
  const salt = 987654321n;
  const daoId = 1n;
  const proposalId = 1n;
  const voteChoice = 1n; // 1 = yes, 0 = no

  // Compute commitment
  const commitment = poseidon.F.toObject(poseidon([secret, salt]));
  console.log('Commitment:', commitment.toString());
  console.log('Commitment (hex):', '0x' + commitment.toString(16).padStart(64, '0'));

  // Compute nullifier
  const nullifier = poseidon.F.toObject(poseidon([secret, daoId, proposalId]));
  console.log('\nNullifier:', nullifier.toString());
  console.log('Nullifier (hex):', '0x' + nullifier.toString(16).padStart(64, '0'));

  // Compute zero values for Merkle tree (depth 18 to match circuit)
  const depth = 18;
  const zeros = [0n];
  let currentZero = 0n;
  for (let i = 0; i < depth; i++) {
    currentZero = poseidon.F.toObject(poseidon([currentZero, currentZero]));
    zeros.push(currentZero);
  }

  // Compute root if commitment is at index 0 in empty tree
  let currentHash = commitment;
  let pathIndices = [];
  let pathElements = [];

  for (let i = 0; i < depth; i++) {
    pathIndices.push(0); // Left side (even index)
    pathElements.push(zeros[i].toString());
    currentHash = poseidon.F.toObject(poseidon([currentHash, zeros[i]]));
  }

  const root = currentHash;
  console.log('\nRoot (commitment at index 0):', root.toString());
  console.log('Root (hex):', '0x' + root.toString(16).padStart(64, '0'));

  // Prepare circuit input
  const input = {
    root: root.toString(),
    nullifier: nullifier.toString(),
    daoId: daoId.toString(),
    proposalId: proposalId.toString(),
    voteChoice: voteChoice.toString(),
    secret: secret.toString(),
    salt: salt.toString(),
    pathElements: pathElements,
    pathIndices: pathIndices
  };

  console.log('\n=== Generating Groth16 Proof ===');

  // Generate proof
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    '../frontend/public/circuits/vote.wasm',
    '../frontend/public/circuits/vote_final.zkey'
  );

  console.log('\n✓ Proof generated successfully');
  console.log('Public signals:', publicSignals);

  // Convert proof to Soroban format (BN254 curve points)
  // Proof.A is G1 point (64 bytes: x, y each 32 bytes)
  // Proof.B is G2 point (128 bytes: x1, x2, y1, y2 each 32 bytes)
  // Proof.C is G1 point (64 bytes)

  function bigIntToHex(n) {
    return BigInt(n).toString(16).padStart(64, '0');
  }

  function formatG1Point(x, y) {
    const xHex = bigIntToHex(x);
    const yHex = bigIntToHex(y);
    return xHex + yHex;
  }

  function formatG2Point(x, y) {
    // G2 points have two coordinates each (x = [x1, x2], y = [y1, y2])
    const x1Hex = bigIntToHex(x[0]);
    const x2Hex = bigIntToHex(x[1]);
    const y1Hex = bigIntToHex(y[0]);
    const y2Hex = bigIntToHex(y[1]);
    return x1Hex + x2Hex + y1Hex + y2Hex;
  }

  const proofA = formatG1Point(proof.pi_a[0], proof.pi_a[1]);
  const proofB = formatG2Point(proof.pi_b[0], proof.pi_b[1]);
  const proofC = formatG1Point(proof.pi_c[0], proof.pi_c[1]);

  console.log('\n=== Proof in Soroban Format ===');
  console.log('Proof.A (G1, 64 bytes):', proofA);
  console.log('Proof.B (G2, 128 bytes):', proofB);
  console.log('Proof.C (G1, 64 bytes):', proofC);

  // Generate Rust code
  const rustCode = `
// Generated proof for test scenario:
// secret=${secret}, salt=${salt}, daoId=${daoId}, proposalId=${proposalId}, voteChoice=${voteChoice}
// commitment=${commitment.toString()} (0x${commitment.toString(16).padStart(64, '0')})
// nullifier=${nullifier.toString()} (0x${nullifier.toString(16).padStart(64, '0')})
// root=${root.toString()} (0x${root.toString(16).padStart(64, '0')})

fn hex_to_bytes<const N: usize>(env: &Env, hex: &str) -> BytesN<N> {
    let bytes = hex::decode(hex).expect("invalid hex");
    assert_eq!(bytes.len(), N, "hex string wrong length");
    BytesN::from_array(env, &bytes.try_into().unwrap())
}

fn hex_str_to_u256(env: &Env, hex: &str) -> U256 {
    let bytes = hex::decode(hex).expect("invalid hex");
    let mut padded = [0u8; 32];
    let start = 32 - bytes.len();
    padded[start..].copy_from_slice(&bytes);
    U256::from_be_bytes(env, &Bytes::from_array(env, &padded))
}

fn get_test_proof(env: &Env) -> voting::Proof {
    voting::Proof {
        a: hex_to_bytes(env, "${proofA}"),
        b: hex_to_bytes(env, "${proofB}"),
        c: hex_to_bytes(env, "${proofC}"),
    }
}

// In your test:
let commitment = hex_str_to_u256(&env, "${commitment.toString(16).padStart(64, '0')}");
let nullifier = hex_str_to_u256(&env, "${nullifier.toString(16).padStart(64, '0')}");
let root = hex_str_to_u256(&env, "${root.toString(16).padStart(64, '0')}");
let proof = get_test_proof(&env);

// Register the commitment
tree_client.register_with_caller(&dao_id, &commitment, &member);

// Vote with the proof
voting_client.vote(&dao_id, &proposal_id, &${voteChoice === 1n ? 'true' : 'false'}, &nullifier, &root, &proof);
`;

  console.log('\n=== Rust Code for Tests ===');
  console.log(rustCode);

  // Save to file
  fs.writeFileSync('test_proof.rs', rustCode);
  console.log('\n✓ Saved Rust code to test_proof.rs');

  // Also save raw data as JSON for reference
  const testData = {
    inputs: {
      secret: secret.toString(),
      salt: salt.toString(),
      daoId: daoId.toString(),
      proposalId: proposalId.toString(),
      voteChoice: voteChoice.toString(),
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
    publicSignals: publicSignals,
  };

  fs.writeFileSync('test_proof.json', JSON.stringify(testData, null, 2));
  console.log('✓ Saved proof data to test_proof.json');
}

generateTestProof().catch(console.error);
