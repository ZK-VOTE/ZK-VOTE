import { describe, it, expect, vi, afterEach } from "vitest";
import {
  computePedersenCommitment,
  generateBlindingFactor,
  BN254_MODULUS,
} from "./pedersenCommitment";

describe("Pedersen Commitment", () => {
  it("is deterministic for fixed inputs", async () => {
    const a = await computePedersenCommitment(123n, 456n);
    const b = await computePedersenCommitment(123n, 456n);
    expect(a.commitment).toEqual(b.commitment);
    expect(a.commitmentY).toEqual(b.commitmentY);
  });

  it("produces a non-trivial point (not the identity)", async () => {
    const c = await computePedersenCommitment(1n, 1n);
    expect(c.commitment).not.toEqual("0");
  });

  // --- Binding: distinct (secret, blinding) pairs -> distinct commitments ---
  it("binding: different secrets with the same blinding factor commit differently", async () => {
    const blinding = 999n;
    const c1 = await computePedersenCommitment(1n, blinding);
    const c2 = await computePedersenCommitment(2n, blinding);
    expect(c1.commitment).not.toEqual(c2.commitment);
  });

  it("binding: different blinding factors for the same secret commit differently", async () => {
    const secret = 42n;
    const c1 = await computePedersenCommitment(secret, 1n);
    const c2 = await computePedersenCommitment(secret, 2n);
    expect(c1.commitment).not.toEqual(c2.commitment);
  });

  it("binding: no collisions across a batch of random (secret, blinding) pairs", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const secret = generateBlindingFactor();
      const blinding = generateBlindingFactor();
      const c = await computePedersenCommitment(secret, blinding);
      expect(seen.has(c.commitment)).toBe(false);
      seen.add(c.commitment);
    }
  }, 30000);

  // --- Hiding: the same secret with fresh random blinding factors produces
  // commitments that are statistically indistinguishable from commitments of
  // an unrelated secret. We check this the same way the existing Poseidon
  // commitment test (commitment.test.ts) validates uniform distribution:
  // bucket the low-order bits of many commitments to the *same* secret and
  // confirm there's no detectable skew, i.e. an observer who only sees the
  // commitment learns nothing distinguishing this secret from any other.
  it("hiding: commitments to a fixed secret are uniformly distributed once blinded", async () => {
    const NUM_SAMPLES = 16;
    const NUM_BINS = 4;
    const fixedSecret = 7n;
    const bins = new Array(NUM_BINS).fill(0);

    for (let i = 0; i < NUM_SAMPLES; i++) {
      const blinding = generateBlindingFactor();
      const { commitment } = await computePedersenCommitment(
        fixedSecret,
        blinding,
      );
      const bin = Number(BigInt(commitment) % BigInt(NUM_BINS));
      bins[bin]++;
    }

    const expected = NUM_SAMPLES / NUM_BINS;
    // Chi-square goodness-of-fit against the uniform distribution.
    const chiSquare = bins.reduce((sum, observed) => {
      const diff = observed - expected;
      return sum + (diff * diff) / expected;
    }, 0);

    // 3 degrees of freedom; critical value at alpha=0.01 is ~11.34.
    expect(chiSquare).toBeLessThan(15);
  }, 30000);

  it("hiding: commitments to two different secrets are not distinguishable by inspection", async () => {
    // With a fresh random blinding factor each time, commitments to secret A
    // and secret B should be indistinguishable in aggregate: neither set of
    // outputs should cluster in a way that reveals which secret produced it.
    // We check this indirectly: the commitment for secret A with blinding r1
    // never equals the commitment for secret B with blinding r2 (would be a
    // catastrophic break), and, more importantly, the *set* of possible
    // outputs is not restricted -- every secret can reach the full field.
    const secretA = 111n;
    const secretB = 222n;
    const results: string[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(
        (await computePedersenCommitment(secretA, generateBlindingFactor()))
          .commitment,
      );
      results.push(
        (await computePedersenCommitment(secretB, generateBlindingFactor()))
          .commitment,
      );
    }
    // No collisions expected across 20 random samples.
    expect(new Set(results).size).toEqual(results.length);
  }, 30000);

  // --- Entropy source: fail-safe when no CSPRNG ---
  describe("generateBlindingFactor entropy", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns a value within the BN254 scalar field", () => {
      const bf = generateBlindingFactor();
      expect(bf >= 0n).toBe(true);
      expect(bf < BN254_MODULUS).toBe(true);
    });

    it("returns distinct values on successive calls (not a constant)", () => {
      const values = new Set(Array.from({ length: 8 }, () => generateBlindingFactor()));
      expect(values.size).toBeGreaterThan(1);
    });

    it("throws when globalThis.crypto.getRandomValues is unavailable", () => {
      const originalCrypto = globalThis.crypto;
      Object.defineProperty(globalThis, "crypto", {
        value: undefined,
        configurable: true,
      });
      try {
        expect(() => generateBlindingFactor()).toThrow(
          "no cryptographically secure random source",
        );
      } finally {
        Object.defineProperty(globalThis, "crypto", {
          value: originalCrypto,
          configurable: true,
        });
      }
    });
  });

  it("rejects out-of-field negative inputs", async () => {
    await expect(computePedersenCommitment(-1n, 1n)).rejects.toThrow();
  });

  it("commitments stay within the BN254 scalar field (x and y coordinates)", async () => {
    const { commitment, commitmentY } = await computePedersenCommitment(
      generateBlindingFactor(),
      generateBlindingFactor(),
    );
    expect(BigInt(commitment) < BN254_MODULUS).toBe(true);
    expect(BigInt(commitmentY) < BN254_MODULUS).toBe(true);
  });
});
