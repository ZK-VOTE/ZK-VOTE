const { buildPoseidon } = require("circomlibjs");
const crypto = require("crypto");
const fs = require("fs");

const TREE_DEPTH = 18;

let poseidon;

// Initialize poseidon (must be called before using)
async function initPoseidon() {
  poseidon = await buildPoseidon();
}

// Generate random field element (BN254 scalar field)
function randomFieldElement() {
  // BN254 scalar field order
  const FIELD_SIZE = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");
  const bytes = crypto.randomBytes(32);
  const num = BigInt("0x" + bytes.toString("hex"));
  return num % FIELD_SIZE;
}

// Compute Poseidon hash (compatible with Stellar's on-chain Poseidon)
function poseidonHash(inputs) {
  const hash = poseidon(inputs.map(x => poseidon.F.e(x)));
  return poseidon.F.toObject(hash);
}

// Generate identity commitment
function generateIdentity() {
  const secret = randomFieldElement();
  const salt = randomFieldElement();
  const commitment = poseidonHash([secret, salt]);
  return { secret, salt, commitment };
}

// Compute nullifier for a proposal (domain-separated with daoId)
// Includes daoId to prevent cross-DAO nullifier linkability
function computeNullifier(secret, daoId, proposalId) {
  return poseidonHash([secret, BigInt(daoId), BigInt(proposalId)]);
}

// Build Merkle tree from leaves
function buildMerkleTree(leaves) {
  const depth = TREE_DEPTH;
  const layers = [leaves];

  // Pad to next power of 2 if needed
  const treeSize = Math.pow(2, depth);
  const paddedLeaves = [...leaves];

  // Compute zero values for empty leaves
  let zeroValue = BigInt(0);
  const zeros = [zeroValue];
  for (let i = 1; i <= depth; i++) {
    zeroValue = poseidonHash([zeroValue, zeroValue]);
    zeros.push(zeroValue);
  }

  // Pad with zeros
  while (paddedLeaves.length < treeSize) {
    paddedLeaves.push(zeros[0]);
  }
  layers[0] = paddedLeaves;

  // Build tree layers
  let currentLayer = paddedLeaves;
  for (let level = 0; level < depth; level++) {
    const nextLayer = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      const left = currentLayer[i];
      const right = currentLayer[i + 1];
      const parent = poseidonHash([left, right]);
      nextLayer.push(parent);
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return { layers, root: layers[depth][0], zeros };
}

// Get Merkle proof for a leaf at index
function getMerkleProof(tree, leafIndex) {
  const { layers } = tree;
  const pathElements = [];
  const pathIndices = [];

  let idx = leafIndex;
  for (let level = 0; level < TREE_DEPTH; level++) {
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    pathElements.push(layers[level][siblingIdx]);
    pathIndices.push(idx % 2); // 0 if left, 1 if right
    idx = Math.floor(idx / 2);
  }

  return { pathElements, pathIndices };
}

// Generate complete vote input
function generateVoteInput(memberSecrets, voterIndex, daoId, proposalId, voteChoice) {
  // Get voter's identity
  const voter = memberSecrets[voterIndex];

  // Build tree from all commitments
  const commitments = memberSecrets.map(m => m.commitment);
  const tree = buildMerkleTree(commitments);

  // Get Merkle proof
  const proof = getMerkleProof(tree, voterIndex);

  // Compute nullifier (domain-separated with daoId)
  const nullifier = computeNullifier(voter.secret, daoId, proposalId);

  // Build input object
  const input = {
    // Public inputs (order must match circuit: root, nullifier, daoId, proposalId, voteChoice)
    root: tree.root.toString(),
    nullifier: nullifier.toString(),
    daoId: daoId.toString(),
    proposalId: proposalId.toString(),
    voteChoice: voteChoice.toString(),

    // Private inputs
    secret: voter.secret.toString(),
    salt: voter.salt.toString(),
    pathElements: proof.pathElements.map(e => e.toString()),
    pathIndices: proof.pathIndices.map(i => i.toString())
  };

  return { input, tree, nullifier };
}

// Example usage / CLI
if (require.main === module) {
  (async () => {
    console.log("DaoVote Input Generator\n");

    // Initialize poseidon
    console.log("Initializing Poseidon hash...");
    await initPoseidon();

    // Example: Create 3 DAO members
    console.log("Creating 3 DAO members...");
    const members = [
      generateIdentity(),
      generateIdentity(),
      generateIdentity()
    ];

    console.log("Member commitments:");
    members.forEach((m, i) => {
      console.log(`  Member ${i}: ${m.commitment.toString().slice(0, 20)}...`);
    });

    // Member 1 votes FOR proposal 42 in DAO 1
    const voterIndex = 1;
    const daoId = 1;
    const proposalId = 42;
    const voteChoice = 1; // FOR

    console.log(`\nGenerating vote input for member ${voterIndex}...`);
    console.log(`  DAO ID: ${daoId}`);
    console.log(`  Proposal ID: ${proposalId}`);
    console.log(`  Vote choice: ${voteChoice === 1 ? "FOR" : "AGAINST"}`);

    const { input, tree, nullifier } = generateVoteInput(
      members,
      voterIndex,
      daoId,
      proposalId,
      voteChoice
    );

    console.log(`\nMerkle root: ${tree.root.toString().slice(0, 30)}...`);
    console.log(`Nullifier: ${nullifier.toString().slice(0, 30)}...`);

    // Save to file
    const outputFile = "input.json";
    fs.writeFileSync(outputFile, JSON.stringify(input, null, 2));
    console.log(`\nInput saved to ${outputFile}`);

    // Also save member secrets for testing
    const secretsFile = "test_members.json";
    const secretsData = members.map(m => ({
      secret: m.secret.toString(),
      salt: m.salt.toString(),
      commitment: m.commitment.toString()
    }));
    fs.writeFileSync(secretsFile, JSON.stringify(secretsData, null, 2));
    console.log(`Member secrets saved to ${secretsFile}`);

    console.log("\nTo generate proof, run: ./generate_proof.sh");
  })().catch(err => {
    console.error("Error:", err);
    process.exit(1);
  });
}

module.exports = {
  initPoseidon,
  generateIdentity,
  computeNullifier,
  buildMerkleTree,
  getMerkleProof,
  generateVoteInput,
  poseidonHash,
  randomFieldElement,
  TREE_DEPTH
};
