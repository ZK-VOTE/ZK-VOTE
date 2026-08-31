import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  DEFAULT_CIRCUIT_DEPTH,
  GENERATED_DEPTHS,
  SUPPORTED_DEPTHS,
  MAX_MERKLE_DEPTH,
  resolveDepth,
  resolveCircuitUrls,
  smallestDepthFor,
} from "./circuitDepth";

const repoRoot = path.resolve(__dirname, "..", "..", "..");

describe("depth resolution", () => {
  it("resolves the contract's 0 sentinel to the default circuit", () => {
    expect(resolveDepth(0)).toBe(DEFAULT_CIRCUIT_DEPTH);
  });

  it("resolves a declared depth to itself", () => {
    for (const d of GENERATED_DEPTHS) expect(resolveDepth(d)).toBe(d);
  });

  it("rejects a depth above the contract maximum", () => {
    expect(() => resolveDepth(MAX_MERKLE_DEPTH + 1)).toThrow(/exceeds the maximum/);
  });

  it("rejects a negative or non-integer depth", () => {
    expect(() => resolveDepth(-1)).toThrow(/non-negative integer/);
    expect(() => resolveDepth(2.5)).toThrow(/non-negative integer/);
  });
});

describe("artifact URLs", () => {
  it("serves the default depth from the unsuffixed paths", () => {
    const u = resolveCircuitUrls(0);
    expect(u.depth).toBe(DEFAULT_CIRCUIT_DEPTH);
    expect(u.isDefault).toBe(true);
    expect(u.wasmUrl).toBe("/circuits/vote.wasm");
    expect(u.zkeyUrl).toBe("/circuits/vote_final.zkey");
  });

  it("serves a generated depth from its own directory", () => {
    const u = resolveCircuitUrls(10);
    expect(u.isDefault).toBe(false);
    expect(u.wasmUrl).toBe("/circuits/depth_10/vote_d10.wasm");
    expect(u.zkeyUrl).toBe("/circuits/depth_10/vote_d10_final.zkey");
  });

  it("gives every supported depth a distinct proving key", () => {
    const urls = SUPPORTED_DEPTHS.map((d) => resolveCircuitUrls(d).zkeyUrl);
    expect(new Set(urls).size).toBe(SUPPORTED_DEPTHS.length);
  });

  // Falling back to the default circuit would produce a proof for the wrong
  // circuit, rejected on-chain with nothing explaining why.
  it("refuses an accepted-but-uncompiled depth instead of falling back", () => {
    expect(SUPPORTED_DEPTHS).not.toContain(12);
    expect(() => resolveCircuitUrls(12)).toThrow(/no circuit compiled/);
  });
});

describe("choosing a depth for an electorate", () => {
  it("picks the shallowest compiled depth that fits", () => {
    expect(smallestDepthFor(1)).toBe(10);
    expect(smallestDepthFor(2 ** 10)).toBe(10);
    expect(smallestDepthFor(2 ** 10 + 1)).toBe(15);
    expect(smallestDepthFor(2 ** 15 + 1)).toBe(18);
    expect(smallestDepthFor(2 ** 18 + 1)).toBe(20);
    expect(smallestDepthFor(2 ** 20 + 1)).toBe(25);
  });

  it("returns the deepest compiled circuit when nothing fits", () => {
    expect(smallestDepthFor(2 ** 25 + 1)).toBe(25);
  });
});

// The depth set lives in the circom generator, the contract, the backend and
// here. Drift is silent — proofs get built against a circuit the chain has no
// key for — so it is asserted.
describe("cross-layer parity", () => {
  it("matches circuits/utils/gen_depth_circuits.js", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "circuits", "utils", "gen_depth_circuits.js"),
      "utf8",
    );
    const depths = src.match(/const DEFAULT_DEPTHS = \[([^\]]+)\]/);
    expect(depths).not.toBeNull();
    expect(depths![1].split(",").map((d) => Number(d.trim()))).toEqual([
      ...GENERATED_DEPTHS,
    ]);

    const dflt = src.match(/const DEFAULT_CIRCUIT_DEPTH = (\d+)/);
    expect(Number(dflt![1])).toBe(DEFAULT_CIRCUIT_DEPTH);
  });

  it("matches the voting contract's MAX_MERKLE_DEPTH", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "contracts", "voting", "src", "lib.rs"),
      "utf8",
    );
    const m = src.match(/pub const MAX_MERKLE_DEPTH: u32 = (\d+);/);
    expect(Number(m![1])).toBe(MAX_MERKLE_DEPTH);
  });

  it("matches the backend's circuit-artifacts service", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "backend", "src", "services", "circuit-artifacts.ts"),
      "utf8",
    );
    expect(
      Number(src.match(/DEFAULT_CIRCUIT_DEPTH = (\d+)/)![1]),
    ).toBe(DEFAULT_CIRCUIT_DEPTH);
    expect(Number(src.match(/MAX_MERKLE_DEPTH = (\d+)/)![1])).toBe(
      MAX_MERKLE_DEPTH,
    );
    expect(
      src.match(/GENERATED_DEPTHS = \[([^\]]+)\]/)![1]
        .split(",")
        .map((d) => Number(d.trim())),
    ).toEqual([...GENERATED_DEPTHS]);
  });

  it("matches the depth vote.circom instantiates", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "circuits", "vote.circom"),
      "utf8",
    );
    expect(Number(src.match(/=\s*Vote\((\d+)\);/)![1])).toBe(
      DEFAULT_CIRCUIT_DEPTH,
    );
  });
});
