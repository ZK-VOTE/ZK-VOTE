import { describe, expect, it } from "vitest";
import {
  canonicalizeStellarAmount,
  formatStroops,
  parseStroops,
} from "./stellarAmount";

describe("Stellar amounts", () => {
  it("preserves one stroop without Number precision", () => {
    expect(parseStroops("0.0000001")).toBe(1n);
    expect(formatStroops(1n)).toBe("0.0000001");
    expect(canonicalizeStellarAmount("10")).toBe("10.0000000");
  });
});
