#!/usr/bin/env node
/**
 * Generates the per-depth vote circuit wrappers (#93).
 *
 * `vote.circom` hard-codes a Merkle depth of 18. Every proof therefore carries
 * 18 path elements and 18 Poseidon hashes, whether the election has 40 voters
 * or 200,000. Circom has no way to parameterise `component main` from the
 * command line, so a fixed depth means a fixed circuit — the only way to offer
 * several depths is to compile several circuits.
 *
 * This script emits one small wrapper per supported depth. Each wrapper
 * includes the shared `vote_template.circom` and instantiates `Vote(depth)`,
 * so all depths stay bit-for-bit the same circuit logic and only the Merkle
 * path length differs.
 *
 * The generated files are committed so that CI, the compile script and
 * reviewers all see the exact circuits that get compiled; this script exists to
 * regenerate them reproducibly, not to be a build step.
 *
 * Usage:
 *   node utils/gen_depth_circuits.js              # regenerate the standard set
 *   node utils/gen_depth_circuits.js 12 16        # generate specific depths
 *   node utils/gen_depth_circuits.js --check      # fail if files are stale
 */

"use strict";

const fs = require("fs");
const path = require("path");

const CIRCUITS_DIR = path.join(__dirname, "..");

/**
 * Depths compiled by default.
 *
 * 18 is deliberately absent: it is `vote.circom` itself, which stays the
 * default circuit so existing deployments, artifacts and checksums are
 * untouched. `capacity` is 2^depth, the number of members the tree can hold.
 */
const DEFAULT_DEPTHS = [10, 15, 20, 25];

/** The depth `vote.circom` instantiates. Kept here so the two cannot diverge. */
const DEFAULT_CIRCUIT_DEPTH = 18;

/** Depths the protocol accepts, including the default circuit. */
const SUPPORTED_DEPTHS = [...DEFAULT_DEPTHS, DEFAULT_CIRCUIT_DEPTH].sort((a, b) => a - b);

const MIN_DEPTH = 1;
const MAX_DEPTH = 32;

function circuitFileName(depth) {
  return `vote_d${depth}.circom`;
}

function render(depth) {
  if (!Number.isInteger(depth) || depth < MIN_DEPTH || depth > MAX_DEPTH) {
    throw new Error(`depth must be an integer in [${MIN_DEPTH}, ${MAX_DEPTH}], got ${depth}`);
  }
  const capacity = 2 ** depth;
  return `pragma circom 2.0.0;

// GENERATED FILE - do not edit.
// Regenerate with: node utils/gen_depth_circuits.js
//
// Merkle depth ${depth}: supports up to 2^${depth} = ${capacity.toLocaleString("en-US")} members.
//
// Identical to vote.circom except for the tree depth. Proving cost is dominated
// by the ${depth} Poseidon hashes of the Merkle path, so a smaller depth means a
// proportionally cheaper proof for a smaller electorate.
//
// Public signals: [root, nullifier, daoId, proposalId, voteChoice, numCandidates] - 6 signals
// The commitment stays private; it is recomputed inside the circuit.

include "vote_template.circom";

component main {public [root, nullifier, daoId, proposalId, voteChoice, numCandidates]} = Vote(${depth});
`;
}

function generate(depths, { check = false } = {}) {
  const stale = [];
  for (const depth of depths) {
    const file = path.join(CIRCUITS_DIR, circuitFileName(depth));
    const contents = render(depth);
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (current === contents) continue;
    if (check) {
      stale.push(circuitFileName(depth));
      continue;
    }
    fs.writeFileSync(file, contents);
    console.log(`${current === null ? "created" : "updated"}: ${circuitFileName(depth)}`);
  }
  return stale;
}

function main(argv) {
  const check = argv.includes("--check");
  const explicit = argv.filter((a) => /^\d+$/.test(a)).map(Number);
  const depths = explicit.length > 0 ? explicit : DEFAULT_DEPTHS;

  const stale = generate(depths, { check });
  if (check) {
    if (stale.length > 0) {
      console.error(
        `stale generated circuits: ${stale.join(", ")}\n` +
          "run: node utils/gen_depth_circuits.js",
      );
      return 1;
    }
    console.log("generated depth circuits are up to date");
  }
  return 0;
}

module.exports = {
  DEFAULT_DEPTHS,
  DEFAULT_CIRCUIT_DEPTH,
  SUPPORTED_DEPTHS,
  MIN_DEPTH,
  MAX_DEPTH,
  circuitFileName,
  render,
  generate,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
