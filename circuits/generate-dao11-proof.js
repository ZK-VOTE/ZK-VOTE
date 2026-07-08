const { buildPoseidon } = require('circomlibjs');
const snarkjs = require('snarkjs');
const fs = require('fs');

(async () => {
  const poseidon = await buildPoseidon();
  
  // Generate test credentials (same as registered)
  const secret = BigInt('999888777666');
  const salt = BigInt('111222333444');
  const daoId = BigInt('11');  // DAO 11
  const proposalId = BigInt('1');  // Proposal 1
  const voteChoice = BigInt('1');  // Vote YES
  
  // Compute commitment (must match registered value)
  const commitment = poseidon.F.toString(poseidon([secret, salt]));
  console.log('Commitment:', commitment);
  
  // Compute nullifier for DAO 11, Proposal 1
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
  
  fs.writeFileSync('build/dao11_input.json', JSON.stringify(circuitInput, null, 2));
  console.log('\nCircuit input saved to build/dao11_input.json');
  
  // Generate witness
  console.log('\nGenerating witness...');
  await snarkjs.wtns.calculate(
    circuitInput,
    'build/vote_js/vote.wasm',
    'build/dao11_witness.wtns'
  );
  console.log('Witness generated!');
  
  // Generate proof
  console.log('\nGenerating proof (this may take 10-30 seconds)...');
  const { proof, publicSignals } = await snarkjs.groth16.prove(
    'build/vote_final.zkey',
    'build/dao11_witness.wtns'
  );
  
  fs.writeFileSync('build/dao11_proof.json', JSON.stringify(proof, null, 2));
  fs.writeFileSync('build/dao11_public.json', JSON.stringify(publicSignals, null, 2));
  console.log('Proof generated!');
  
  console.log('\nPublic signals:');
  console.log('  root:', publicSignals[0]);
  console.log('  nullifier:', publicSignals[1]);
  console.log('  daoId:', publicSignals[2]);
  console.log('  proposalId:', publicSignals[3]);
  console.log('  voteChoice:', publicSignals[4]);
  
  // Convert proof to Soroban format
  const toHexLE = (value) => {
    const bigInt = BigInt(value);
    const hex = bigInt.toString(16).padStart(64, '0');
    return hex.match(/.{2}/g).reverse().join('');
  };
  
  const proof_a = toHexLE(proof.pi_a[0]) + toHexLE(proof.pi_a[1]);
  const proof_b = toHexLE(proof.pi_b[0][0]) + toHexLE(proof.pi_b[0][1]) +
                  toHexLE(proof.pi_b[1][0]) + toHexLE(proof.pi_b[1][1]);
  const proof_c = toHexLE(proof.pi_c[0]) + toHexLE(proof.pi_c[1]);
  
  const sorobanProof = { a: proof_a, b: proof_b, c: proof_c };
  fs.writeFileSync('build/dao11_proof_soroban.json', JSON.stringify(sorobanProof, null, 2));
  console.log('\nProof converted to Soroban format!');
  console.log('Saved to build/dao11_proof_soroban.json');
  
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
  fs.writeFileSync('build/dao11_test_data.json', JSON.stringify(testData, null, 2));
  console.log('\nTest data summary saved to build/dao11_test_data.json');
})();
