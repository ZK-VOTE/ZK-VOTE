/**
 * Merkle depth flexibility tests (#93).
 *
 * `vote.circom` fixes the tree depth at 18, so every proof carries 18 path
 * elements and 18 Poseidon hashes whether the election has 40 voters or
 * 200,000. Circom cannot parameterise `component main` from the command line,
 * so several depths means several compiled circuits.
 *
 * These tests check the three things that have to hold for that to be safe:
 *
 *   1. the generated wrappers are exactly what the generator produces, so a
 *      hand-edit cannot slip a different circuit into the build;
 *   2. every depth is the *same* circuit apart from the path length — same
 *      public signals, in the same order, computing the same nullifier and
 *      commitment;
 *   3. a proof for one depth does not satisfy another depth's circuit, which is
 *      what makes the per-depth verification key a real binding rather than
 *      bookkeeping.
 */

const fs = require("fs");
const path = require("path");

const wasm_tester = require("circom_tester").wasm;
const { buildPoseidon } = require("circomlibjs");

const gen = require("./utils/gen_depth_circuits.js");

const DOMAIN_TAG =
  19666041591797403834655481403982443037438503980743793537655983658411276515161n;
const LEAF_DOMAIN = 1n; // merkle_tree.circom

// Compiling a circuit per depth is slow; keep the toolchain tests to a small
// and a large depth, which is enough to show the depth actually varies.
const TOOLCHAIN_DEPTHS = [10, 15];

let poseidon;
let F;

const hash = (inputs) => F.toObject(poseidon(inputs.map((x) => BigInt(x))));

/**
 * Build a membership witness for a tree whose only occupied leaf is at index 0
 * and whose other leaves are zero, mirroring merkle_tree.circom: the leaf is
 * domain-hashed before entering the tree.
 */
function witnessForLeaf(commitment, levels) {
  const zeros = [0n];
  for (let i = 0; i < levels; i++) zeros.push(hash([zeros[i], zeros[i]]));

  const pathElements = [];
  const pathIndices = [];
  let current = hash([LEAF_DOMAIN, BigInt(commitment)]);
  for (let i = 0; i < levels; i++) {
    pathElements.push(zeros[i]);
    pathIndices.push(0);
    current = hash([current, zeros[i]]);
  }
  return { root: current, pathElements, pathIndices };
}

function voteInput(levels, { secret = 12345n, salt = 67890n, blindingFactor = 424242n } = {}) {
  const daoId = 7n;
  const proposalId = 3n;
  const voteChoice = 1n;
  const numCandidates = 4n;

  const commitment = hash([DOMAIN_TAG, secret, salt, blindingFactor]);
  const { root, pathElements, pathIndices } = witnessForLeaf(commitment, levels);
  const nullifier = hash([secret, daoId, proposalId]);

  return {
    root,
    nullifier,
    daoId,
    proposalId,
    voteChoice,
    numCandidates,
    secret,
    salt,
    blindingFactor,
    pathElements,
    pathIndices,
  };
}

beforeAll(async () => {
  poseidon = await buildPoseidon();
  F = poseidon.F;
}, 30000);

describe("generated depth wrappers", () => {
  test("the committed wrappers match the generator output", () => {
    const stale = gen.generate(gen.DEFAULT_DEPTHS, { check: true });
    expect(stale).toEqual([]);
  });

  test.each(gen.DEFAULT_DEPTHS)("vote_d%i.circom instantiates Vote at that depth", (depth) => {
    const file = path.join(__dirname, gen.circuitFileName(depth));
    const src = fs.readFileSync(file, "utf8");

    expect(src).toContain('include "vote_template.circom";');
    expect(src).toMatch(new RegExp(`=\\s*Vote\\(${depth}\\);`));
    // Every depth must expose the same public signals in the same order, or
    // the contract's public-signal layout stops matching.
    expect(src).toContain(
      "{public [root, nullifier, daoId, proposalId, voteChoice, numCandidates]}",
    );
  });

  test("vote.circom stays the depth-18 default", () => {
    const src = fs.readFileSync(path.join(__dirname, "vote.circom"), "utf8");
    expect(src).toMatch(/=\s*Vote\(18\);/);
    expect(gen.DEFAULT_CIRCUIT_DEPTH).toBe(18);
  });

  test("the supported set is the default circuit plus the generated depths", () => {
    expect(gen.SUPPORTED_DEPTHS).toEqual([10, 15, 18, 20, 25]);
  });

  test("the generator refuses depths outside the supported range", () => {
    expect(() => gen.render(0)).toThrow();
    expect(() => gen.render(33)).toThrow();
    expect(() => gen.render(12.5)).toThrow();
  });
});

describe("depth circuits (real circom toolchain)", () => {
  const circuits = {};

  beforeAll(async () => {
    for (const depth of TOOLCHAIN_DEPTHS) {
      circuits[depth] = await wasm_tester(
        path.join(__dirname, gen.circuitFileName(depth)),
        { include: [path.join(__dirname, "node_modules")] },
      );
    }
  }, 300000);

  test.each(TOOLCHAIN_DEPTHS)("depth %i accepts a correctly built vote", async (depth) => {
    const input = voteInput(depth);
    const witness = await circuits[depth].calculateWitness(input, true);
    await circuits[depth].checkConstraints(witness);
  }, 120000);

  test.each(TOOLCHAIN_DEPTHS)(
    "depth %i rejects a vote choice at or above numCandidates",
    async (depth) => {
      const input = { ...voteInput(depth), voteChoice: 4n, numCandidates: 4n };
      await expect(circuits[depth].calculateWitness(input, true)).rejects.toThrow();
    },
    120000,
  );

  test.each(TOOLCHAIN_DEPTHS)("depth %i rejects a root it cannot reach", async (depth) => {
    const input = voteInput(depth);
    input.root = input.root + 1n;
    await expect(circuits[depth].calculateWitness(input, true)).rejects.toThrow();
  }, 120000);

  test("a witness built for one depth does not satisfy another", async () => {
    const [small, large] = TOOLCHAIN_DEPTHS;
    // The path arrays are the wrong length, so the circuit cannot even accept
    // the input. That length mismatch is exactly why each depth needs its own
    // verification key rather than sharing one.
    const input = voteInput(small);
    await expect(circuits[large].calculateWitness(input, true)).rejects.toThrow();
  }, 120000);

  test("the nullifier is depth-independent", async () => {
    // The nullifier binds (secret, daoId, proposalId) only, so moving an
    // election to a different depth must not let the same voter vote twice.
    const [small, large] = TOOLCHAIN_DEPTHS;
    expect(voteInput(small).nullifier).toEqual(voteInput(large).nullifier);
  });
});
