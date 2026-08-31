#!/usr/bin/env node
/**
 * Generates the real-proof fixture for the batch verification tests (#90).
 *
 * `verify_groth16_batch` is stubbed out under `cfg(test)` like the rest of the
 * verifier, so the only way to exercise the real BN254 arithmetic is an
 * integration test built against genuine proofs. This script produces them.
 *
 * It builds one Merkle tree holding several members, proves a vote for each of
 * them against the *same* root and verification key, and emits the whole set as
 * a Rust fixture. That shape matters: a batch in production is several voters
 * in one election, so `root`, `daoId`, `proposalId` and `numCandidates` are
 * shared while `nullifier` and `voteChoice` vary, which is exactly what the
 * shared-column hoisting in `batch.rs` is built for.
 *
 * The ceremony is a throwaway: the resulting proving key is used only to make
 * test vectors and must never be used for a real election.
 *
 * Requirements: `circom` on PATH and a Powers of Tau file.
 *
 * Usage:
 *   node utils/gen_batch_fixture.js --ptau=pot14_final.ptau \
 *       [--count=4] [--depth=18] [--out=../contracts/zkvote-groth16/tests/batch_fixture.rs]
 */

"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { convertG1Point, convertG2Point } = require("../conversion-utils.js");

const CIRCUITS_DIR = path.join(__dirname, "..");

const DOMAIN_TAG =
  19666041591797403834655481403982443037438503980743793537655983658411276515161n;
const LEAF_DOMAIN = 1n;

const DAO_ID = 7n;
const PROPOSAL_ID = 3n;
const NUM_CANDIDATES = 4n;

function parseArgs(argv) {
  const get = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? fallback : hit.slice(name.length + 3);
  };
  return {
    ptau: get("ptau", path.join(CIRCUITS_DIR, "pot14_final.ptau")),
    count: Number(get("count", "4")),
    depth: Number(get("depth", "18")),
    out: get(
      "out",
      path.join(CIRCUITS_DIR, "..", "contracts", "zkvote-groth16", "tests", "batch_fixture.rs"),
    ),
  };
}

/**
 * Builds a Merkle tree whose first `members.length` leaves are occupied and
 * whose remaining leaves are zero, and returns each member's inclusion path.
 * Mirrors merkle_tree.circom: leaves enter the tree domain-hashed.
 */
function buildTree(hash, commitments, depth) {
  const zeros = [0n];
  for (let i = 0; i < depth; i++) zeros.push(hash([zeros[i], zeros[i]]));

  // Only the subtree covering the occupied leaves needs explicit nodes; every
  // other sibling is the all-zero subtree value for its level.
  let level = commitments.map((c) => hash([LEAF_DOMAIN, c]));
  const occupiedLevels = [level];
  let width = level.length;
  let levelIndex = 0;

  while (width > 1 || levelIndex < depth) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : zeros[levelIndex];
      next.push(hash([left, right]));
    }
    level = next;
    levelIndex += 1;
    occupiedLevels.push(level);
    width = level.length;
    if (levelIndex >= depth) break;
  }

  const root = level[0];

  const paths = commitments.map((_, leafIndex) => {
    const pathElements = [];
    const pathIndices = [];
    let index = leafIndex;
    for (let l = 0; l < depth; l++) {
      const siblingIndex = index ^ 1;
      const nodes = occupiedLevels[l];
      const sibling =
        siblingIndex < nodes.length ? nodes[siblingIndex] : zeros[l];
      pathElements.push(sibling.toString());
      pathIndices.push(index & 1);
      index >>= 1;
    }
    return { pathElements, pathIndices };
  });

  return { root, paths };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!fs.existsSync(args.ptau)) {
    console.error(`Powers of Tau file not found: ${args.ptau}`);
    return 1;
  }

  const snarkjs = require("snarkjs");
  const { buildPoseidon } = require("circomlibjs");
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const hash = (xs) => F.toObject(poseidon(xs.map(BigInt)));

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "zkvote-batch-fixture-"));
  try {
    const source = args.depth === 18 ? "vote.circom" : `vote_d${args.depth}.circom`;
    const name = path.basename(source, ".circom");
    execFileSync(
      "circom",
      [source, "--r1cs", "--wasm", "--sym", "-o", workDir, "-l", "node_modules"],
      { cwd: CIRCUITS_DIR, stdio: "pipe" },
    );

    const r1cs = path.join(workDir, `${name}.r1cs`);
    const wasm = path.join(workDir, `${name}_js`, `${name}.wasm`);
    const zkey0 = path.join(workDir, "setup_0000.zkey");
    const zkey = path.join(workDir, "setup_final.zkey");

    await snarkjs.zKey.newZKey(r1cs, args.ptau, zkey0);
    await snarkjs.zKey.contribute(zkey0, zkey, "batch-fixture", "batch-fixture-entropy");
    const vkey = await snarkjs.zKey.exportVerificationKey(zkey);

    // Distinct members of one DAO, all in the same tree.
    const members = [];
    for (let i = 0; i < args.count; i++) {
      const secret = BigInt(1000 + i);
      const salt = BigInt(2000 + i);
      const blindingFactor = BigInt(3000 + i);
      members.push({
        secret,
        salt,
        blindingFactor,
        commitment: hash([DOMAIN_TAG, secret, salt, blindingFactor]),
        // Alternate the vote so the voteChoice column genuinely varies.
        voteChoice: BigInt(i % Number(NUM_CANDIDATES)),
      });
    }

    const { root, paths } = buildTree(
      hash,
      members.map((m) => m.commitment),
      args.depth,
    );

    const entries = [];
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const nullifier = hash([m.secret, DAO_ID, PROPOSAL_ID]);
      const input = {
        root: root.toString(),
        nullifier: nullifier.toString(),
        daoId: DAO_ID.toString(),
        proposalId: PROPOSAL_ID.toString(),
        voteChoice: m.voteChoice.toString(),
        numCandidates: NUM_CANDIDATES.toString(),
        secret: m.secret.toString(),
        salt: m.salt.toString(),
        blindingFactor: m.blindingFactor.toString(),
        pathElements: paths[i].pathElements,
        pathIndices: paths[i].pathIndices,
      };

      const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
      const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
      if (!ok) throw new Error(`generated proof ${i} does not verify`);

      entries.push({
        a: convertG1Point(proof.pi_a),
        b: convertG2Point(proof.pi_b),
        c: convertG1Point(proof.pi_c),
        signals: publicSignals,
      });
    }

    const rust = renderRust({ vkey, entries, depth: args.depth });
    fs.writeFileSync(args.out, rust);
    console.log(`wrote ${entries.length} proofs to ${args.out}`);
    return 0;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function renderRust({ vkey, entries, depth }) {
  const hexArray = (hex, indent) => {
    const bytes = hex.match(/../g).map((b) => `0x${b}`);
    const lines = [];
    for (let i = 0; i < bytes.length; i += 12) {
      lines.push(`${indent}${bytes.slice(i, i + 12).join(", ")},`);
    }
    return lines.join("\n");
  };

  const icEntries = vkey.IC.map(
    (point, i) =>
      `    // IC[${i}]\n    [\n${hexArray(convertG1Point(point), "        ")}\n    ],`,
  ).join("\n");

  const proofEntries = entries
    .map(
      (e, i) => `    // proof ${i}
    ProofFixture {
        a: [
${hexArray(e.a, "            ")}
        ],
        b: [
${hexArray(e.b, "            ")}
        ],
        c: [
${hexArray(e.c, "            ")}
        ],
        signals: [
${e.signals.map((s) => `            "${s}",`).join("\n")}
        ],
    },`,
    )
    .join("\n");

  return `// GENERATED FILE - do not edit.
//
// Real Groth16 proofs for the batch verification tests (#90), produced by
// circuits/utils/gen_batch_fixture.js from a throwaway ceremony over the
// depth-${depth} vote circuit. All ${entries.length} proofs are votes by different members of
// the same DAO on the same proposal, so they share a verification key, a Merkle
// root, a dao id, a proposal id and a candidate count, and differ in their
// nullifier and vote choice - the shape a production batch actually has.
//
// Regenerate with:
//   cd circuits && node utils/gen_batch_fixture.js --ptau=pot14_final.ptau

#![allow(dead_code)]

pub const NUM_PUBLIC_SIGNALS: usize = ${entries[0].signals.length};
pub const MERKLE_DEPTH: u32 = ${depth};

pub struct ProofFixture {
    pub a: [u8; 64],
    pub b: [u8; 128],
    pub c: [u8; 64],
    pub signals: [&'static str; NUM_PUBLIC_SIGNALS],
}

pub const VK_ALPHA: [u8; 64] = [
${hexArray(convertG1Point(vkey.vk_alpha_1), "    ")}
];

pub const VK_BETA: [u8; 128] = [
${hexArray(convertG2Point(vkey.vk_beta_2), "    ")}
];

pub const VK_GAMMA: [u8; 128] = [
${hexArray(convertG2Point(vkey.vk_gamma_2), "    ")}
];

pub const VK_DELTA: [u8; 128] = [
${hexArray(convertG2Point(vkey.vk_delta_2), "    ")}
];

pub const VK_IC: [[u8; 64]; ${vkey.IC.length}] = [
${icEntries}
];

pub const PROOFS: [ProofFixture; ${entries.length}] = [
${proofEntries}
];
`;
}

module.exports = { buildTree };

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
