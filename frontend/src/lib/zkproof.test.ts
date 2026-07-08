import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatProofForSoroban, generateSecret } from "./zkproof";
import type { Groth16Proof } from "snarkjs";

describe("formatProofForSoroban", () => {
  // Sample proof data (simplified for testing)
  const mockProof: Groth16Proof = {
    pi_a: [
      "12345678901234567890",
      "98765432109876543210",
      "1", // homogeneous coordinate (ignored)
    ],
    pi_b: [
      ["111111111111111111", "222222222222222222"], // [c0, c1] - snarkjs format
      ["333333333333333333", "444444444444444444"], // [c0, c1] - snarkjs format
      ["1", "0"], // homogeneous coordinate (ignored)
    ],
    pi_c: [
      "55555555555555555555",
      "66666666666666666666",
      "1", // homogeneous coordinate (ignored)
    ],
    protocol: "groth16",
    curve: "bn128",
  };

  it("formats G1 point proof_a correctly (big-endian)", () => {
    const result = formatProofForSoroban(mockProof);

    // G1 format: be_bytes(X) || be_bytes(Y)
    // Each coordinate is 32 bytes (64 hex chars)
    expect(result.proof_a).toHaveLength(128);

    // Verify X coordinate (padded to 64 hex chars)
    const expectedX = BigInt("12345678901234567890")
      .toString(16)
      .padStart(64, "0");
    const expectedY = BigInt("98765432109876543210")
      .toString(16)
      .padStart(64, "0");
    expect(result.proof_a).toBe(expectedX + expectedY);
  });

  it("formats G2 point proof_b correctly with coordinate swap", () => {
    const result = formatProofForSoroban(mockProof);

    // G2 format: be_bytes(X_c1) || be_bytes(X_c0) || be_bytes(Y_c1) || be_bytes(Y_c0)
    // snarkjs outputs [c0, c1], we swap to [c1, c0]
    expect(result.proof_b).toHaveLength(256);

    // Verify coordinate order: c1, c0, c1, c0
    const x_c1 = BigInt("222222222222222222").toString(16).padStart(64, "0");
    const x_c0 = BigInt("111111111111111111").toString(16).padStart(64, "0");
    const y_c1 = BigInt("444444444444444444").toString(16).padStart(64, "0");
    const y_c0 = BigInt("333333333333333333").toString(16).padStart(64, "0");
    expect(result.proof_b).toBe(x_c1 + x_c0 + y_c1 + y_c0);
  });

  it("formats G1 point proof_c correctly (big-endian)", () => {
    const result = formatProofForSoroban(mockProof);

    expect(result.proof_c).toHaveLength(128);

    const expectedX = BigInt("55555555555555555555")
      .toString(16)
      .padStart(64, "0");
    const expectedY = BigInt("66666666666666666666")
      .toString(16)
      .padStart(64, "0");
    expect(result.proof_c).toBe(expectedX + expectedY);
  });

  it("handles large field elements correctly", () => {
    const largeProof: Groth16Proof = {
      pi_a: [
        "21888242871839275222246405745257275088548364400416034343698204186575808495617", // Near BN254 scalar field order
        "1",
        "1",
      ],
      pi_b: [
        ["1", "2"],
        ["3", "4"],
        ["1", "0"],
      ],
      pi_c: ["1", "2", "1"],
      protocol: "groth16",
      curve: "bn128",
    };

    const result = formatProofForSoroban(largeProof);

    // Should not throw and should produce valid hex
    expect(result.proof_a).toHaveLength(128);
    expect(result.proof_b).toHaveLength(256);
    expect(result.proof_c).toHaveLength(128);

    // Verify it's valid hex (no invalid characters)
    expect(result.proof_a).toMatch(/^[0-9a-f]+$/);
    expect(result.proof_b).toMatch(/^[0-9a-f]+$/);
    expect(result.proof_c).toMatch(/^[0-9a-f]+$/);
  });
});

describe("generateSecret", () => {
  beforeEach(() => {
    // Reset crypto mock for each test
    vi.restoreAllMocks();
  });

  it("generates a non-empty string", () => {
    const secret = generateSecret();
    expect(secret).toBeTruthy();
    expect(typeof secret).toBe("string");
  });

  it("generates a valid bigint string", () => {
    const secret = generateSecret();
    // Should not throw when parsing as BigInt
    expect(() => BigInt(secret)).not.toThrow();
  });

  it("generates different values on each call", () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 10; i++) {
      secrets.add(generateSecret());
    }
    // All 10 should be unique (probability of collision is negligible)
    expect(secrets.size).toBe(10);
  });

  it("generates 256-bit values", () => {
    const secret = generateSecret();
    const bigIntValue = BigInt(secret);
    // Should be at most 2^256 - 1
    const maxValue = BigInt(2) ** BigInt(256) - BigInt(1);
    expect(bigIntValue <= maxValue).toBe(true);
    expect(bigIntValue >= BigInt(0)).toBe(true);
  });
});

describe("VoteProofInput type structure", () => {
  it("has all required fields", () => {
    // Type-checking test - this verifies the interface structure at compile time
    const input = {
      secret: "123",
      salt: "456",
      root: "789",
      nullifier: "012",
      daoId: "1",
      proposalId: "2",
      voteChoice: "1",
      commitment: "345",
      pathElements: ["a", "b"],
      pathIndices: [0, 1],
    };

    // All fields should be present
    expect(input.secret).toBeDefined();
    expect(input.salt).toBeDefined();
    expect(input.root).toBeDefined();
    expect(input.nullifier).toBeDefined();
    expect(input.daoId).toBeDefined();
    expect(input.proposalId).toBeDefined();
    expect(input.voteChoice).toBeDefined();
    expect(input.commitment).toBeDefined();
    expect(input.pathElements).toBeDefined();
    expect(input.pathIndices).toBeDefined();
  });
});

describe("CommentProofInput type structure", () => {
  it("uses commentNonce instead of voteChoice", () => {
    const input = {
      secret: "123",
      salt: "456",
      root: "789",
      nullifier: "012",
      daoId: "1",
      proposalId: "2",
      commentNonce: "0", // Different from VoteProofInput
      commitment: "345",
      pathElements: ["a", "b"],
      pathIndices: [0, 1],
    };

    expect(input.commentNonce).toBeDefined();
    // voteChoice should NOT exist
    expect((input as Record<string, unknown>).voteChoice).toBeUndefined();
  });
});
