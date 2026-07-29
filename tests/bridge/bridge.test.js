/**
 * Bridge Circuit Tests
 *
 * Tests the bridge.circom circuit with mocked SBT state witness.
 */

const { buildMimcSponge, buildPoseidon } = require("circomlibjs");
const snarkjs = require("snarkjs");

// ============================================
// HELPERS
// ============================================

async function hashPoseidon(poseidon, inputs) {
  return poseidon(inputs);
}

async function buildMerkleTree(poseidon, leaves, levels) {
  const tree = new Array(levels).fill(null).map(() => []);

  // Build leaf level
  for (let i = 0; i < leaves.length; i++) {
    tree[0][i] = leaves[i];
  }

  // Pad to power of 2
  const totalLeaves = 2 ** levels;
  for (let i = leaves.length; i < totalLeaves; i++) {
    tree[0][i] = poseidon([0n]);
  }

  // Build internal nodes
  for (let level = 1; level < levels; level++) {
    for (let i = 0; i < totalLeaves / 2 ** level; i++) {
      const left = tree[level - 1][2 * i];
      const right = tree[level - 1][2 * i + 1];
      tree[level][i] = poseidon([left, right]);
    }
  }

  return {
    root: tree[levels - 1][0],
    getProof: (index) => {
      const proof = { pathElements: [], pathIndices: [] };
      let currentIndex = index;
      for (let level = 0; level < levels; level++) {
        const siblingIndex = currentIndex ^ 1;
        proof.pathElements.push(tree[level][siblingIndex] || 0n);
        proof.pathIndices.push(currentIndex & 1);
        currentIndex = Math.floor(currentIndex / 2);
      }
      return proof;
    },
  };
}

// ============================================
// TESTS
// ============================================

describe("Bridge Circuit", () => {
  let poseidon;

  beforeAll(async () => {
    poseidon = await buildPoseidon();
  });

  test("generates valid proof with mocked SBT state", async () => {
    // Setup parameters
    const DOMAIN_TAG = BigInt("19666041591797403834655481403982443037438503980743793537655983658411276515161");
    const secret = 12345n;
    const salt = 67890n;
    const blindingFactor = 54321n;
    const daoId = 1n;
    const proposalId = 1n;
    const voteChoice = 1n;
    const sbtContractAddr = 99999n;
    const memberAddr = 88888n;
    const levels = 4; // Small tree for testing

    // Compute commitment with domain separation
    const commitment = poseidon([DOMAIN_TAG, secret, salt, blindingFactor]);

    // Build voting Merkle tree
    const makeLeaf = (s, sa, bf) => poseidon([DOMAIN_TAG, s, sa, bf]);
    const votingLeaves = [commitment, makeLeaf(111n, 222n, 333n), makeLeaf(444n, 555n, 666n)];
    const votingTree = await buildMerkleTree(poseidon, votingLeaves, levels);
    const voteRoot = votingTree.root;
    const votingProof = votingTree.getProof(0);

    // Compute nullifier
    const nullifier = poseidon([secret, daoId, proposalId]);

    // Build SBT state tree
    const sbtLeaf = poseidon([sbtContractAddr, memberAddr, daoId, 1n]); // isActive = 1
    const sbtLeaves = [sbtLeaf, poseidon([1n, 2n, 3n, 1n]), poseidon([4n, 5n, 6n, 1n])];
    const sbtTree = await buildMerkleTree(poseidon, sbtLeaves, levels);
    const sbtRoot = sbtTree.root;
    const sbtProof = sbtTree.getProof(0);

    // Circuit inputs
    const input = {
      // Public inputs
      sbtContractAddr: sbtContractAddr.toString(),
      memberAddr: memberAddr.toString(),
      daoId: daoId.toString(),
      proposalId: proposalId.toString(),
      nullifier: nullifier.toString(),
      voteChoice: voteChoice.toString(),
      voteRoot: voteRoot.toString(),
      sbtRoot: sbtRoot.toString(),
      // Private inputs
      secret: secret.toString(),
      salt: salt.toString(),
      blindingFactor: blindingFactor.toString(),
      votingPathElements: votingProof.pathElements.map(String),
      votingPathIndices: votingProof.pathIndices.map(String),
      sbtPathElements: sbtProof.pathElements.map(String),
      sbtPathIndices: sbtProof.pathIndices.map(String),
      sbtLeaf: sbtLeaf.toString(),
    };

    // Generate witness
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      "build/bridge_js/bridge.wasm",
      "build/bridge_final.zkey"
    );

    // Verify public signals match expected
    expect(publicSignals[0]).toBe(sbtContractAddr.toString());
    expect(publicSignals[2]).toBe(daoId.toString());
    expect(publicSignals[3]).toBe(proposalId.toString());
    expect(publicSignals[4]).toBe(nullifier.toString());
    expect(publicSignals[5]).toBe(voteChoice.toString());

    // Verify proof
    const vKey = require("../../../circuits/build/verification_key.json");
    const verified = await snarkjs.groth16.verify(vKey, publicSignals, proof);
    expect(verified).toBe(true);
  });

  test("rejects invalid vote choice", async () => {
    const poseidon = await buildPoseidon();
    const DOMAIN_TAG = BigInt("19666041591797403834655481403982443037438503980743793537655983658411276515161");
    const levels = 4;

    const secret = 111n;
    const salt = 222n;
    const blindingFactor = 333n;
    const commitment = poseidon([DOMAIN_TAG, secret, salt, blindingFactor]);

    const votingLeaves = [commitment];
    const votingTree = await buildMerkleTree(poseidon, votingLeaves, levels);
    const votingProof = votingTree.getProof(0);

    const sbtLeaf = poseidon([1n, 2n, 3n, 1n]);
    const sbtLeaves = [sbtLeaf];
    const sbtTree = await buildMerkleTree(poseidon, sbtLeaves, levels);
    const sbtProof = sbtTree.getProof(0);

    const input = {
      sbtContractAddr: "1",
      memberAddr: "2",
      daoId: "3",
      proposalId: "1",
      nullifier: "12345",
      voteChoice: "2", // Invalid: not 0 or 1
      voteRoot: votingTree.root.toString(),
      sbtRoot: sbtTree.root.toString(),
      secret: secret.toString(),
      salt: salt.toString(),
      blindingFactor: blindingFactor.toString(),
      votingPathElements: votingProof.pathElements.map(String),
      votingPathIndices: votingProof.pathIndices.map(String),
      sbtPathElements: sbtProof.pathElements.map(String),
      sbtPathIndices: sbtProof.pathIndices.map(String),
      sbtLeaf: sbtLeaf.toString(),
    };

    await expect(
      snarkjs.groth16.fullProve(
        input,
        "build/bridge_js/bridge.wasm",
        "build/bridge_final.zkey"
      )
    ).rejects.toThrow();
  });

  test("rejects wrong SBT leaf (inactive member)", async () => {
    const poseidon = await buildPoseidon();
    const DOMAIN_TAG = BigInt("19666041591797403834655481403982443037438503980743793537655983658411276515161");
    const levels = 4;

    const secret = 111n;
    const salt = 222n;
    const blindingFactor = 333n;
    const commitment = poseidon([DOMAIN_TAG, secret, salt, blindingFactor]);

    const votingLeaves = [commitment];
    const votingTree = await buildMerkleTree(poseidon, votingLeaves, levels);
    const votingProof = votingTree.getProof(0);

    // SBT leaf with isActive = 0 (revoked)
    const sbtLeaf = poseidon([1n, 2n, 3n, 0n]);
    const sbtLeaves = [sbtLeaf];
    const sbtTree = await buildMerkleTree(poseidon, sbtLeaves, levels);
    const sbtProof = sbtTree.getProof(0);

    // Try to prove with isActive = 1 (but tree has isActive = 0)
    const input = {
      sbtContractAddr: "1",
      memberAddr: "2",
      daoId: "3",
      proposalId: "1",
      nullifier: "12345",
      voteChoice: "1",
      voteRoot: votingTree.root.toString(),
      sbtRoot: sbtTree.root.toString(),
      secret: secret.toString(),
      salt: salt.toString(),
      blindingFactor: blindingFactor.toString(),
      votingPathElements: votingProof.pathElements.map(String),
      votingPathIndices: votingProof.pathIndices.map(String),
      sbtPathElements: sbtProof.pathElements.map(String),
      sbtPathIndices: sbtProof.pathIndices.map(String),
      // Prover tries to use isActive = 1, but tree has 0
      sbtLeaf: poseidon([1n, 2n, 3n, 1n]).toString(),
    };

    await expect(
      snarkjs.groth16.fullProbe(
        input,
        "build/bridge_js/bridge.wasm",
        "build/bridge_final.zkey"
      )
    ).rejects.toThrow();
  });
});
