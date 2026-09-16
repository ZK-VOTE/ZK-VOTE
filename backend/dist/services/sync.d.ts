/**
 * Sync Service with Optimistic Concurrency Control (Copy-on-Write Cache Snapshots)
 *
 * Handles DAO and membership synchronization from contracts to local cache.
 * Implements immutable cache snapshots with atomic reference swapping to eliminate
 * race conditions during async interleaving, cache versioning, invalidation notifications,
 * and hit/miss metrics.
 */
import { EventEmitter } from "events";
import * as StellarSdk from "@stellar/stellar-sdk";
import type { DaoInput } from "./db.js";
import type { DaoData } from "./indexer.js";
import type { RpcServerPort, LoggerPort } from "./interfaces.js";
import type { Dao } from "../types/index.js";
/**
 * Persistence surface needed by the sync service (#358). Structurally typed
 * so unit tests can inject an in-memory fake.
 */
export interface SyncDbPort {
    getAllCachedDaos(): Array<Pick<Dao, "id" | "creator">>;
    upsertDaos(daos: DaoInput[]): void;
    setDaosSyncTime(timestamp: string): void;
}
/**
 * Dependencies of the sync service, injected explicitly via `initSyncService`
 * (called by the composition root) so this module never imports the
 * `stellar.js`/`db.js`/`logger.js`/`service-health.js`/`indexer.js` module
 * singletons to get what it needs (#358). Prometheus metrics (`metrics.js`)
 * are intentionally still module-scoped — they are process-global counters
 * by design and outside #358's scope.
 */
export interface SyncDeps {
    /** Active RPC server (pool-backed proxy in production). */
    server: RpcServerPort;
    /** Relayer keypair used for read calls to the contracts. */
    relayerKeypair: {
        publicKey(): string;
    } & Partial<StellarSdk.Keypair>;
    /** Run `fn` with a timeout, labelled for logs/metrics. */
    callWithTimeout<T>(fn: () => Promise<T>, label: string): Promise<T>;
    /** Simulate a transaction with retry/backoff. */
    simulateWithBackoff<T>(fn: () => Promise<T>, attempts?: number): Promise<T>;
    /** Sequence manager used to flush state at shutdown. */
    sequenceManager: {
        forceResync(server: StellarSdk.rpc.Server): Promise<void>;
    };
    /** Config: max entries per snapshot cache (FIFO eviction, #191). */
    maxCachedDaos: number;
    /** Config: DAO registry contract id. */
    daoRegistryContractId?: string;
    /** Config: membership SBT contract id. */
    membershipSbtContractId?: string;
    /** Config: Stellar network passphrase. */
    networkPassphrase: string;
    /** Config: DAO sync interval (ms). */
    daoSyncIntervalMs: number;
    /** Config: membership sync interval (ms). */
    membershipSyncIntervalMs: number;
    /** DAO/metadata persistence (events store). */
    dbService: SyncDbPort;
    /** Backfill the dao_create event for a freshly synced DAO. */
    ensureDaoCreateEvent(daoId: number, daoData: DaoData): boolean;
    /** Health reporting for the background sync loops. */
    markHealthy(service: "dao_sync"): void;
    markDegraded(service: "dao_sync", reason?: string): void;
    /** Structured logger (called as `deps.log(level, event, meta)`). */
    log: LoggerPort["log"];
}
/** Explicitly wire the sync service (composition root only). */
export declare function initSyncService(d: SyncDeps): void;
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
export declare const cacheEmitter: EventEmitter;
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