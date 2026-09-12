/**
 * TTL-Bounded Cache with LRU Eviction
 *
 * Provides a memory-bounded cache with:
 * - Time-to-live (TTL) expiration for automatic cleanup
 * - Maximum entry count with LRU eviction
 * - Metrics for monitoring hit rates and memory usage
 * - Periodic cleanup of expired entries
 */
import { log } from "../services/logger.js";
// ============================================
// TTL-BOUNDED CACHE
// ============================================
export class TtlCache {
    cache = new Map();
    ttlMs;
    maxEntries;
    cleanupIntervalMs;
    cleanupTimer = null;
    // Metrics
    hits = 0;
    misses = 0;
    evictions = 0;
    expirations = 0;
    constructor(config) {
        this.ttlMs = config.ttlMs;
        this.maxEntries = config.maxEntries;
        this.cleanupIntervalMs = config.cleanupIntervalMs ?? Math.max(this.ttlMs / 2, 60000);
        // Start periodic cleanup
        this.startCleanup();
    }
    /**
     * Get a value from the cache
     */
    get(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            this.misses++;
            return undefined;
        }
        // Check if expired
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            this.expirations++;
            this.misses++;
            return undefined;
        }
        // Update access tracking for LRU
        entry.accessCount++;
        entry.lastAccessed = Date.now();
        this.hits++;
        return entry.value;
    }
    /**
     * Set a value in the cache
     */
    set(key, value, customTtlMs) {
        const ttl = customTtlMs ?? this.ttlMs;
        const expiresAt = Date.now() + ttl;
        // Check if we need to evict
        if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
            this.evictLRU();
        }
        this.cache.set(key, {
            value,
            expiresAt,
            accessCount: 0,
            lastAccessed: Date.now(),
        });
    }
    /**
     * Check if a key exists and is not expired
     */
    has(key) {
        const entry = this.cache.get(key);
        if (!entry)
            return false;
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            this.expirations++;
            return false;
        }
        return true;
    }
    /**
     * Delete a key from the cache
     */
    delete(key) {
        return this.cache.delete(key);
    }
    /**
     * Clear all entries from the cache
     */
    clear() {
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
        this.evictions = 0;
        this.expirations = 0;
    }
    /**
     * Get current cache size
     */
    size() {
        return this.cache.size;
    }
    /**
     * Get cache statistics
     */
    getStats() {
        const total = this.hits + this.misses;
        const hitRate = total > 0 ? this.hits / total : 0;
        return {
            size: this.cache.size,
            maxEntries: this.maxEntries,
            hits: this.hits,
            misses: this.misses,
            evictions: this.evictions,
            expirations: this.expirations,
            hitRate: Math.round(hitRate * 1000) / 1000,
        };
    }
    /**
     * Evict least recently used entry
     */
    evictLRU() {
        let oldestKey = null;
        let oldestAccess = Infinity;
        for (const [key, entry] of this.cache.entries()) {
            if (entry.lastAccessed < oldestAccess) {
                oldestAccess = entry.lastAccessed;
                oldestKey = key;
            }
        }
        if (oldestKey !== null) {
            this.cache.delete(oldestKey);
            this.evictions++;
        }
    }
    /**
     * Remove expired entries
     */
    cleanup() {
        const now = Date.now();
        const keysToDelete = [];
        for (const [key, entry] of this.cache.entries()) {
            if (now > entry.expiresAt) {
                keysToDelete.push(key);
            }
        }
        for (const key of keysToDelete) {
            this.cache.delete(key);
            this.expirations++;
        }
        if (keysToDelete.length > 0) {
            log("debug", "cache_cleanup", {
                removed: keysToDelete.length,
                remaining: this.cache.size,
            });
        }
    }
    /**
     * Start periodic cleanup timer
     */
    startCleanup() {
        if (this.cleanupTimer)
            return;
        this.cleanupTimer = setInterval(() => {
            this.cleanup();
        }, this.cleanupIntervalMs);
        // Don't keep the process alive for cleanup
        if (this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }
    /**
     * Stop periodic cleanup timer
     */
    stopCleanup() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
    /**
     * Get all keys (useful for testing/debugging)
     */
    keys() {
        return Array.from(this.cache.keys());
    }
    /**
     * Get all non-expired entries as a Map
     */
    entries() {
        const now = Date.now();
        const result = new Map();
        for (const [key, entry] of this.cache.entries()) {
            if (now <= entry.expiresAt) {
                result.set(key, entry.value);
            }
        }
        return result;
    }
}
//# sourceMappingURL=ttl-cache.js.map