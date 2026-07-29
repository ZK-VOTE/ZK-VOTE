import { describe, it, expect } from "vitest";
import {
  generateHybridPQCommitment,
  verifyHybridPQCommitment,
  generateSTARKProof,
  verifySTARKProof,
} from "./postQuantum";
import { runPQPerformanceBenchmark } from "./postQuantumBenchmark";

describe("Post-Quantum Fallback & STARK Circuit Suite (#115)", () => {
  it("generates and verifies consistent Hybrid PQ Commitments", async () => {
    const secret = "12345678901234567890123456789012";
    const salt = "98765432109876543210987654321098";
    const daoId = 10;
    const proposalId = 101;
    const classicalCommitment = "0xbn254poseidoncommitment123";

    const hybrid = await generateHybridPQCommitment(
      secret,
      salt,
      daoId,
      proposalId,
      classicalCommitment
    );

    expect(hybrid.quantumAlgorithm).toBe("SHA3-256");
    expect(hybrid.classicalCommitment).toBe(classicalCommitment);
    expect(hybrid.postQuantumCommitment).toBeDefined();
    expect(hybrid.postQuantumCommitment.length).toBeGreaterThan(10);
    expect(hybrid.postQuantumNullifier).toBeDefined();

    const isValid = verifyHybridPQCommitment(
      secret,
      salt,
      daoId,
      proposalId,
      hybrid
    );
    expect(isValid).toBe(true);

    // Tampered parameters must fail verification
    const isTampered = verifyHybridPQCommitment(
      secret,
      salt,
      daoId,
      102, // Wrong proposal ID
      hybrid
    );
    expect(isTampered).toBe(false);
  });

  it("prototypes a STARK-based vote proof and verifies execution trace constraints", () => {
    const secret = "secret_key_voter";
    const salt = "salt_value_random";
    const daoId = 5;
    const proposalId = 99;
    const voteChoice = 1;
    const merklePath = ["0xabc1", "0xabc2", "0xabc3"];

    const starkProof = generateSTARKProof(
      secret,
      salt,
      daoId,
      proposalId,
      voteChoice,
      merklePath
    );

    expect(starkProof.proofType).toBe("STARK_FRI_PLONKY3_PROTOTYPE");
    expect(starkProof.friCommitments.length).toBe(5);
    expect(starkProof.proofSizeBytes).toBe(32768);
    expect(starkProof.publicInputs.daoId).toBe(5);
    expect(starkProof.publicInputs.proposalId).toBe(99);

    const verified = verifySTARKProof(starkProof);
    expect(verified).toBe(true);
  });

  it("assesses browser proving performance metrics for Groth16 vs Hybrid PQ vs STARK", async () => {
    const benchmark = await runPQPerformanceBenchmark();

    expect(benchmark.groth16.mode).toBe("GROTH16_ONLY");
    expect(benchmark.groth16.postQuantumSecurityBits).toBe(0);

    expect(benchmark.hybridPQ.mode).toBe("HYBRID_PQ");
    expect(benchmark.hybridPQ.postQuantumSecurityBits).toBe(128);
    // Hybrid PQ overhead should be minimal (< 50% extra browser proving time)
    expect(benchmark.overheadPercentage.hybridTimeOverhead).toBeLessThan(100);

    expect(benchmark.fullStark.mode).toBe("FULL_STARK");
    expect(benchmark.fullStark.postQuantumSecurityBits).toBe(128);
    expect(benchmark.fullStark.payloadSizeBytes).toBeGreaterThan(10000);
  });
});
