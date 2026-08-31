import test from "node:test";
import assert from "node:assert/strict";
import path from "path";

const mod = await import("../src/services/circuit-artifacts.ts");
const {
  DEFAULT_CIRCUIT_DEPTH,
  GENERATED_DEPTHS,
  SUPPORTED_DEPTHS,
  MAX_MERKLE_DEPTH,
  resolveDepth,
  resolveArtifacts,
} = mod;

test("the contract's 0 sentinel resolves to the default circuit depth", () => {
  assert.equal(resolveDepth(0), DEFAULT_CIRCUIT_DEPTH);
  assert.equal(DEFAULT_CIRCUIT_DEPTH, 18);
});

test("a declared depth resolves to itself", () => {
  for (const depth of GENERATED_DEPTHS) {
    assert.equal(resolveDepth(depth), depth);
  }
});

test("the default depth is supported but is not a generated wrapper", () => {
  assert.ok(SUPPORTED_DEPTHS.includes(DEFAULT_CIRCUIT_DEPTH));
  assert.ok(!GENERATED_DEPTHS.includes(DEFAULT_CIRCUIT_DEPTH));
});

test("a depth above the contract maximum is rejected", () => {
  assert.throws(() => resolveDepth(MAX_MERKLE_DEPTH + 1), /exceeds the maximum/);
});

test("a negative or non-integer depth is rejected", () => {
  assert.throws(() => resolveDepth(-1), /non-negative integer/);
  assert.throws(() => resolveDepth(1.5), /non-negative integer/);
});

test("the default depth maps to the unsuffixed build outputs", () => {
  const a = resolveArtifacts(0);
  assert.equal(a.depth, DEFAULT_CIRCUIT_DEPTH);
  assert.equal(a.isDefault, true);
  assert.equal(path.basename(a.wasmPath), "vote.wasm");
  assert.equal(path.basename(a.zkeyPath), "vote_final.zkey");
  assert.ok(!a.wasmPath.includes("depth_"));
});

test("a generated depth maps into its own build directory", () => {
  const a = resolveArtifacts(10);
  assert.equal(a.depth, 10);
  assert.equal(a.isDefault, false);
  assert.ok(a.wasmPath.includes(`${path.sep}depth_10${path.sep}`));
  assert.equal(path.basename(a.wasmPath), "vote_d10.wasm");
  assert.equal(path.basename(a.zkeyPath), "vote_d10_final.zkey");
  assert.equal(path.basename(a.r1csPath), "vote_d10.r1cs");
});

test("every supported depth resolves to a distinct artifact set", () => {
  const seen = new Set();
  for (const depth of SUPPORTED_DEPTHS) {
    const { wasmPath } = resolveArtifacts(depth);
    assert.ok(!seen.has(wasmPath), `duplicate wasm path for depth ${depth}`);
    seen.add(wasmPath);
  }
  assert.equal(seen.size, SUPPORTED_DEPTHS.length);
});

// A depth the contract would accept but that this deployment never compiled
// must fail loudly: silently proving against the default circuit would produce
// a proof that is rejected on-chain with no stated reason.
test("an accepted-but-uncompiled depth is rejected rather than falling back", () => {
  assert.ok(!SUPPORTED_DEPTHS.includes(12) && 12 < MAX_MERKLE_DEPTH);
  assert.throws(() => resolveArtifacts(12), /no circuit compiled/);
});

// The depth set exists in three places that must agree: the circom wrapper
// generator, the voting contract's bound, and this service. A drift between
// them is silent — proofs are generated against a circuit the chain has no key
// for — so it is asserted rather than documented.
import fs from "fs";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("depth constants match circuits/utils/gen_depth_circuits.js", () => {
  const src = fs.readFileSync(
    path.join(repoRoot, "circuits", "utils", "gen_depth_circuits.js"),
    "utf8",
  );

  const depths = src.match(/const DEFAULT_DEPTHS = \[([^\]]+)\]/);
  assert.ok(depths, "DEFAULT_DEPTHS not found in the generator");
  assert.deepEqual(
    depths[1].split(",").map((d) => Number(d.trim())),
    [...GENERATED_DEPTHS],
  );

  const dflt = src.match(/const DEFAULT_CIRCUIT_DEPTH = (\d+)/);
  assert.ok(dflt, "DEFAULT_CIRCUIT_DEPTH not found in the generator");
  assert.equal(Number(dflt[1]), DEFAULT_CIRCUIT_DEPTH);

  const max = src.match(/const MAX_DEPTH = (\d+)/);
  assert.ok(max, "MAX_DEPTH not found in the generator");
  assert.equal(Number(max[1]), MAX_MERKLE_DEPTH);
});

test("MAX_MERKLE_DEPTH matches the voting contract", () => {
  const src = fs.readFileSync(
    path.join(repoRoot, "contracts", "voting", "src", "lib.rs"),
    "utf8",
  );
  const m = src.match(/pub const MAX_MERKLE_DEPTH: u32 = (\d+);/);
  assert.ok(m, "MAX_MERKLE_DEPTH not found in the voting contract");
  assert.equal(Number(m[1]), MAX_MERKLE_DEPTH);
});

test("the default circuit's depth matches vote.circom", () => {
  const src = fs.readFileSync(path.join(repoRoot, "circuits", "vote.circom"), "utf8");
  const m = src.match(/=\s*Vote\((\d+)\);/);
  assert.ok(m, "Vote(N) instantiation not found in vote.circom");
  assert.equal(Number(m[1]), DEFAULT_CIRCUIT_DEPTH);
});
