import { describe, it, expect } from "vitest";
import { workerAvailable } from "./proveInWorker";
import { withMaskedTiming, TIMING_QUANTUM_MS } from "./proofTiming";

describe("worker availability", () => {
  it("reports a boolean without throwing", () => {
    expect(typeof workerAvailable()).toBe("boolean");
  });
});

// The masking boundary sits around the whole prover selection in
// generateVoteProof, so these exercise it there rather than per prover.
describe("timing variance across inputs (#92 benchmark)", () => {
  it("collapses differing proving costs onto one observed bucket", async () => {
    const costs = [5, 40, 120, TIMING_QUANTUM_MS - 10];
    const observed: number[] = [];

    for (const cost of costs) {
      const started = Date.now();
      await withMaskedTiming(async () => {
        await new Promise((r) => setTimeout(r, cost));
        return { proof: "p", publicSignals: [] };
      });
      observed.push(Date.now() - started);
    }

    const buckets = new Set(observed.map((o) => Math.floor(o / TIMING_QUANTUM_MS)));
    expect(buckets.size).toBe(1);

    const spread = Math.max(...observed) - Math.min(...observed);
    expect(spread).toBeLessThan(Math.max(...costs) - Math.min(...costs));
  }, 15000);

  // Whether the Rust prover succeeded, or failed and fell back to snarkjs, is
  // a difference in work done. Masking the selection as a whole keeps that
  // off the clock.
  it("masks a fallback path as thoroughly as a direct one", async () => {
    const direct = Date.now();
    await withMaskedTiming(async () => ({ proof: "p" }));
    const directMs = Date.now() - direct;

    const fellBack = Date.now();
    await withMaskedTiming(async () => {
      try {
        throw new Error("primary prover unavailable");
      } catch {
        await new Promise((r) => setTimeout(r, 30));
        return { proof: "p" };
      }
    });
    const fallbackMs = Date.now() - fellBack;

    expect(Math.floor(directMs / TIMING_QUANTUM_MS)).toBe(
      Math.floor(fallbackMs / TIMING_QUANTUM_MS),
    );
  }, 15000);
});
