/**
 * Regression test for circuits/vote_v2.circom (#349).
 *
 * vote_v2.circom was left uncompilable by the same botched find/replace in
 * 34a736f5 that broke comment.circom and comment_v2.circom (see
 * comment_v2.test.js for the full story) — its `template VoteV2(levels) {`
 * line had been deleted. It had zero existing tests, so nothing caught this.
 * This file pins that it compiles and produces a satisfiable witness again.
 *
 * Run with: npm test -- --testPathPattern=vote_v2
 * Requires the `circom` compiler (>= 2.1.8) on PATH.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const extraPaths = [
  path.join(os.homedir(), ".cargo", "bin"),
  "/home/runner/.cargo/bin",
  "/usr/local/bin",
  "/usr/bin",
];
for (const p of extraPaths) {
  if (
    fs.existsSync(path.join(p, "circom")) &&
    !(process.env.PATH || "").includes(p)
  ) {
    process.env.PATH = `${p}:${process.env.PATH || ""}`;
  }
}

const wasm_tester = require("circom_tester").wasm;
const { buildPoseidon } = require("circomlibjs");

const LEVELS = 18; // matches `component main = VoteV2(18)` in vote_v2.circom
const DOMAIN_TAG =
  19666041591797403834655481403982443037438503980743793537655983658411276515161n;

let poseidon;
let F;

function hash(inputs) {
  return F.toObject(poseidon(inputs.map((x) => BigInt(x))));
}

function merkleForLeafZero(leaf, levels) {
  const zeros = [0n];
  for (let i = 0; i < levels; i++) {
    zeros.push(hash([zeros[i], zeros[i]]));
  }
  const pathElements = [];
  const pathIndices = [];
  let cur = hash([1n, BigInt(leaf)]); // LEAF_DOMAIN = 1 (merkle_tree.circom)
  for (let i = 0; i < levels; i++) {
    pathElements.push(zeros[i]);
    pathIndices.push(0);
    cur = hash([cur, zeros[i]]);
  }
  return { root: cur, pathElements, pathIndices };
}

beforeAll(async () => {
  poseidon = await buildPoseidon();
  F = poseidon.F;
}, 30000);

test("vote_v2.circom's DOMAIN_TAG matches vote.circom/comment.circom/comment_v2.circom", () => {
  const files = [
    // The Vote template moved to vote_template.circom so every Merkle
    // depth can instantiate it (#93); the constant lives with the template.
    "vote_template.circom",
    "vote_v2.circom",
    "comment.circom",
    "comment_v2.circom",
  ];
  for (const file of files) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    const match = src.match(/var DOMAIN_TAG = (\d+);/);
    expect(match).not.toBeNull();
    expect(BigInt(match[1])).toBe(DOMAIN_TAG);
  }
});

describe("vote_v2.circom (real circom toolchain)", () => {
  let circuit;

  beforeAll(async () => {
    circuit = await wasm_tester(path.join(__dirname, "vote_v2.circom"), {
      include: [path.join(__dirname, "node_modules")],
    });
  }, 180000);

  test("accepts a correctly-constructed vote proof", async () => {
    const secret = 111n,
      salt = 222n,
      blindingFactor = 333n,
      daoId = 1n,
      proposalId = 7n,
      chainId = 1n,
      nonce = 0n,
      voteChoice = 1n,
      numCandidates = 2n;

    const commitment = hash([DOMAIN_TAG, secret, salt, blindingFactor]);
    const { root, pathElements, pathIndices } = merkleForLeafZero(
      commitment,
      LEVELS,
    );
    const familyNullifier = hash([secret, daoId, proposalId, chainId]);
    const nullifier = hash([secret, daoId, proposalId, chainId, nonce]);

    const witness = await circuit.calculateWitness(
      {
        root,
        nullifier,
        familyNullifier,
        daoId,
        proposalId,
        voteChoice,
        numCandidates,
        chainId,
        nonce,
        secret,
        salt,
        blindingFactor,
        pathElements,
        pathIndices,
      },
      true,
    );
    await circuit.checkConstraints(witness);
  });

  test("rejects a voteChoice outside [0, numCandidates)", async () => {
    const secret = 111n,
      salt = 222n,
      blindingFactor = 333n,
      daoId = 1n,
      proposalId = 7n,
      chainId = 1n,
      nonce = 0n;

    const commitment = hash([DOMAIN_TAG, secret, salt, blindingFactor]);
    const { root, pathElements, pathIndices } = merkleForLeafZero(
      commitment,
      LEVELS,
    );
    const familyNullifier = hash([secret, daoId, proposalId, chainId]);
    const nullifier = hash([secret, daoId, proposalId, chainId, nonce]);

    let threw = false;
    try {
      const witness = await circuit.calculateWitness(
        {
          root,
          nullifier,
          familyNullifier,
          daoId,
          proposalId,
          voteChoice: 5n, // out of bounds for numCandidates = 2
          numCandidates: 2n,
          chainId,
          nonce,
          secret,
          salt,
          blindingFactor,
          pathElements,
          pathIndices,
        },
        true,
      );
      await circuit.checkConstraints(witness);
    } catch (e) {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
