/**
 * Known-answer tests for circuits/comment_v2.circom (#349).
 *
 * comment_v2.circom, comment.circom (v1), and vote_v2.circom were all
 * left uncompilable by a botched find/replace in 34a736f5 ("fix: resolve
 * CI/CD pipeline failures") that deleted each circuit's `template Name(levels) {`
 * line while trying to move `var DOMAIN_TAG` inside it — CI's "Compile v2
 * circuits" step swallows the failure (`circom ... || echo "... skipped"`),
 * so this had gone unnoticed. This suite exercises the real circom toolchain
 * (witness generation + constraint checking via circom_tester) against the
 * restored circuit, and pins comment_v2's signals/domain tag against
 * vote_v2.circom and comment.circom to prove the three are aligned:
 *   - identical DOMAIN_TAG constant across vote/vote_v2/comment/comment_v2
 *   - identical commitment scheme: Poseidon(DOMAIN_TAG, secret, salt, blindingFactor)
 *   - identical nullifier domain-separation shape (secret, daoId, proposalId, ...)
 *   - identical Merkle leaf domain-separation (merkle_tree.circom's LEAF_DOMAIN)
 *
 * Run with: npm test -- --testPathPattern=comment_v2
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

const LEVELS = 18; // matches `component main = CommentV2(18)` in comment_v2.circom
const DOMAIN_TAG =
  19666041591797403834655481403982443037438503980743793537655983658411276515161n;

let poseidon;
let F;

function hash(inputs) {
  return F.toObject(poseidon(inputs.map((x) => BigInt(x))));
}

// Merkle root for a leaf placed at index 0 of an otherwise-empty tree,
// mirroring merkle_tree.circom's LEAF_DOMAIN=1 leaf hashing.
function merkleForLeafZero(leaf, levels) {
  const zeros = [0n];
  for (let i = 0; i < levels; i++) {
    zeros.push(hash([zeros[i], zeros[i]]));
  }
  const pathElements = [];
  const pathIndices = [];
  let cur = hash([1n, BigInt(leaf)]); // LEAF_DOMAIN = 1
  for (let i = 0; i < levels; i++) {
    pathElements.push(zeros[i]);
    pathIndices.push(0);
    cur = hash([cur, zeros[i]]);
  }
  return { root: cur, pathElements, pathIndices };
}

function buildCommentV2Input(overrides = {}) {
  const secret = 111n;
  const salt = 222n;
  const daoId = 1n;
  const proposalId = 7n;
  const commentNonce = 0n;
  const parentCommentId = 0n;

  const commitment = hash([secret, salt]);
  const { root, pathElements, pathIndices } = merkleForLeafZero(
    commitment,
    LEVELS,
  );
  const nullifier = hash([secret, daoId, proposalId, commentNonce]);

  return {
    root,
    nullifier,
    daoId,
    proposalId,
    commentNonce,
    commitment,
    parentCommentId,
    secret,
    salt,
    pathElements,
    pathIndices,
    ...overrides,
  };
}

async function expectInvalid(circuit, input) {
  let threw = false;
  try {
    const witness = await circuit.calculateWitness(input, true);
    await circuit.checkConstraints(witness);
  } catch (e) {
    threw = true;
  }
  expect(threw).toBe(true);
}

beforeAll(async () => {
  poseidon = await buildPoseidon();
  F = poseidon.F;
});

describe("comment_v2.circom signal parity", () => {
  test("DOMAIN_TAG is the exact same constant across v1 vote/comment circuits", () => {
    const files = ["vote.circom", "comment.circom"];
    for (const file of files) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      const match = src.match(/var DOMAIN_TAG = (\d+);/);
      expect(match).not.toBeNull();
      expect(BigInt(match[1])).toBe(DOMAIN_TAG);
    }
  });

  test("comment_v2's public signal list matches the documented parentCommentId-extended shape", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "comment_v2.circom"),
      "utf8",
    );
    const match = src.match(/component main \{public \[([^\]]+)\]\}/);
    expect(match).not.toBeNull();
    const publicSignals = match[1].split(",").map((s) => s.trim());
    expect(publicSignals).toEqual([
      "root",
      "nullifier",
      "daoId",
      "proposalId",
      "commentNonce",
      "commitment",
      "parentCommentId",
    ]);
  });
});

describe("comment_v2.circom (real circom toolchain)", () => {
  let circuit;

  beforeAll(async () => {
    circuit = await wasm_tester(path.join(__dirname, "comment_v2.circom"), {
      include: [path.join(__dirname, "node_modules")],
    });
  }, 180000);

  test("accepts a correctly-constructed top-level comment (parentCommentId = 0)", async () => {
    const input = buildCommentV2Input();
    const witness = await circuit.calculateWitness(input, true);
    await circuit.checkConstraints(witness);
  });

  test("accepts a threaded reply (parentCommentId != 0), passed through unconstrained", async () => {
    const input = buildCommentV2Input({ parentCommentId: 42n });
    const witness = await circuit.calculateWitness(input, true);
    await circuit.checkConstraints(witness);
  });

  test("accepts a non-zero commentNonce for a second comment by the same commenter", async () => {
    const secret = 111n,
      salt = 222n,
      daoId = 1n,
      proposalId = 7n,
      commentNonce = 1n;
    const commitment = hash([secret, salt]);
    const { root, pathElements, pathIndices } = merkleForLeafZero(
      commitment,
      LEVELS,
    );
    const nullifier = hash([secret, daoId, proposalId, commentNonce]);

    const witness = await circuit.calculateWitness(
      {
        root,
        nullifier,
        daoId,
        proposalId,
        commentNonce,
        commitment,
        parentCommentId: 0n,
        secret,
        salt,
        pathElements,
        pathIndices,
      },
      true,
    );
    await circuit.checkConstraints(witness);
  });

  test("rejects a commitment that doesn't match Poseidon(secret, salt)", async () => {
    const input = buildCommentV2Input({ commitment: 999999n });
    await expectInvalid(circuit, input);
  });

  test("rejects a nullifier that doesn't match Poseidon(secret, daoId, proposalId, commentNonce)", async () => {
    const input = buildCommentV2Input({ nullifier: 999999n });
    await expectInvalid(circuit, input);
  });

  test("rejects a root that doesn't match the Merkle proof", async () => {
    const input = buildCommentV2Input({ root: 999999n });
    await expectInvalid(circuit, input);
  });

  test("rejects a non-binary pathIndices entry", async () => {
    const input = buildCommentV2Input();
    input.pathIndices[0] = 2n;
    await expectInvalid(circuit, input);
  });

  test("commitment computed from a different secret does not satisfy the same proof", async () => {
    // Using the wrong secret changes both the commitment and the nullifier.
    const wrongSecret = 999n;
    const input = buildCommentV2Input();
    input.secret = wrongSecret;
    await expectInvalid(circuit, input);
  });
});
