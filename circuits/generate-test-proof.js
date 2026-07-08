const { buildPoseidon } = require('circomlibjs');
const snarkjs = require('snarkjs');
const fs = require('fs');

(async () => {
  const poseidon = await buildPoseidon();
  
  // Generate test credentials
  const secret = BigInt('999888777666');
  const salt = BigInt('111222333444');
  const daoId = BigInt('1');
  const proposalId = BigInt('1');
  const voteChoice = BigInt('1');
  
  // Compute commitment
  const commitment = poseidon.F.toString(poseidon([secret, salt]));
  console.log('Commitment:', commitment);
  
  // Compute nullifier
  const nullifier = poseidon.F.toString(poseidon([secret, daoId, proposalId]));
  console.log('Nullifier:', nullifier);
  
  // Compute zero hashes and root
  const TREE_DEPTH = 18;
  const zeros = ['0'];
  for (let i = 0; i < TREE_DEPTH; i++) {
    const prev = BigInt(zeros[i]);
    const hash = poseidon.F.toString(poseidon([prev, prev]));
    zeros.push(hash);
  }
  
  const pathElements = zeros.slice(0, TREE_DEPTH);
  const pathIndices = Array(TREE_DEPTH).fill(0);
  
  // Compute root
  let currentHash = BigInt(commitment);
  for (let i = 0; i < TREE_DEPTH; i++) {
    const sibling = BigInt(pathElements[i]);
    currentHash = BigInt(poseidon.F.toString(poseidon([currentHash, sibling])));
  }
  const root = currentHash.toString();
  console.log('Root:', root);
  
  // Create circuit input
  const circuitInput = {
    root,
    nullifier,
    daoId: daoId.toString(),
    proposalId: proposalId.toString(),
    voteChoice: voteChoice.toString(),
    secret: secret.toString(),
    salt: salt.toString(),
    pathElements: pathElements.map(e => e.toString()),
    pathIndices
  };
  
  fs.writeFileSync('build/test_input.json', JSON.stringify(circuitInput, null, 2));
  console.log('\nCircuit input saved to build/test_input.json');
  
  // Generate witness
  console.log('\nGenerating witness...');
  await snarkjs.wtns.calculate(
    circuitInput,
    'build/vote_js/vote.wasm',
    'build/witness.wtns'
  );
  console.log('Witness generated!');
  
  // Generate proof
  console.log('\nGenerating proof (this may take 10-30 seconds)...');
  const { proof, publicSignals } = await snarkjs.groth16.prove(
    'build/vote_final.zkey',
    'build/witness.wtns'
  );
  
  fs.writeFileSync('build/proof.json', JSON.stringify(proof, null, 2));
  fs.writeFileSync('build/public.json', JSON.stringify(publicSignals, null, 2));
  console.log('Proof generated!');
  
  console.log('\nPublic signals:');
  console.log('  root:', publicSignals[0]);
  console.log('  nullifier:', publicSignals[1]);
  console.log('  daoId:', publicSignals[2]);
  console.log('  proposalId:', publicSignals[3]);
  console.log('  voteChoice:', publicSignals[4]);
  
  // Convert proof to Soroban format (BIG-ENDIAN as per CAP-74)
  const toHexBE = (value) => {
    const bigInt = BigInt(value);
    return bigInt.toString(16).padStart(64, '0');
  };

  // G1 point: X || Y (big-endian)
  const proof_a = toHexBE(proof.pi_a[0]) + toHexBE(proof.pi_a[1]);
  // G2 point: X_c1 || X_c0 || Y_c1 || Y_c0 (imaginary first, big-endian)
  const proof_b = toHexBE(proof.pi_b[0][1]) + toHexBE(proof.pi_b[0][0]) +
                  toHexBE(proof.pi_b[1][1]) + toHexBE(proof.pi_b[1][0]);
  const proof_c = toHexBE(proof.pi_c[0]) + toHexBE(proof.pi_c[1]);
  
  const sorobanProof = { a: proof_a, b: proof_b, c: proof_c };
  fs.writeFileSync('build/proof_soroban.json', JSON.stringify(sorobanProof, null, 2));
  console.log('\nProof converted to Soroban format!');
  console.log('Saved to build/proof_soroban.json');
  
  // Save test data summary
  const testData = {
    secret: secret.toString(),
    salt: salt.toString(),
    commitment,
    daoId: daoId.toString(),
    proposalId: proposalId.toString(),
    nullifier,
    root,
    proof_soroban: sorobanProof
  };
  fs.writeFileSync('build/test_data.json', JSON.stringify(testData, null, 2));
  console.log('\nTest data summary saved to build/test_data.json');
})();
