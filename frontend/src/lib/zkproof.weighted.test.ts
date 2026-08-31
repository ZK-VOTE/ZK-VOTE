import { describe, it, expect } from "vitest";
import {
  validateWeight,
  DOMAIN_TAG_WEIGHTED,
  DOMAIN_TAG_VOTE,
  MAX_WEIGHT,
  MIN_WEIGHT,
  benchmarkWeightedVsV2,
  WEIGHTED_VOTE_KAT,
  calculateWeightedNullifier,
} from "./zkproof";

describe("Weighted vote - constraint review", () => {
  it("KAT vector sanity: domain tags distinct", () => {
    expect(DOMAIN_TAG_WEIGHTED).not.toBe(DOMAIN_TAG_VOTE);
  });

  it("KAT vs vote_v2: domain separated nullifiers differ", async () => {
    const secret = "12345";
    const daoId = "1";
    const proposalId = "1";
    const weight = "100";
    const wNull = await calculateWeightedNullifier(
      secret,
      daoId,
      proposalId,
      weight,
      DOMAIN_TAG_WEIGHTED,
    );
    const wNull2 = await calculateWeightedNullifier(
      secret,
      daoId,
      proposalId,
      weight,
      DOMAIN_TAG_VOTE,
    );
    expect(wNull).not.toBe(wNull2);
  });

  it("KAT green: WEIGHTED_VOTE_KAT is defined", () => {
    expect(WEIGHTED_VOTE_KAT.secret).toBe("12345");
    expect(WEIGHTED_VOTE_KAT.weight).toBe("100");
  });
});

describe("Weighted vote - weight bounds", () => {
  it("accepts valid weight", () => {
    expect(() => validateWeight("1")).not.toThrow();
    expect(() => validateWeight("1000", "1000")).not.toThrow();
    expect(() => validateWeight(MAX_WEIGHT.toString())).not.toThrow();
  });

  it("rejects zero weight", () => {
    expect(() => validateWeight("0")).toThrow(/below minimum/);
  });

  it("rejects out-of-range weight (above max)", () => {
    expect(() => validateWeight("1000001")).toThrow(/exceeds/);
    expect(() => validateWeight("5000", "1000")).toThrow(/exceeds max/);
  });

  it("rejects negative weight (via BigInt)", () => {
    expect(() => validateWeight("-1")).toThrow();
  });

  it("rejects weight above global MAX_WEIGHT even if local max higher", () => {
    expect(() => validateWeight("2000000", "5000000")).toThrow(
      /global MAX_WEIGHT/,
    );
  });
});

describe("Weighted vote - benchmark", () => {
  it("benchmark runs", async () => {
    const res = await benchmarkWeightedVsV2(1);
    expect(res).toHaveProperty("weightedMs");
    expect(res).toHaveProperty("v2Ms");
    expect(res).toHaveProperty("ratio");
    expect(typeof res.ratio).toBe("number");
  }, 10000);
});
