const { buildPoseidon } = require('circomlibjs');
const snarkjs = require('snarkjs');
const fs = require('fs');

(async () => {
  const poseidon = await buildPoseidon();
  
  // Generate test credentials
  const secret = BigInt('999888777666');  // New test secret
  const salt = BigInt('111222333444');     // New test salt
  
  // Compute commitment
  const commitment = poseidon.F.toString(poseidon([secret, salt]));
  console.log('\n=== Fresh Test Data ===');
  console.log('Secret:', secret.toString());
  console.log('Salt:', salt.toString());
  console.log('Commitment:', commitment);
  
  // For DAO 1, Proposal 1
  const daoId = BigInt('1');
  const proposalId = BigInt('1');
  
  // Compute nullifier
  const nullifier = poseidon.F.toString(poseidon([secret, daoId, proposalId]));
  console.log('Nullifier:', nullifier);
  
  // For first leaf (index 0), all path elements are zeros
  const TREE_DEPTH = 18;
  const zeros = ['0'];
  for (let i = 0; i < TREE_DEPTH; i++) {
    const prev = BigInt(zeros[i]);
    const hash = poseidon.F.toString(poseidon([prev, prev]));
    zeros.push(hash);
  }
  
  const pathElements = zeros.slice(0, TREE_DEPTH);
  const pathIndices = Array(TREE_DEPTH).fill(0);
  
  // Compute expected root (for first leaf)
  let currentHash = BigInt(commitment);
  for (let i = 0; i < TREE_DEPTH; i++) {
    const sibling = BigInt(pathElements[i]);
    currentHash = BigInt(poseidon.F.toString(poseidon([currentHash, sibling])));
  }
  console.log('Expected root:', currentHash.toString());
  
  // Save test data
  const testData = {
    secret: secret.toString(),
    salt: salt.toString(),
    commitment: commitment.toString(),
    daoId: daoId.toString(),
    proposalId: proposalId.toString(),
    nullifier: nullifier.toString(),
    root: currentHash.toString(),
    pathElements: pathElements.map(e => e.toString()),
    pathIndices: pathIndices
  };
  
  fs.writeFileSync('/tmp/fresh-test-data.json', JSON.stringify(testData, null, 2));
  console.log('\nSaved to /tmp/fresh-test-data.json');
})();
