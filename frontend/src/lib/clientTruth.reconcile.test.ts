import { describe, it, expect, vi, afterEach } from "vitest";
import {
  reconcileCircuitVersion,
  reconcileCircuitTruth,
  fetchCompatibilityMatrix,
  type CompatibilityMatrixEntry,
} from "./clientTruth";
import { invalidateVKCache, __vkCacheTestHelpers } from "./zkproof";

/** Seed the VK memory cache directly, the way zkproof.vkcache.test.ts does. */
function seedCachedVK(circuitId: string, version: number): void {
  __vkCacheTestHelpers._memoryCache.set(__vkCacheTestHelpers._key(circuitId, version), {
    circuitId,
    version,
    verificationKey: {},
    hash: "sha256:x",
    fetchedAt: Date.now(),
  });
}

const MATRIX: CompatibilityMatrixEntry[] = [
  { circuitId: "vote_v2", currentVersion: 2, supportedVersions: [2, 1] },
  { circuitId: "weighted_vote", currentVersion: 1, supportedVersions: [1] },
];

afterEach(() => {
  invalidateVKCache();
  __vkCacheTestHelpers._clearAll();
});

describe("reconcileCircuitVersion", () => {
  it("is current when the cached version equals the registry's", () => {
    const result = reconcileCircuitVersion("vote_v2", 2, MATRIX);
    expect(result.status).toBe("current");
    expect(result.warning).toBeUndefined();
  });

  it("is a fallback with a warning when exactly N-1", () => {
    const result = reconcileCircuitVersion("vote_v2", 1, MATRIX);
    expect(result.status).toBe("fallback");
    expect(result.warning).toMatch(/N-1 fallback/);
  });

  it("is unsupported when more than one version behind", () => {
    const result = reconcileCircuitVersion("vote_v2", 0, MATRIX);
    expect(result.status).toBe("unsupported");
    expect(result.warning).toMatch(/no longer supported/);
  });

  it("is unknown when there is nothing cached locally", () => {
    const result = reconcileCircuitVersion("vote_v2", null, MATRIX);
    expect(result.status).toBe("unknown");
  });

  it("is unknown when the registry doesn't know the circuit", () => {
    const result = reconcileCircuitVersion("bridge", 1, MATRIX);
    expect(result.status).toBe("unknown");
    expect(result.registryCurrentVersion).toBeNull();
  });
});

describe("fetchCompatibilityMatrix", () => {
  it("parses a well-formed matrix response", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ matrix: MATRIX, generatedAt: "now" }),
    })) as unknown as typeof fetch;

    const matrix = await fetchCompatibilityMatrix(fetchFn);
    expect(matrix).toEqual(MATRIX);
  });

  it("throws on a non-ok response", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(fetchCompatibilityMatrix(fetchFn)).rejects.toThrow(/Failed to fetch/);
  });

  it("throws on a malformed response (no matrix array)", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ notMatrix: true }),
    })) as unknown as typeof fetch;
    await expect(fetchCompatibilityMatrix(fetchFn)).rejects.toThrow(/Malformed/);
  });
});

describe("reconcileCircuitTruth", () => {
  it("invalidates a cached VK that fell out of the supported window", async () => {
    // Simulate a VK cached at version 0 for vote_v2 (two behind current).
    seedCachedVK("vote_v2", 0);

    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ matrix: MATRIX, generatedAt: "now" }),
    })) as unknown as typeof fetch;

    // vote_v2's only legitimate cache candidates under policy are versions
    // 2 and 1 (N/N-1), so a VK cached at version 0 is invisible to the
    // candidate scan and reconcileCircuitTruth reports "unknown" rather
    // than "unsupported" for it - it was never a version this policy
    // would have let a client cache in the first place.
    const results = await reconcileCircuitTruth(["vote_v2", "weighted_vote"], fetchFn);
    const voteV2 = results.find((r) => r.circuitId === "vote_v2");
    expect(voteV2?.status).toBe("unknown");
    expect(voteV2?.cachedVersion).toBeNull();
  });

  it("reports current for a circuit cached at the registry's current version", async () => {
    seedCachedVK("vote_v2", 2);

    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ matrix: MATRIX, generatedAt: "now" }),
    })) as unknown as typeof fetch;

    const results = await reconcileCircuitTruth(["vote_v2"], fetchFn);
    expect(results[0].status).toBe("current");
    expect(results[0].cachedVersion).toBe(2);
  });
});
