const circomlibjs = require('circomlibjs');

(async function() {
  const poseidon = await circomlibjs.buildPoseidon();

  // Test values
  const secret = 123456789n;
  const salt = 987654321n;
  const daoId = 1n;
  const proposalId = 1n;
  const voteChoice = 1n;

  // Compute commitment
  const commitment = poseidon.F.toObject(poseidon([secret, salt]));
  console.log('Commitment:', commitment.toString());
  console.log('Commitment (hex):', '0x' + commitment.toString(16).padStart(64, '0'));

  // Compute nullifier
  const nullifier = poseidon.F.toObject(poseidon([secret, daoId, proposalId]));
  console.log('\nNullifier:', nullifier.toString());
  console.log('Nullifier (hex):', '0x' + nullifier.toString(16).padStart(64, '0'));

  // Compute zero values for Merkle tree (depth 18)
  const zeros = [0n];
  let currentZero = 0n;
  for (let i = 0; i < 18; i++) {
    currentZero = poseidon.F.toObject(poseidon([currentZero, currentZero]));
    zeros.push(currentZero);
  }

  // Compute root if commitment is at index 0 in empty tree
  let currentHash = commitment;
  let index = 0;
  const depth = 18;

  for (let i = 0; i < depth; i++) {
    if (index % 2 === 0) {
      // Left child
      currentHash = poseidon.F.toObject(poseidon([currentHash, zeros[i]]));
    } else {
      // Right child
      currentHash = poseidon.F.toObject(poseidon([zeros[i], currentHash]));
    }
    index = Math.floor(index / 2);
  }

  console.log('\nRoot (commitment at index 0):', currentHash.toString());
  console.log('Root (hex):', '0x' + currentHash.toString(16).padStart(64, '0'));

  // Generate full input.json
  const input = {
    root: currentHash.toString(),
    nullifier: nullifier.toString(),
    daoId: daoId.toString(),
    proposalId: proposalId.toString(),
    voteChoice: voteChoice.toString(),
    commitment: commitment.toString(),
    secret: secret.toString(),
    salt: salt.toString(),
    pathElements: zeros.slice(0, 18).map(z => z.toString()),
    pathIndices: Array(18).fill("0")
  };

  console.log('\n=== FULL INPUT JSON ===');
  console.log(JSON.stringify(input, null, 2));
})();
