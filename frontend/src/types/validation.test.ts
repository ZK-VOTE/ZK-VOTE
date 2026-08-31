/**
 * Tests for #370 – Frontend validation helpers reuse
 *
 * Covers:
 *  - isValidFieldElement: returns true/false for valid/invalid field elements
 *  - assertValidFieldElement: throws on invalid, succeeds on valid
 *  - assertValidNullifier: throws on zero, throws on out-of-range, succeeds on valid
 *  - BN254_FR_MODULUS constant is correct
 */
import { describe, it, expect } from "vitest";
import {
  BN254_FR_MODULUS,
  isValidFieldElement,
  assertValidFieldElement,
  assertValidNullifier,
} from "./index";

// ─── BN254_FR_MODULUS ─────────────────────────────────────────────────────────

describe("BN254_FR_MODULUS", () => {
  it("equals the known BN254 scalar field order", () => {
    expect(BN254_FR_MODULUS).toBe(
      BigInt(
        "21888242871839275222246405745257275088548364400416034343698204186575808495617",
      ),
    );
  });

  it("is strictly less than 2^254", () => {
    expect(BN254_FR_MODULUS < 2n ** 254n).toBe(true);
  });
});

// ─── isValidFieldElement ──────────────────────────────────────────────────────

describe("isValidFieldElement", () => {
  it("accepts zero as a valid field element", () => {
    expect(isValidFieldElement(0n)).toBe(true);
  });

  it("accepts one as a valid field element", () => {
    expect(isValidFieldElement(1n)).toBe(true);
  });

  it("accepts modulus - 1 (max valid field element)", () => {
    expect(isValidFieldElement(BN254_FR_MODULUS - 1n)).toBe(true);
  });

  it("rejects modulus itself (out of range)", () => {
    expect(isValidFieldElement(BN254_FR_MODULUS)).toBe(false);
  });

  it("rejects modulus + 1", () => {
    expect(isValidFieldElement(BN254_FR_MODULUS + 1n)).toBe(false);
  });

  it("rejects negative values", () => {
    expect(isValidFieldElement(-1n)).toBe(false);
  });

  it("accepts a valid hex string (no 0x prefix)", () => {
    expect(
      isValidFieldElement(
        "0000000000000000000000000000000000000000000000000000000000000001",
      ),
    ).toBe(true);
  });

  it("accepts a valid hex string (with 0x prefix)", () => {
    expect(
      isValidFieldElement(
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      ),
    ).toBe(true);
  });

  it("rejects a hex string representing modulus", () => {
    const modulusHex = BN254_FR_MODULUS.toString(16);
    expect(isValidFieldElement(modulusHex)).toBe(false);
  });

  it("accepts string decimal representation of a small value", () => {
    // "123" interpreted as hex -> 0x123 = 291, well within range
    expect(isValidFieldElement("123")).toBe(true);
  });

  it("accepts a mid-range BigInt value", () => {
    const midRange = BN254_FR_MODULUS / 2n;
    expect(isValidFieldElement(midRange)).toBe(true);
  });
});

// ─── assertValidFieldElement ──────────────────────────────────────────────────

describe("assertValidFieldElement", () => {
  it("does not throw for a valid field element (bigint)", () => {
    expect(() => assertValidFieldElement(1n)).not.toThrow();
  });

  it("does not throw for zero", () => {
    expect(() => assertValidFieldElement(0n)).not.toThrow();
  });

  it("does not throw for modulus - 1", () => {
    expect(() => assertValidFieldElement(BN254_FR_MODULUS - 1n)).not.toThrow();
  });

  it("throws for modulus (out of range)", () => {
    expect(() => assertValidFieldElement(BN254_FR_MODULUS)).toThrow(
      /BN254 scalar field modulus/,
    );
  });

  it("throws for negative value", () => {
    expect(() => assertValidFieldElement(-1n)).toThrow(/non-negative/);
  });

  it("includes custom name in error message", () => {
    expect(() => assertValidFieldElement(BN254_FR_MODULUS, "root")).toThrow(
      /root/,
    );
  });

  it("does not throw for valid hex string input", () => {
    const validHex = "0x" + (BN254_FR_MODULUS - 1n).toString(16);
    expect(() => assertValidFieldElement(validHex, "nullifier")).not.toThrow();
  });

  it("throws for hex string representing modulus", () => {
    const modulusHex = "0x" + BN254_FR_MODULUS.toString(16);
    expect(() => assertValidFieldElement(modulusHex)).toThrow();
  });
});

// ─── assertValidNullifier ─────────────────────────────────────────────────────

describe("assertValidNullifier", () => {
  it("does not throw for a non-zero valid nullifier (bigint)", () => {
    expect(() => assertValidNullifier(1n)).not.toThrow();
  });

  it("does not throw for modulus - 1", () => {
    expect(() => assertValidNullifier(BN254_FR_MODULUS - 1n)).not.toThrow();
  });

  it("throws for zero nullifier", () => {
    expect(() => assertValidNullifier(0n)).toThrow(/zero/i);
  });

  it("throws for nullifier equal to modulus", () => {
    expect(() => assertValidNullifier(BN254_FR_MODULUS)).toThrow();
  });

  it("throws for negative nullifier", () => {
    expect(() => assertValidNullifier(-1n)).toThrow();
  });

  it("does not throw for valid non-zero hex string", () => {
    const validHex = "0x" + 42n.toString(16);
    expect(() => assertValidNullifier(validHex)).not.toThrow();
  });

  it("throws for hex string representing zero (0x00)", () => {
    expect(() => assertValidNullifier("0x00")).toThrow(/zero/i);
  });

  it("throws for hex string representing modulus", () => {
    const modulusHex = "0x" + BN254_FR_MODULUS.toString(16);
    expect(() => assertValidNullifier(modulusHex)).toThrow();
  });

  it("does not throw for a large valid nullifier near max range", () => {
    const nearMax = BN254_FR_MODULUS - 2n;
    expect(() => assertValidNullifier(nearMax)).not.toThrow();
  });
});

// ─── Integration: helpers prevent invalid values from entering the system ─────

describe("validation helper integration scenarios", () => {
  it("rejects a Merkle root that exceeds the field modulus", () => {
    const oversizedRoot = BN254_FR_MODULUS + 100n;
    expect(() => assertValidFieldElement(oversizedRoot, "root")).toThrow();
  });

  it("accepts a typical 256-bit Poseidon hash output as a field element", () => {
    // Poseidon outputs are always in the BN254 scalar field
    const poseidonOutput = BigInt(
      "7954706103551041561249684479736668012193906399571749143399785267862256340516",
    );
    expect(() =>
      assertValidFieldElement(poseidonOutput, "commitment"),
    ).not.toThrow();
  });

  it("rejects nullifier zero regardless of representation", () => {
    expect(() => assertValidNullifier(0n)).toThrow();
    expect(() => assertValidNullifier("0x0")).toThrow();
    expect(() => assertValidNullifier("00")).toThrow();
  });

  it("isValidFieldElement and assertValidFieldElement agree on boundary values", () => {
    // At modulus - 1: both should accept
    expect(isValidFieldElement(BN254_FR_MODULUS - 1n)).toBe(true);
    expect(() => assertValidFieldElement(BN254_FR_MODULUS - 1n)).not.toThrow();

    // At modulus: both should reject
    expect(isValidFieldElement(BN254_FR_MODULUS)).toBe(false);
    expect(() => assertValidFieldElement(BN254_FR_MODULUS)).toThrow();
  });
});
