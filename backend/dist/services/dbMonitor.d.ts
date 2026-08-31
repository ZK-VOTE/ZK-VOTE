/**
 * Database Performance Monitor
 *
 * Wraps all database operations with timing measurement, slow query logging,
 * EXPLAIN QUERY PLAN analysis, and exposes statistics for diagnostics.
 */
import { type Database as DatabaseType } from "better-sqlite3";
export interface QueryMetrics {
    operation: string;
    durationMs: number;
    slow: boolean;
    timestamp: string;
    extra?: Record<string, unknown>;
}
export interface DbStats {
    queries: {
        total: number;
        slow: number;
        avgDurationMs: number;
        p50Ms: number;
        p95Ms: number;
        p99Ms: number;
        slowestMs: number;
    };
    tables: Array<{
        name: string;
        rowCount: number;
        pageCount: number;
        schema: string;
    }>;
    cache: {
        hitRate: number;
        hits: number;
        misses: number;
        entries: number;
    };
    config: {
        slowThresholdMs: number;
        explainThresholdMs: number;
    };
}
/**
 * Time a database operation and log if it's slow.
 */
export declare function timeQuery<T>(operation: string, fn: () => T, extra?: Record<string, unknown>): T;
/**
 * Async version of timeQuery for database operations that may involve I/O
 * (like running EXPLAIN ANALYZE or other async monitoring tasks).
 */
export declare function timeQueryAsync<T>(operation: string, fn: () => Promise<T>, extra?: Record<string, unknown>): Promise<T>;
/**
 * Run EXPLAIN QUERY PLAN on the given SQL and log the results.
 * Useful for diagnosing slow queries.
 */
export declare function analyzeQueryPlan(database: DatabaseType, sql: string, params?: unknown[]): void;
/**
 * Get row counts and storage statistics for all user tables.
 */
export declare function getTableStats(database: DatabaseType): DbStats["tables"];
/**
 * Get detailed table info including row counts, page counts, and schemas.
 */
export declare function getDetailedTableStats(database: DatabaseType): DbStats["tables"];
/**
 * Get a cached value or compute and cache it.
 *
 * Bounded LRU: on hit the entry is moved to the most-recently-used position
 * (Map iteration order); when the store exceeds the configured max size the
 * least-recently-used entries are evicted. This caps memory growth from
 * high-cardinality cache keys whose entries are never explicitly
 * invalidated (see #191).
 */
export declare function getCachedOrCompute<T>(key: string, compute: () => T, ttlMs?: number): T;
/**
 * Invalidate a cache entry.
 */
export declare function invalidateCache(key: string): void;
/**
 * Invalidate all cache entries matching a prefix.
 */
export declare function invalidateCachePrefix(prefix: string): void;
/**
 * Get cache hit rate and statistics.
 */
export declare function getCacheStats(): DbStats["cache"];
/**
 * Get comprehensive database statistics for diagnostics.
 */
export declare function getDbStats(database: DatabaseType): DbStats;
/**
 * Profile a specific partition table for a DAO, running EXPLAIN QUERY PLAN
 * on typical queries to verify index usage.
 */
export declare function profileEventQueries(database: DatabaseType, daoId: number): void;
declare const alertHistory: Array<{
    type: string;
    value: number;
    threshold: number;
    timestamp: string;
}>;
/**
 * Track alert events for query latency degradation.
 */
export declare function trackAlert(type: string, value: number, threshold: number): void;
/**
 * Get recent alerts.
 */
export declare function getRecentAlerts(): typeof alertHistory;
/**
 * Reset all metrics (for testing).
 */
export declare function resetMetrics(): void;
export {};
//# sourceMappingURL=dbMonitor.d.ts.map