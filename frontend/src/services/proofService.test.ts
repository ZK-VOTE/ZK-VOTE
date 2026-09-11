import { describe, it, expect, vi } from "vitest";
import {
  BN254_MODULUS,
  BN254_MODULUS_HEX,
  isValidFieldElement,
  assertValidFieldElement,
  isBinaryPathIndex,
  assertBinaryPathIndex,
  validateBinaryPathIndices,
  validateCircuitInputs,
  proofService,
} from "./proofService";
import { generateVoteProof } from "../lib/zkproof";

describe("BN254 Field Element Validation (#88)", () => {
  it("has the correct BN254 scalar field modulus (order r)", () => {
    expect(BN254_MODULUS.toString()).toBe(
      "21888242871839275222246405745257275088548364400416034343698204186575808495617",
    );
    expect(BN254_MODULUS_HEX).toBe(
      "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
    );
  });

  describe("isValidFieldElement & assertValidFieldElement", () => {
    it("accepts valid elements strictly below modulus", () => {
      expect(isValidFieldElement(0)).toBe(true);
      expect(isValidFieldElement(0n)).toBe(true);
      expect(isValidFieldElement("0")).toBe(true);
      expect(isValidFieldElement("123456789")).toBe(true);
      expect(isValidFieldElement(123456789n)).toBe(true);

      const maxValid = BN254_MODULUS - 1n;
      expect(isValidFieldElement(maxValid)).toBe(true);
      expect(isValidFieldElement(maxValid.toString())).toBe(true);
      expect(isValidFieldElement("0x" + maxValid.toString(16))).toBe(true);

      expect(() => assertValidFieldElement(0, "testSignal")).not.toThrow();
      expect(() => assertValidFieldElement(maxValid, "testSignal")).not.toThrow();
    });

    it("rejects values exactly equal to BN254_MODULUS", () => {
      expect(isValidFieldElement(BN254_MODULUS)).toBe(false);
      expect(isValidFieldElement(BN254_MODULUS.toString())).toBe(false);
      expect(isValidFieldElement("0x" + BN254_MODULUS_HEX)).toBe(false);

      expect(() => assertValidFieldElement(BN254_MODULUS, "identitySecret")).toThrow(
        /Field element overflow for identitySecret: value .* exceeds or equals BN254 scalar field modulus/,
      );
    });

    it("rejects values greater than BN254_MODULUS (over-field overflow)", () => {
      const overField = BN254_MODULUS + 1n;
      expect(isValidFieldElement(overField)).toBe(false);
      expect(isValidFieldElement(overField.toString())).toBe(false);

      const maxU256 = (1n << 256n) - 1n;
      expect(isValidFieldElement(maxU256)).toBe(false);

      expect(() => assertValidFieldElement(overField, "nullifier")).toThrow(
        /Field element overflow for nullifier/,
      );
    });

    it("rejects negative numbers", () => {
      expect(isValidFieldElement(-1)).toBe(false);
      expect(isValidFieldElement(-1n)).toBe(false);

      expect(() => assertValidFieldElement(-1n, "secret")).toThrow(
        /Field element secret must be non-negative/,
      );
    });

    it("rejects unparseable or non-numeric strings", () => {
      expect(isValidFieldElement("not-a-number")).toBe(false);
      expect(isValidFieldElement("")).toBe(false);
      expect(isValidFieldElement(null)).toBe(false);
      expect(isValidFieldElement(undefined)).toBe(false);
      expect(isValidFieldElement({})).toBe(false);

      expect(() => assertValidFieldElement("invalid", "voteChoice")).toThrow(
        /Invalid field element for voteChoice/,
      );
    });
  });

  describe("Binary Path Indices Validation", () => {
    it("accepts binary path indices (0 and 1)", () => {
      expect(isBinaryPathIndex(0)).toBe(true);
      expect(isBinaryPathIndex(1)).toBe(true);
      expect(isBinaryPathIndex("0")).toBe(true);
      expect(isBinaryPathIndex("1")).toBe(true);
      expect(isBinaryPathIndex(0n)).toBe(true);
      expect(isBinaryPathIndex(1n)).toBe(true);

      expect(() => validateBinaryPathIndices([0, 1, 0, 1, "0", "1"])).not.toThrow();
    });

    it("rejects non-binary values in path indices (e.g. 2, -1, non-integers)", () => {
      expect(isBinaryPathIndex(2)).toBe(false);
      expect(isBinaryPathIndex(-1)).toBe(false);
      expect(isBinaryPathIndex(0.5)).toBe(false);
      expect(isBinaryPathIndex("2")).toBe(false);
      expect(isBinaryPathIndex("left")).toBe(false);

      expect(() => assertBinaryPathIndex(2, "pathIndices[3]")).toThrow(
        /Invalid path index for pathIndices\[3\]: must be binary \(0 or 1\)/,
      );

      expect(() => validateBinaryPathIndices([0, 1, 2, 0])).toThrow(
        /Invalid path index for pathIndices\[2\]: must be binary \(0 or 1\)/,
      );
    });
  });

  describe("validateCircuitInputs", () => {
    const validVoteInput = {
      root: "12345678901234567890",
      nullifier: "98765432109876543210",
      daoId: "1",
      proposalId: "2",
      voteChoice: "1",
      secret: "111222333444",
      salt: "555666777888",
      pathElements: [
        "1000",
        "2000",
        "3000",
      ],
      pathIndices: [0, 1, 0],
    };

    it("passes for completely valid inputs", () => {
      expect(() => validateCircuitInputs(validVoteInput)).not.toThrow();
    });

    it("fails when secret exceeds BN254_MODULUS", () => {
      const overFieldInput = {
        ...validVoteInput,
        secret: (BN254_MODULUS + 100n).toString(),
      };
      expect(() => validateCircuitInputs(overFieldInput)).toThrow(
        /Field element overflow for secret/,
      );
    });

    it("fails when root equals BN254_MODULUS", () => {
      const invalidRootInput = {
        ...validVoteInput,
        root: BN254_MODULUS.toString(),
      };
      expect(() => validateCircuitInputs(invalidRootInput)).toThrow(
        /Field element overflow for root/,
      );
    });

    it("fails when pathElements has an element >= BN254_MODULUS", () => {
      const invalidSiblingInput = {
        ...validVoteInput,
        pathElements: ["1000", BN254_MODULUS.toString(), "3000"],
      };
      expect(() => validateCircuitInputs(invalidSiblingInput)).toThrow(
        /Field element overflow for pathElements\[1\]/,
      );
    });

    it("fails when pathIndices contains a non-binary value", () => {
      const invalidPathIndicesInput = {
        ...validVoteInput,
        pathIndices: [0, 2, 0],
      };
      expect(() => validateCircuitInputs(invalidPathIndicesInput)).toThrow(
        /Invalid path index for pathIndices\[1\]: must be binary \(0 or 1\)/,
      );
    });
  });

  describe("Integration: generateVoteProof & proofService pre-proving validation", () => {
    it("rejects over-field secret before calling prover", async () => {
      const invalidInput = {
        secret: (BN254_MODULUS + 1n).toString(),
        salt: "123",
        blindingFactor: "456",
        root: "789",
        nullifier: "101112",
        daoId: "1",
        proposalId: "1",
        voteChoice: "1",
        relayerAddress: "GABC123",
        commitment: "999",
        pathElements: ["1", "2"],
        pathIndices: [0, 1],
      };

      await expect(
        generateVoteProof(invalidInput, "dummy.wasm", "dummy.zkey"),
      ).rejects.toThrow(/Field element overflow for secret/);
    });

    it("rejects non-binary pathIndices before calling prover", async () => {
      const invalidInput = {
        secret: "123",
        salt: "456",
        blindingFactor: "789",
        root: "101112",
        nullifier: "131415",
        daoId: "1",
        proposalId: "1",
        voteChoice: "0",
        relayerAddress: "GABC123",
        commitment: "999",
        pathElements: ["1", "2"],
        pathIndices: [0, 5], // 5 is invalid
      };

      await expect(
        generateVoteProof(invalidInput, "dummy.wasm", "dummy.zkey"),
      ).rejects.toThrow(/Invalid path index for pathIndices\[1\]: must be binary/);
    });
  });
});
