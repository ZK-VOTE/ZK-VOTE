// Compare Poseidon hash between circomlibjs and what the contract expects
const { buildPoseidon } = require('circomlibjs');

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Test 1: Basic hash of (0, 0)
  console.log('=== Test 1: Hash(0, 0) ===');
  const hash00 = poseidon([0n, 0n]);
  console.log('Hash(0, 0) =', F.toObject(hash00).toString());

  // Test 2: Hash using a commitment from the file
  // stresstest-1: secret=5404767744274070549062614070052295427377118842892241189003786448122088284215
  //              salt=15300486107754156183933775430404777880560988292591417385470398521014650772513
  //              commitment=5116015878821220063368661520781417837494471498012103484731409461874375532798
  console.log('\n=== Test 2: Commitment verification ===');
  const secret1 = 5404767744274070549062614070052295427377118842892241189003786448122088284215n;
  const salt1 = 15300486107754156183933775430404777880560988292591417385470398521014650772513n;
  const expectedCommitment1 = 5116015878821220063368661520781417837494471498012103484731409461874375532798n;

  const computed1 = poseidon([secret1, salt1]);
  const result1 = F.toObject(computed1);
  console.log('Expected commitment:', expectedCommitment1.toString());
  console.log('Computed commitment:', result1.toString());
  console.log('Match:', result1 === expectedCommitment1);

  // Test 3: Look at what the circuit expects for merkle hashing
  // In merkle_tree.circom, it uses Poseidon(2) with inputs [left, right]
  // Let's see what circomlibjs does with two inputs
  console.log('\n=== Test 3: Merkle hash (left=0, right=commitment1) ===');
  const left = 0n;
  const right = expectedCommitment1;
  const merkleHash = poseidon([left, right]);
  console.log('Poseidon([0, commitment1]) =', F.toObject(merkleHash).toString());

  // Test 4: Try what the contract is doing - sponge with state = [0, left, right]
  // This is NOT the same as Poseidon([left, right]) !
  // The contract uses poseidon_permutation on [0, left, right] then takes state[0]
  // But circomlibjs Poseidon(2) uses a different construction
  console.log('\n=== Test 4: What circomlibjs Poseidon actually does ===');
  // circomlibjs Poseidon signature: poseidon(inputs)
  // Internally, it builds state = [0, inputs[0], inputs[1], ...] then runs permutation
  // Then returns state[0]

  // So the question is: does circomlibjs's Poseidon for 2 inputs use t=3?
  // Looking at circomlibjs source, for n inputs it uses t = n + 1
  // So Poseidon(2) uses t=3, which should match our contract!

  // Let's verify the constants...
  console.log('\nPoseidon nRoundsF:', poseidon.nRoundsF);
  console.log('Poseidon nRoundsP:', poseidon.nRoundsP);
  console.log('Poseidon t:', poseidon.t);  // This might not be directly accessible

  // Test 5: Check what the contract's hash_pair would compute
  // Contract does: state = [0, left, right], run permutation, return state[0]
  // circomlibjs does the same thing, so they should match if constants are the same

  console.log('\n=== Test 5: Verify MDS matrix constants ===');
  // First row of MDS from contract:
  const contractMDS = [
    '0x109b7f411ba0e4c9b2b70caf5c36a7b194be7c11ad24378bfedb68592ba8118b',
    '0x16ed41e13bb9c0c66ae119424fddbcbc9314dc9fdbdeea55d6c64543dc4903e0',
    '0x2b90bba00fca0589f617e7dcbfe82e0df706ab640ceb247b791a93b74e36736d',
  ];
  console.log('Contract MDS[0][0]:', contractMDS[0]);

  // circomlibjs MDS for t=3 should be in poseidon.M
  // Let's see if we can access it
  if (poseidon.M) {
    console.log('circomlibjs MDS[0][0]:', F.toObject(poseidon.M[0][0]).toString(16).padStart(64, '0'));
    console.log('circomlibjs MDS shape:', poseidon.M.length, 'x', poseidon.M[0].length);
  } else {
    console.log('poseidon.M not accessible');
  }

  // Test 6: The real issue - check how the contract builds the initial tree
  // When leaf_count=1, the tree should just have the commitment at leaf 0
  // Root = hash(commitment, zero) at level 0-1, then hash with zeros up to level 17
  console.log('\n=== Test 6: Simulate tree construction for depth=18 with 1 leaf ===');

  // Zero values for each level (precomputed by hashing zeros)
  const zeros = [0n];
  for (let i = 0; i < 18; i++) {
    zeros.push(F.toObject(poseidon([zeros[i], zeros[i]])));
  }
  console.log('Zero[0]:', zeros[0].toString());
  console.log('Zero[1] = Hash(0,0):', zeros[1].toString());
  console.log('Zero[2] = Hash(Z1,Z1):', zeros[2].toString());

  // Now build tree with just commitment1 at index 0
  let current = expectedCommitment1;
  console.log('\nBuilding tree path from leaf to root:');
  console.log('Leaf[0] =', current.toString());

  for (let level = 0; level < 18; level++) {
    // At level 0 with 1 leaf at index 0:
    // leaf is on the left (index 0 % 2 = 0), sibling is zero value at this level
    const pathBit = 0; // Always left for index 0
    let left, right;
    if (pathBit === 0) {
      left = current;
      right = zeros[level];
    } else {
      left = zeros[level];
      right = current;
    }
    current = F.toObject(poseidon([left, right]));
    console.log(`Level ${level}: Hash(${pathBit === 0 ? 'current' : 'zero'}, ${pathBit === 0 ? 'zero' : 'current'}) => ${current.toString().slice(0, 20)}...`);
  }
  console.log('\nFinal Root:', current.toString());

  // Test 7: What if the contract uses different zero values?
  console.log('\n=== Test 7: Check if contract uses same zero values ===');
  // In the contract, zeros might be computed differently
  // Let's see what Hash(0,0) gives us
  const zero1 = F.toObject(poseidon([0n, 0n]));
  console.log('Hash(0n, 0n):', zero1.toString());

  // What if the contract pre-loads zeros differently?
  // Actually, let me check the merkle path the contract returns
  console.log('\n=== IMPORTANT: The issue might be in path indices vs path elements ===');
  console.log('In vote-all.js, we pad pathElements and pathIndices to TREE_DEPTH=18');
  console.log('But the contract might use a different convention for the path');
}

main().catch(console.error);
