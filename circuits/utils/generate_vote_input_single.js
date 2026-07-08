#!/usr/bin/env node
// Generate vote input for a single-member tree (for e2e testing)
// Takes CLI args: secret salt commitment root daoId proposalId voteChoice

const { buildPoseidon } = require("circomlibjs");
const fs = require("fs");

const TREE_DEPTH = 18;

if (process.argv.length < 9) {
  console.error("Usage: node generate_vote_input_single.js <secret> <salt> <commitment> <root> <daoId> <proposalId> <voteChoice>");
  process.exit(1);
}

const [secret, salt, commitment, root, daoId, proposalId, voteChoice] = process.argv.slice(2);

(async () => {
  const poseidon = await buildPoseidon();

  function poseidonHash(inputs) {
    const hash = poseidon(inputs.map(x => poseidon.F.e(BigInt(x))));
    return poseidon.F.toObject(hash);
  }

  // Compute nullifier (matches on-chain computation)
  const nullifier = poseidonHash([secret, daoId, proposalId]);

  // For a single-member tree, the commitment is at index 0
  // Build Merkle path from leaf to root
  // Path consists of zeros at each level

  // Compute zero values
  let zeroValue = BigInt(0);
  const zeros = [zeroValue];
  for (let i = 1; i <= TREE_DEPTH; i++) {
    zeroValue = poseidonHash([zeroValue, zeroValue]);
    zeros.push(zeroValue);
  }

  // For index 0 (leftmost leaf), all siblings are zeros
  // Path indices are all 0 (we're always the left child)
  const pathElements = [];
  const pathIndices = [];

  for (let level = 0; level < TREE_DEPTH; level++) {
    pathElements.push(zeros[level].toString());
    pathIndices.push("0"); // Always left (since we're at index 0)
  }

  // Build input object
  const input = {
    // Public inputs
    root: root,
    nullifier: nullifier.toString(),
    daoId: daoId,
    proposalId: proposalId,
    voteChoice: voteChoice,
    commitment: commitment,

    // Private inputs
    secret: secret,
    salt: salt,
    pathElements: pathElements,
    pathIndices: pathIndices
  };

  // Save to file
  const outputFile = "input.json";
  fs.writeFileSync(outputFile, JSON.stringify(input, null, 2));

  console.log("Vote input generated:");
  console.log(`  Nullifier: ${nullifier.toString().slice(0, 30)}...`);
  console.log(`  Root: ${root.slice(0, 30)}...`);
  console.log(`  DAO ID: ${daoId}`);
  console.log(`  Proposal ID: ${proposalId}`);
  console.log(`  Vote: ${voteChoice === "1" ? "FOR" : "AGAINST"}`);
  console.log(`\nSaved to ${outputFile}`);
})().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
