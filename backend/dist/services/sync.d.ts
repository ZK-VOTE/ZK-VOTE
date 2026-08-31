/**
 * Sync Service with Optimistic Concurrency Control (Copy-on-Write Cache Snapshots)
 *
 * Handles DAO and membership synchronization from contracts to local cache.
 * Implements immutable cache snapshots with atomic reference swapping to eliminate
 * race conditions during async interleaving, cache versioning, invalidation notifications,
 * and hit/miss metrics.
 */
import { EventEmitter } from "events";
export interface CacheSnapshot {
    daoMembers: Map<number, Set<string>>;
    daoAdmins: Map<number, string>;
    version: number;
    updatedAt: string;
}
export interface CacheMetrics {
    hits: number;
    misses: number;
    hitRate: number;
    version: number;
    daoCount: number;
}
export declare const cacheEmitter: EventEmitter<[never]>;
/**
 * Get current immutable cache snapshot
 */
export declare function getCacheSnapshot(): CacheSnapshot;
/**
 * Get current cache version counter
 */
export declare function getCacheVersion(): number;
/**
 * Get member set for DAO with metrics tracking
 */
export declare function getDaoMembersFromCache(daoId: number): Set<string> | undefined;
/**
 * Get admin address for DAO with metrics tracking
 */
export declare function getDaoAdminFromCache(daoId: number): string | undefined;
/**
 * Get cache hit/miss metrics
 */
export declare function getCacheMetrics(): CacheMetrics;
/**
 * Register listener for cache invalidation notifications
 */
export declare function onCacheInvalidated(listener: (snapshot: CacheSnapshot) => void): () => void;
/**
 * Evict the oldest entries (in Map insertion order) once a snapshot map
 * exceeds the configured max size. Bounds memory growth of the DAO caches
 * (see #191) — insertion-order (FIFO) eviction is used rather than
 * access-order LRU because these maps are immutable copy-on-write
 * snapshots, and reordering on read would defeat that concurrency design.
 */
export declare function evictOldestOverflow<K, V>(map: Map<K, V>, maxEntries: number): Map<K, V>;
export declare const daoMembersCache: Map<number, Set<string>>;
export declare const daoAdminsCache: Map<number, string>;
/**
 * Sync all DAOs from the DAO Registry contract to local cache
 */
export declare function syncDaosFromContract(): Promise<number>;
/**
 * Start background DAO sync
 */
export declare function startDaoSync(): void;
/**
 * Stop background DAO sync
 */
export declare function stopDaoSync(): void;
/**
 * Sync members for a single DAO (uses Copy-on-Write atomic snapshot update)
 */
export declare function syncDaoMembership(daoId: number): Promise<void>;
/**
 * Sync all memberships (uses Copy-on-Write atomic snapshot update)
 */
export declare function syncAllMemberships(): Promise<void>;
/**
 * Start background membership sync
 */
export declare function startMembershipSync(): void;
/**
 * Stop background membership sync
 */
export declare function stopMembershipSync(): void;
/**
 * Graceful shutdown: flush sequence state so the next process starts clean.
 * Called by the shutdown handler after in-flight submissions have drained.
 */
export declare function gracefulShutdownSync(): Promise<void>;
/**
 * Trigger membership sync for specific DAO
 */
export declare function triggerDaoMembershipSync(daoId: number): Promise<void>;
/**
 * Latency/hit-rate/mismatch metrics for verifyMembership(), for monitoring.
 */
export declare function getMembershipVerificationMetrics(): {
    checks: number;
    chainCalls: number;
    cacheHits: number;
    mismatches: number;
    errors: number;
    avgLatencyMs: number;
    maxLatencyMs: number;
};
/** Test/ops hook: clear the short-TTL verification cache. */
export declare function clearMembershipVerificationCache(): void;
/**
 * Real-time on-chain membership check via the Membership SBT contract's
 * `has(dao_id, of)` read entrypoint — the source of truth for write-path
 * authorization. Results are cached for MEMBERSHIP_VERIFICATION_TTL_MS (30s)
 * to bound RPC load; a cache miss/mismatch against the periodic daoMembersCache
 * is logged for monitoring. Throws if the on-chain check itself cannot be
 * completed (RPC error) — callers should fail closed (reject the write)
 * rather than silently falling back to the periodic cache.
 */
export declare function verifyMembership(daoId: number, address: string): Promise<boolean>;
//# sourceMappingURL=sync.d.ts.map