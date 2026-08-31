import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchVersionedVK,
  getCachedVK,
  invalidateVKCache,
  detectVKMismatch,
  VKMismatchError,
  StaleVKError,
  VK_CACHE_TTL_MS,
  __vkCacheTestHelpers,
} from "./zkproof";

describe("Versioned VK cache", () => {
  beforeEach(() => {
    invalidateVKCache();
    __vkCacheTestHelpers._clearAll();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("fetches versioned VK and caches it", async () => {
    const mockVK = { alpha: "a", beta: "b", ic: [] };
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ vk: mockVK, version: 1, hash: "hash1" }),
    } as unknown as Response);

    const vk1 = await fetchVersionedVK(
      "vote_v1",
      1,
      fetchFn as unknown as typeof fetch,
    );
    expect(vk1.circuitId).toBe("vote_v1");
    expect(vk1.version).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Second fetch should hit cache (no second network call)
    const vk2 = await fetchVersionedVK(
      "vote_v1",
      1,
      fetchFn as unknown as typeof fetch,
    );
    expect(vk2.hash).toBe("hash1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("stale version rejected with 410", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 410,
      text: () => Promise.resolve("stale"),
    } as unknown as Response);

    await expect(
      fetchVersionedVK("vote_v1", 1, fetchFn as unknown as typeof fetch),
    ).rejects.toThrow(StaleVKError);
    expect(getCachedVK("vote_v1", 1)).toBeNull();
  });

  it("invalidate clears cache", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ vk: {}, version: 1, hash: "h" }),
    } as unknown as Response);
    await fetchVersionedVK("vote_v1", 1, fetchFn as unknown as typeof fetch);
    expect(getCachedVK("vote_v1", 1)).not.toBeNull();
    invalidateVKCache("vote_v1", 1);
    expect(getCachedVK("vote_v1", 1)).toBeNull();
  });

  it("detects VK mismatch", () => {
    expect(() => detectVKMismatch(2, 1)).toThrow(VKMismatchError);
    expect(() => detectVKMismatch(1, 1)).not.toThrow();
  });

  it("cache TTL expires", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ vk: {}, version: 1, hash: "h" }),
    } as unknown as Response);
    await fetchVersionedVK("vote_v1", 1, fetchFn as unknown as typeof fetch);
    // Manually expire by manipulating fetchedAt
    const entry = __vkCacheTestHelpers._memoryCache.get(
      __vkCacheTestHelpers._key("vote_v1", 1),
    );
    if (entry) entry.fetchedAt = Date.now() - VK_CACHE_TTL_MS - 1000;
    expect(getCachedVK("vote_v1", 1)).toBeNull();
  });
});
