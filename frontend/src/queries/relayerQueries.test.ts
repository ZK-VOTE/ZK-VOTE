import { describe, it, expect } from "vitest";
import { isWrongNetwork } from "./relayerQueries";

describe("isWrongNetwork", () => {
  it("is true only for a mismatch flagged as another network", () => {
    expect(
      isWrongNetwork({ state: "mismatch", message: "m", mismatches: ["x"], wrongNetwork: true }),
    ).toBe(true);
  });

  it("is false for other mismatches and other states", () => {
    expect(isWrongNetwork({ state: "mismatch", message: "m", mismatches: ["rpc"] })).toBe(false);
    expect(isWrongNetwork({ state: "ready", message: "ok" })).toBe(false);
    expect(isWrongNetwork(null)).toBe(false);
  });
});
