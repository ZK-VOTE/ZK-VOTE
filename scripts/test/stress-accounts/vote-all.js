// Stress test voting script - Generate ZK proofs and vote for 100 accounts
const snarkjs = require('snarkjs');
const { buildPoseidon } = require('circomlibjs');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIPT_DIR = '/Users/ash/code/zkvote/scripts/test/stress-accounts';
const PROJECT_ROOT = '/Users/ash/code/zkvote';

// Configuration
const CONFIG = {
  DAO_ID: 1,
  PROPOSAL_ID: 2,  // Proposal 2 for stress test (proposal 1 already tested)
  // Root will be fetched dynamically from the contract
  ROOT_DECIMAL: null,  // Populated at runtime
  TREE_CONTRACT: 'CC2GRLKCBCRNAUKKVHKJBJPVKTMZ5YY2DXN67HZGRC5D67MN6Y6VQ7ZX',
  RPC_URL: 'https://rpc-futurenet.stellar.org',
  NETWORK_PASSPHRASE: 'Test SDF Future Network ; October 2022',
  RELAYER_URL: 'http://localhost:3001',
  RELAYER_AUTH_TOKEN: 'f12868935d8ca4f4e275b8dbb842d6c4b4fb88d7e4527e43758e35db4f5f5ea4',
  WASM_PATH: path.join(PROJECT_ROOT, 'circuits/build/vote_js/vote.wasm'),
  ZKEY_PATH: path.join(PROJECT_ROOT, 'circuits/build/vote_final.zkey'),
  COMMITMENTS_FILE: path.join(SCRIPT_DIR, 'commitments.csv'),
  VOTED_FILE: path.join(SCRIPT_DIR, 'voted.txt'),
  TREE_DEPTH: 18,
};

// Convert decimal to hex (64 chars, no 0x prefix)
function decimalToHex(decimalStr) {
  return BigInt(decimalStr).toString(16).padStart(64, '0');
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

// Parse commitments from CSV
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

// Load already voted accounts
function loadVoted() {
  if (!fs.existsSync(CONFIG.VOTED_FILE)) {
    return new Set();
  }
  const content = fs.readFileSync(CONFIG.VOTED_FILE, 'utf-8');
  const voted = new Set();
  for (const line of content.split('\n')) {
    const idx = parseInt(line.trim());
    if (!isNaN(idx)) voted.add(idx);
  }
  return voted;
}

// Get leaf index from contract
function getLeafIndex(commitment) {
  try {
    const result = execSync(`stellar contract invoke \
      --rpc-url "${CONFIG.RPC_URL}" \
      --network-passphrase "${CONFIG.NETWORK_PASSPHRASE}" \
      --source mykey \
      --id ${CONFIG.TREE_CONTRACT} \
      -- get_leaf_index --dao_id ${CONFIG.DAO_ID} --commitment "${commitment}" 2>&1`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    // Parse the leaf index from the output (last line)
    const lines = result.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    return parseInt(lastLine);
  } catch (e) {
    console.error('Failed to get leaf index:', e.message);
    return null;
  }
}

// Get merkle path from contract
function getMerklePath(leafIndex) {
  try {
    const result = execSync(`stellar contract invoke \
      --rpc-url "${CONFIG.RPC_URL}" \
      --network-passphrase "${CONFIG.NETWORK_PASSPHRASE}" \
      --source mykey \
      --id ${CONFIG.TREE_CONTRACT} \
      -- get_merkle_path --dao_id ${CONFIG.DAO_ID} --leaf_index ${leafIndex} 2>&1`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    // Parse the output - it's a tuple of (Vec<U256>, Vec<u32>)
    const lines = result.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    // Parse JSON array output
    const parsed = JSON.parse(lastLine);
    return {
      pathElements: parsed[0].map(e => e.toString()),
      pathIndices: parsed[1].map(e => parseInt(e)),
    };
  } catch (e) {
    console.error('Failed to get merkle path:', e.message);
    return null;
  }
}

// Calculate nullifier: Poseidon(secret, daoId, proposalId)
// Returns hex string (64 chars, no 0x prefix) for relayer
async function calculateNullifier(poseidon, secret, daoId, proposalId) {
  const hash = poseidon([BigInt(secret), BigInt(daoId), BigInt(proposalId)]);
  const nullifierBigInt = poseidon.F.toObject(hash);
  return nullifierBigInt.toString(16).padStart(64, '0');
}

// Format proof for Soroban (BIG-ENDIAN)
function formatProofForSoroban(proof) {
  const toHexBE = (value) => {
    const bigInt = BigInt(value);
    return bigInt.toString(16).padStart(64, '0');
  };

  // pi_a: X || Y
  const proof_a = toHexBE(proof.pi_a[0]) + toHexBE(proof.pi_a[1]);

  // pi_b: X_c1 || X_c0 || Y_c1 || Y_c0
  const proof_b =
    toHexBE(proof.pi_b[0][1]) +  // X.c1
    toHexBE(proof.pi_b[0][0]) +  // X.c0
    toHexBE(proof.pi_b[1][1]) +  // Y.c1
    toHexBE(proof.pi_b[1][0]);   // Y.c0

  // pi_c: X || Y
  const proof_c = toHexBE(proof.pi_c[0]) + toHexBE(proof.pi_c[1]);

  return { proof_a, proof_b, proof_c };
}

// Submit vote to relayer
async function submitVote(daoId, proposalId, choice, nullifier, root, commitment, proof) {
  const response = await fetch(`${CONFIG.RELAYER_URL}/vote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Relayer-Auth': CONFIG.RELAYER_AUTH_TOKEN,
    },
    body: JSON.stringify({
      daoId,
      proposalId,
      choice,
      nullifier,
      root,
      commitment,
      proof,
    }),
  });

  const result = await response.json();
  return { ok: response.ok, result };
}

async function main() {
  console.log('=== Stress Test Voting ===');
  console.log(`DAO: ${CONFIG.DAO_ID}, Proposal: ${CONFIG.PROPOSAL_ID}`);

  // Fetch merkle root dynamically
  console.log('Fetching merkle root from contract...');
  CONFIG.ROOT_DECIMAL = getMerkleRoot();
  if (!CONFIG.ROOT_DECIMAL) {
    console.error('Failed to fetch merkle root. Exiting.');
    process.exit(1);
  }
  const ROOT_HEX = decimalToHex(CONFIG.ROOT_DECIMAL);

  console.log(`Root (decimal): ${CONFIG.ROOT_DECIMAL}`);
  console.log(`Root (hex): ${ROOT_HEX}`);

  // Initialize Poseidon
  const poseidon = await buildPoseidon();

  // Load commitments and voted accounts
  const commitments = loadCommitments();
  const voted = loadVoted();

  console.log(`Loaded ${commitments.size} commitments`);
  console.log(`Already voted: ${voted.size}`);

  // Process each account
  let success = 0;
  let fail = 0;

  for (let i = 1; i <= 100; i++) {
    if (voted.has(i)) {
      console.log(`  ${i}: SKIP (already voted)`);
      continue;
    }

    const account = commitments.get(i);
    if (!account) {
      console.log(`  ${i}: SKIP (no commitment)`);
      fail++;
      continue;
    }

    process.stdout.write(`  ${i}: `);

    try {
      // Get leaf index
      const leafIndex = getLeafIndex(account.commitment);
      if (leafIndex === null) {
        console.log('FAIL (leaf index)');
        fail++;
        continue;
      }
      process.stdout.write(`leaf=${leafIndex}... `);

      // Get merkle path
      const merklePath = getMerklePath(leafIndex);
      if (!merklePath) {
        console.log('FAIL (merkle path)');
        fail++;
        continue;
      }
      process.stdout.write('path... ');

      // Calculate nullifier
      const nullifier = await calculateNullifier(
        poseidon,
        account.secret,
        CONFIG.DAO_ID,
        CONFIG.PROPOSAL_ID
      );
      process.stdout.write('nullifier... ');

      // Pad pathElements and pathIndices to TREE_DEPTH
      const paddedPathElements = [...merklePath.pathElements];
      const paddedPathIndices = [...merklePath.pathIndices];
      while (paddedPathElements.length < CONFIG.TREE_DEPTH) {
        paddedPathElements.push('0');
        paddedPathIndices.push(0);
      }

      // Vote choice (alternate for stress test)
      const voteChoice = i % 2 === 0 ? '1' : '0';  // Yes for even, No for odd

      // Generate ZK proof (circuit uses decimal values)
      const circuitInput = {
        root: CONFIG.ROOT_DECIMAL,
        nullifier: BigInt('0x' + nullifier).toString(),  // Convert hex back to decimal for circuit
        daoId: CONFIG.DAO_ID.toString(),
        proposalId: CONFIG.PROPOSAL_ID.toString(),
        voteChoice: voteChoice,
        commitment: account.commitment,  // Already decimal from CSV
        secret: account.secret,
        salt: account.salt,
        pathElements: paddedPathElements,
        pathIndices: paddedPathIndices,
      };

      process.stdout.write('proving... ');
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        circuitInput,
        CONFIG.WASM_PATH,
        CONFIG.ZKEY_PATH
      );

      // Format for Soroban
      const sorobanProof = formatProofForSoroban(proof);

      process.stdout.write('voting... ');
      // Submit to relayer (all U256 values in hex format)
      const commitmentHex = decimalToHex(account.commitment);
      const { ok, result } = await submitVote(
        CONFIG.DAO_ID,
        CONFIG.PROPOSAL_ID,
        voteChoice === '1',  // Boolean
        nullifier,          // Already hex from calculateNullifier
        ROOT_HEX,           // Hex format for relayer
        commitmentHex,      // Hex format for relayer
        { a: sorobanProof.proof_a, b: sorobanProof.proof_b, c: sorobanProof.proof_c }
      );

      if (ok) {
        console.log('OK');
        fs.appendFileSync(CONFIG.VOTED_FILE, `${i}\n`);
        success++;
      } else {
        console.log(`FAIL (${result.error || JSON.stringify(result)})`);
        fail++;
      }

    } catch (e) {
      console.log(`FAIL (${e.message})`);
      fail++;
    }

    // Small delay between votes
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n=== Results: ${success} success, ${fail} failed ===`);
}

main().catch(console.error);
