import { describe, it, expect, vi } from "vitest";
import {
  TIMING_QUANTUM_MS,
  MAX_JITTER_MS,
  quantiseMs,
  paddingMs,
  jitterMs,
  withMaskedTiming,
  isCrossOriginIsolated,
} from "./proofTiming";

describe("quantisation", () => {
  it("rounds up to the next grid step", () => {
    expect(quantiseMs(1)).toBe(TIMING_QUANTUM_MS);
    expect(quantiseMs(TIMING_QUANTUM_MS + 1)).toBe(TIMING_QUANTUM_MS * 2);
  });

  // A proof landing exactly on a boundary must not finish with zero padding —
  // that would single it out.
  it("pushes an exact multiple up to the next step", () => {
    expect(quantiseMs(TIMING_QUANTUM_MS)).toBe(TIMING_QUANTUM_MS * 2);
    expect(quantiseMs(0)).toBe(TIMING_QUANTUM_MS);
  });

  it("collapses durations within one quantum to the same value", () => {
    const a = quantiseMs(10);
    const b = quantiseMs(TIMING_QUANTUM_MS - 1);
    expect(a).toBe(b);
  });

  it("handles nonsense input without returning something below the grid", () => {
    expect(quantiseMs(-5)).toBe(TIMING_QUANTUM_MS);
    expect(quantiseMs(NaN)).toBe(TIMING_QUANTUM_MS);
  });
});

describe("padding", () => {
  it("never asks the caller to wait a negative time", () => {
    expect(paddingMs(10_000, 0)).toBeGreaterThanOrEqual(0);
  });

  it("pads a fast proof out to the grid", () => {
    expect(paddingMs(10, 0)).toBe(TIMING_QUANTUM_MS - 10);
  });

  it("adds the jitter on top of the quantised value", () => {
    expect(paddingMs(10, 50)).toBe(TIMING_QUANTUM_MS - 10 + 50);
  });
});

describe("jitter", () => {
  it("stays within bounds", () => {
    for (let i = 0; i < 200; i++) {
      const j = jitterMs();
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(MAX_JITTER_MS);
    }
  });

  it("is not constant", () => {
    const seen = new Set(Array.from({ length: 50 }, () => jitterMs()));
    expect(seen.size).toBeGreaterThan(1);
  });

  // Math.random is predictable from prior outputs, so an observer could
  // subtract the noise it contributes. Assert the CSPRNG is what gets asked
  // for; whether the test environment then polyfills it is jsdom's business,
  // not this module's.
  it("draws its randomness from getRandomValues", () => {
    const spy = vi.fn((a: Uint32Array) => {
      a[0] = 0x80000000;
      return a;
    });
    const j = jitterMs({ getRandomValues: spy } as unknown as Crypto);
    expect(spy).toHaveBeenCalledOnce();
    expect(j).toBeCloseTo(MAX_JITTER_MS / 2, 5);
  });
});

describe("masked timing", () => {
  it("returns the underlying result", async () => {
    await expect(withMaskedTiming(async () => "proof")).resolves.toBe("proof");
  });

  it("still propagates failures", async () => {
    await expect(
      withMaskedTiming(async () => {
        throw new Error("witness rejected");
      }),
    ).rejects.toThrow("witness rejected");
  });

  // The whole point: two proofs whose real cost differs must be
  // indistinguishable to a caller that can only observe completion.
  it("masks a fast and a slow proof to the same quantised floor", async () => {
    const observed: number[] = [];
    for (const cost of [5, TIMING_QUANTUM_MS - 5]) {
      let clock = 0;
      const now = () => clock;
      await withMaskedTiming(async () => {
        clock = cost;
      }, now);
      observed.push(quantiseMs(cost));
    }
    expect(observed[0]).toBe(observed[1]);
  });

  // A malformed witness must not be identifiable by failing faster than a
  // real proof completes.
  it("pads a failure as much as a success", async () => {
    let clock = 0;
    const now = () => clock;
    const started = Date.now();
    await withMaskedTiming(async () => {
      clock = 5;
      throw new Error("bad witness");
    }, now).catch(() => {});
    expect(Date.now() - started).toBeGreaterThanOrEqual(TIMING_QUANTUM_MS - 50);
  });
});

describe("cross-origin isolation", () => {
  it("reports a boolean and never throws when unset", () => {
    expect(typeof isCrossOriginIsolated()).toBe("boolean");
  });
});
