// Debug a single vote to see the full proof inputs
const snarkjs = require('snarkjs');
const { buildPoseidon } = require('circomlibjs');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIPT_DIR = '/Users/ash/code/zkvote/scripts/test/stress-accounts';
const PROJECT_ROOT = '/Users/ash/code/zkvote';

const CONFIG = {
  DAO_ID: 1,
  PROPOSAL_ID: 1,  // Fresh proposal on new contracts
  ROOT_DECIMAL: null,  // Fetched at runtime
  TREE_CONTRACT: 'CADQ4A4ZI5N6SERIE34NU5XGRLPUMKXBKN2DMKCWASMXN3CFIOAW3NKF',
  RPC_URL: 'https://rpc-futurenet.stellar.org',
  NETWORK_PASSPHRASE: 'Test SDF Future Network ; October 2022',
  WASM_PATH: path.join(PROJECT_ROOT, 'circuits/build/vote_js/vote.wasm'),
  ZKEY_PATH: path.join(PROJECT_ROOT, 'circuits/build/vote_final.zkey'),
  COMMITMENTS_FILE: path.join(SCRIPT_DIR, 'commitments.csv'),
  TREE_DEPTH: 18,
};

function loadCommitments() {
  const content = fs.readFileSync(CONFIG.COMMITMENTS_FILE, 'utf-8');
  const commitments = new Map();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const [key, secret, salt, commitment] = line.split(',');
    const idx = parseInt(key.replace('stresstest-', ''));
    commitments.set(idx, { secret, salt, commitment });
  }
  return commitments;
}

function getLeafIndex(commitment) {
  const result = execSync(`stellar contract invoke \
    --rpc-url "${CONFIG.RPC_URL}" \
    --network-passphrase "${CONFIG.NETWORK_PASSPHRASE}" \
    --source mykey \
    --id ${CONFIG.TREE_CONTRACT} \
    -- get_leaf_index --dao_id ${CONFIG.DAO_ID} --commitment "${commitment}" 2>&1`,
    { encoding: 'utf-8', timeout: 30000 }
  );
  const lines = result.trim().split('\n');
  return parseInt(lines[lines.length - 1]);
}

function getMerklePath(leafIndex) {
  const result = execSync(`stellar contract invoke \
    --rpc-url "${CONFIG.RPC_URL}" \
    --network-passphrase "${CONFIG.NETWORK_PASSPHRASE}" \
    --source mykey \
    --id ${CONFIG.TREE_CONTRACT} \
    -- get_merkle_path --dao_id ${CONFIG.DAO_ID} --leaf_index ${leafIndex} 2>&1`,
    { encoding: 'utf-8', timeout: 30000 }
  );
  const lines = result.trim().split('\n');
  const lastLine = lines[lines.length - 1];
  const parsed = JSON.parse(lastLine);
  return {
    pathElements: parsed[0].map(e => e.toString()),
    pathIndices: parsed[1].map(e => parseInt(e)),
  };
}

// Fetch current merkle root from contract
function getMerkleRoot() {
  try {
    const result = execSync(`stellar contract invoke \
      --rpc-url "${CONFIG.RPC_URL}" \
      --network-passphrase "${CONFIG.NETWORK_PASSPHRASE}" \
      --source mykey \
      --id ${CONFIG.TREE_CONTRACT} \
      -- get_root --dao_id ${CONFIG.DAO_ID} 2>&1`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    const lines = result.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    // Parse U256 output - it's a quoted decimal string
    return lastLine.replace(/"/g, '').trim();
  } catch (e) {
    console.error('Failed to get merkle root:', e.message);
    return null;
  }
}

async function calculateNullifier(poseidon, secret, daoId, proposalId) {
  const hash = poseidon([BigInt(secret), BigInt(daoId), BigInt(proposalId)]);
  const nullifierBigInt = poseidon.F.toObject(hash);
  return nullifierBigInt.toString();  // Return decimal for circuit
}

async function main() {
  const poseidon = await buildPoseidon();
  const commitments = loadCommitments();

  // Fetch merkle root dynamically
  console.log('Fetching merkle root from contract...');
  CONFIG.ROOT_DECIMAL = getMerkleRoot();
  if (!CONFIG.ROOT_DECIMAL) {
    console.error('Failed to fetch merkle root. Exiting.');
    process.exit(1);
  }
  console.log(`Root (decimal): ${CONFIG.ROOT_DECIMAL}`);

  // Test with account 1
  const account = commitments.get(1);
  console.log('\n=== Account 1 Data ===');
  console.log('Secret:', account.secret.slice(0, 20) + '...');
  console.log('Salt:', account.salt.slice(0, 20) + '...');
  console.log('Commitment:', account.commitment);

  const leafIndex = getLeafIndex(account.commitment);
  console.log('\nLeaf Index:', leafIndex);
  
  const merklePath = getMerklePath(leafIndex);
  console.log('\n=== Merkle Path (first 5) ===');
  console.log('Elements:', merklePath.pathElements.slice(0, 5).map(e => e.slice(0, 20) + '...'));
  console.log('Indices:', merklePath.pathIndices.slice(0, 5));
  console.log('Full path length:', merklePath.pathElements.length);
  
  // Pad to tree depth
  const paddedPathElements = [...merklePath.pathElements];
  const paddedPathIndices = [...merklePath.pathIndices];
  while (paddedPathElements.length < CONFIG.TREE_DEPTH) {
    paddedPathElements.push('0');
    paddedPathIndices.push(0);
  }
  
  const nullifier = await calculateNullifier(poseidon, account.secret, CONFIG.DAO_ID, CONFIG.PROPOSAL_ID);
  console.log('\nNullifier:', nullifier.slice(0, 20) + '...');
  
  const circuitInput = {
    root: CONFIG.ROOT_DECIMAL,
    nullifier: nullifier,
    daoId: CONFIG.DAO_ID.toString(),
    proposalId: CONFIG.PROPOSAL_ID.toString(),
    voteChoice: '1',
    commitment: account.commitment,
    secret: account.secret,
    salt: account.salt,
    pathElements: paddedPathElements,
    pathIndices: paddedPathIndices,
  };
  
  console.log('\n=== Circuit Input ===');
  console.log('root:', circuitInput.root.slice(0, 20) + '...');
  console.log('nullifier:', circuitInput.nullifier.slice(0, 20) + '...');
  console.log('commitment:', circuitInput.commitment.slice(0, 20) + '...');
  
  console.log('\n=== Generating Proof ===');
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    CONFIG.WASM_PATH,
    CONFIG.ZKEY_PATH
  );
  
  console.log('Public signals:', publicSignals);
  console.log('\nProof pi_a:', proof.pi_a.map(p => p.toString().slice(0, 20) + '...'));
  
  // Verify locally
  console.log('\n=== Local Verification ===');
  const vkeyPath = path.join(PROJECT_ROOT, 'circuits/build/vote_verification_key.json');
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf-8'));
  const verified = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log('Local verification:', verified ? 'PASSED' : 'FAILED');
}

main().catch(console.error);
