/**
 * TTL-Bounded Cache with LRU Eviction
 *
 * Provides a memory-bounded cache with:
 * - Time-to-live (TTL) expiration for automatic cleanup
 * - Maximum entry count with LRU eviction
 * - Metrics for monitoring hit rates and memory usage
 * - Periodic cleanup of expired entries
 */
export interface TtlCacheEntry<T> {
    value: T;
    expiresAt: number;
    accessCount: number;
    lastAccessed: number;
}
export interface TtlCacheConfig {
    ttlMs: number;
    maxEntries: number;
    cleanupIntervalMs?: number;
}
export interface TtlCacheStats {
    size: number;
    maxEntries: number;
    hits: number;
    misses: number;
    evictions: number;
    expirations: number;
    hitRate: number;
}
export declare class TtlCache<K, V> {
    private cache;
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly cleanupIntervalMs;
    private cleanupTimer;
    private hits;
    private misses;
    private evictions;
    private expirations;
    constructor(config: TtlCacheConfig);
    /**
     * Get a value from the cache
     */
    get(key: K): V | undefined;
    /**
     * Set a value in the cache
     */
    set(key: K, value: V, customTtlMs?: number): void;
    /**
     * Check if a key exists and is not expired
     */
    has(key: K): boolean;
    /**
     * Delete a key from the cache
     */
    delete(key: K): boolean;
    /**
     * Clear all entries from the cache
     */
    clear(): void;
    /**
     * Get current cache size
     */
    size(): number;
    /**
     * Get cache statistics
     */
    getStats(): TtlCacheStats;
    /**
     * Evict least recently used entry
     */
    private evictLRU;
    /**
     * Remove expired entries
     */
    private cleanup;
    /**
     * Start periodic cleanup timer
     */
    private startCleanup;
    /**
     * Stop periodic cleanup timer
     */
    stopCleanup(): void;
    /**
     * Get all keys (useful for testing/debugging)
     */
    keys(): K[];
    /**
     * Get all non-expired entries as a Map
     */
    entries(): Map<K, V>;
}
//# sourceMappingURL=ttl-cache.d.ts.map