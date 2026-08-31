/**
 * Database Performance Monitor
 *
 * Wraps all database operations with timing measurement, slow query logging,
 * EXPLAIN QUERY PLAN analysis, and exposes statistics for diagnostics.
 */
import { config } from "../config.js";
import { dbQueriesTotal, dbQueryDuration, dbSlowQueries, dbCacheHitRate, } from "./metrics.js";
// ============================================
// CONFIGURATION
// ============================================
const SLOW_QUERY_THRESHOLD_MS = Number(process.env.DB_SLOW_QUERY_THRESHOLD_MS) || 100;
const EXPLAIN_THRESHOLD_MS = Number(process.env.DB_EXPLAIN_THRESHOLD_MS) || 500;
const METRICS_WINDOW_SIZE = 1000; // Keep last 1000 query durations
// ============================================
// LOGGER
// ============================================
import { createLogger } from "./logger.js";
const monitorLogger = createLogger("db-monitor");
const log = (level, event, meta = {}) => {
    monitorLogger[level](event, meta);
};
// ============================================
// QUERY METRICS STORE
// ============================================
const queryDurations = [];
let totalQueries = 0;
let slowQueries = 0;
let runningAvgMs = 0;
/**
 * Record a query execution duration and check if it exceeds thresholds.
 * Returns true if the query was slow.
 */
function recordQuery(operation, durationMs, extra) {
    totalQueries++;
    queryDurations.push(durationMs);
    if (queryDurations.length > METRICS_WINDOW_SIZE) {
        queryDurations.shift();
    }
    // Update running average using exponential moving average
    if (runningAvgMs === 0) {
        runningAvgMs = durationMs;
    }
    else {
        runningAvgMs = runningAvgMs * 0.95 + durationMs * 0.05;
    }
    const isSlow = durationMs >= SLOW_QUERY_THRESHOLD_MS;
    if (isSlow) {
        slowQueries++;
        dbSlowQueries.inc();
        log("warn", "slow_query", {
            operation,
            durationMs: Math.round(durationMs),
            thresholdMs: SLOW_QUERY_THRESHOLD_MS,
            avgMs: Math.round(runningAvgMs),
            ...extra,
        });
    }
    // Record Prometheus metrics for every query
    dbQueriesTotal.inc({ operation, status: isSlow ? "slow" : "ok" });
    dbQueryDuration.observe({ operation }, durationMs / 1000);
    // Update cache hit rate gauge
    const total = cacheHits + cacheMisses;
    if (total > 0) {
        dbCacheHitRate.set(cacheHits / total);
    }
    // EXPLAIN complex queries that exceed the explain threshold
    if (durationMs >= EXPLAIN_THRESHOLD_MS && extra?.sql) {
        log("warn", "explain_scheduled", {
            operation,
            durationMs: Math.round(durationMs),
            explainThresholdMs: EXPLAIN_THRESHOLD_MS,
        });
        // EXPLAIN is done asynchronously so it doesn't block the caller
    }
    // Alert on sustained latency degradation (5 consecutive slow queries)
    if (isSlow && runningAvgMs > SLOW_QUERY_THRESHOLD_MS * 2) {
        log("error", "query_latency_degradation", {
            operation,
            avgMs: Math.round(runningAvgMs),
            thresholdMs: SLOW_QUERY_THRESHOLD_MS,
        });
    }
    return isSlow;
}
/**
 * Compute percentile from sorted durations array.
 */
function percentile(sorted, p) {
    if (sorted.length === 0)
        return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}
// ============================================
// TIMING WRAPPER
// ============================================
/**
 * Time a database operation and log if it's slow.
 */
export function timeQuery(operation, fn, extra) {
    const start = performance.now();
    try {
        return fn();
    }
    finally {
        const durationMs = performance.now() - start;
        recordQuery(operation, durationMs, extra);
    }
}
/**
 * Async version of timeQuery for database operations that may involve I/O
 * (like running EXPLAIN ANALYZE or other async monitoring tasks).
 */
export async function timeQueryAsync(operation, fn, extra) {
    const start = performance.now();
    try {
        return await fn();
    }
    finally {
        const durationMs = performance.now() - start;
        recordQuery(operation, durationMs, extra);
    }
}
// ============================================
// EXPLAIN QUERY PLAN
// ============================================
/**
 * Run EXPLAIN QUERY PLAN on the given SQL and log the results.
 * Useful for diagnosing slow queries.
 */
export function analyzeQueryPlan(database, sql, params = []) {
    try {
        const rows = database
            .prepare(`EXPLAIN QUERY PLAN ${sql}`)
            .all(...params);
        const details = rows.map((r) => r.detail).join(" → ");
        log("info", "query_plan", { sql: sql.slice(0, 200), plan: details });
    }
    catch (err) {
        log("warn", "explain_failed", {
            sql: sql.slice(0, 200),
            error: err.message,
        });
    }
}
// ============================================
// TABLE STATISTICS
// ============================================
/**
 * Get row counts and storage statistics for all user tables.
 */
export function getTableStats(database) {
    try {
        // Get all user tables (excluding sqlite_*)
        const tables = database
            .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
            .all();
        return tables.map((t) => {
            let rowCount = 0;
            let pageCount = 0;
            try {
                const countRow = database
                    .prepare(`SELECT COUNT(*) AS cnt FROM "${t.name}"`)
                    .get();
                rowCount = countRow.cnt;
            }
            catch {
                // Some tables may not be accessible
            }
            try {
                // Get page count from sqlite_dbpage or estimate from schema
                const schemaRow = database
                    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
                    .get(t.name);
                pageCount = schemaRow ? schemaRow.sql.length : 0;
            }
            catch {
                // Ignore
            }
            return {
                name: t.name,
                rowCount,
                pageCount,
                schema: "",
            };
        });
    }
    catch (err) {
        log("warn", "table_stats_failed", { error: err.message });
        return [];
    }
}
/**
 * Get detailed table info including row counts, page counts, and schemas.
 */
export function getDetailedTableStats(database) {
    try {
        const tables = database
            .prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
            .all();
        return tables.map((t) => {
            let rowCount = 0;
            try {
                const countRow = database
                    .prepare(`SELECT COUNT(*) AS cnt FROM "${t.name}"`)
                    .get();
                rowCount = countRow.cnt;
            }
            catch {
                // Ignore
            }
            // Estimate page count from row count (rough: ~100 rows per page average)
            const estimatedPages = Math.ceil(rowCount / 100) || 1;
            return {
                name: t.name,
                rowCount,
                pageCount: estimatedPages,
                schema: t.sql || "",
            };
        });
    }
    catch (err) {
        log("warn", "detailed_table_stats_failed", {
            error: err.message,
        });
        return [];
    }
}
const cacheStore = new Map();
let cacheHits = 0;
let cacheMisses = 0;
const DEFAULT_CACHE_TTL_MS = 30_000; // 30 seconds
/**
 * Get a cached value or compute and cache it.
 *
 * Bounded LRU: on hit the entry is moved to the most-recently-used position
 * (Map iteration order); when the store exceeds the configured max size the
 * least-recently-used entries are evicted. This caps memory growth from
 * high-cardinality cache keys whose entries are never explicitly
 * invalidated (see #191).
 */
export function getCachedOrCompute(key, compute, ttlMs = DEFAULT_CACHE_TTL_MS) {
    const now = Date.now();
    const entry = cacheStore.get(key);
    if (entry && entry.expiresAt > now) {
        cacheHits++;
        // Move to MRU position
        cacheStore.delete(key);
        cacheStore.set(key, entry);
        return entry.value;
    }
    cacheMisses++;
    const value = compute();
    cacheStore.delete(key);
    cacheStore.set(key, { value, expiresAt: now + ttlMs });
    evictLruOverflow();
    return value;
}
/**
 * Evict least-recently-used entries once the cache exceeds its configured
 * maximum size.
 */
function evictLruOverflow() {
    const maxEntries = config.dbQueryCacheMaxEntries;
    while (cacheStore.size > maxEntries) {
        const oldestKey = cacheStore.keys().next().value;
        if (oldestKey === undefined)
            break;
        cacheStore.delete(oldestKey);
    }
}
/**
 * Invalidate a cache entry.
 */
export function invalidateCache(key) {
    cacheStore.delete(key);
}
/**
 * Invalidate all cache entries matching a prefix.
 */
export function invalidateCachePrefix(prefix) {
    for (const key of cacheStore.keys()) {
        if (key.startsWith(prefix)) {
            cacheStore.delete(key);
        }
    }
}
/**
 * Get cache hit rate and statistics.
 */
export function getCacheStats() {
    const total = cacheHits + cacheMisses;
    return {
        hits: cacheHits,
        misses: cacheMisses,
        hitRate: total > 0 ? cacheHits / total : 0,
        entries: cacheStore.size,
    };
}
// ============================================
// COMPREHENSIVE STATISTICS
// ============================================
/**
 * Get comprehensive database statistics for diagnostics.
 */
export function getDbStats(database) {
    const sorted = [...queryDurations].sort((a, b) => a - b);
    return {
        queries: {
            total: totalQueries,
            slow: slowQueries,
            avgDurationMs: queryDurations.length > 0 ? runningAvgMs : 0,
            p50Ms: percentile(sorted, 50),
            p95Ms: percentile(sorted, 95),
            p99Ms: percentile(sorted, 99),
            slowestMs: sorted[sorted.length - 1] || 0,
        },
        tables: getDetailedTableStats(database),
        cache: getCacheStats(),
        config: {
            slowThresholdMs: SLOW_QUERY_THRESHOLD_MS,
            explainThresholdMs: EXPLAIN_THRESHOLD_MS,
        },
    };
}
// ============================================
// PROFILE EVENT QUERIES (Acceptance Criteria #8)
// ============================================
/**
 * Profile a specific partition table for a DAO, running EXPLAIN QUERY PLAN
 * on typical queries to verify index usage.
 */
export function profileEventQueries(database, daoId) {
    const tableName = `events_${daoId}`;
    // Verify the table exists before profiling
    const tableExists = database
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(tableName);
    if (!tableExists) {
        log("info", "profile_skip_no_table", { daoId });
        return;
    }
    log("info", "profiling_event_queries", { daoId, table: tableName });
    const queries = [
        // Standard DAO event listing
        `SELECT * FROM "${tableName}" ORDER BY timestamp DESC, ledger DESC LIMIT 50`,
        // Type-filtered query
        `SELECT * FROM "${tableName}" WHERE type IN ('vote_cast') ORDER BY timestamp DESC LIMIT 50`,
        // Verified-only query
        `SELECT * FROM "${tableName}" WHERE verified = 1 ORDER BY timestamp DESC LIMIT 50`,
        // Count query
        `SELECT COUNT(*) FROM "${tableName}" WHERE verified = 1`,
        // Unverified events query
        `SELECT * FROM "${tableName}" WHERE verified = 0 AND tx_hash IS NOT NULL ORDER BY created_at ASC LIMIT 10`,
    ];
    for (const sql of queries) {
        try {
            const planRows = database
                .prepare(`EXPLAIN QUERY PLAN ${sql}`)
                .all();
            log("info", "profile_query_plan", {
                daoId,
                sql: sql.slice(0, 120),
                plan: planRows.map((r) => r.detail).join(" → "),
            });
        }
        catch (err) {
            log("warn", "profile_query_failed", {
                daoId,
                sql: sql.slice(0, 120),
                error: err.message,
            });
        }
    }
    // Run actual timing benchmarks
    log("info", "profiling_benchmark_start", { daoId });
    for (const sql of queries.slice(0, 3)) {
        const start = performance.now();
        try {
            database.prepare(sql).all();
            const durationMs = performance.now() - start;
            log("info", "profile_benchmark", {
                daoId,
                sql: sql.slice(0, 80),
                durationMs: Math.round(durationMs),
            });
        }
        catch (err) {
            log("warn", "profile_benchmark_failed", {
                daoId,
                error: err.message,
            });
        }
    }
    log("info", "profiling_benchmark_complete", { daoId });
    // Verify index usage
    const indexes = database
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_autoindex%'`)
        .all(tableName);
    log("info", "profile_indexes", {
        daoId,
        indexCount: indexes.length,
        indexes: indexes.map((i) => i.name).join(", "),
    });
}
// ============================================
// ALERT THRESHOLD DETECTION
// ============================================
const alertHistory = [];
/**
 * Track alert events for query latency degradation.
 */
export function trackAlert(type, value, threshold) {
    alertHistory.push({
        type,
        value,
        threshold,
        timestamp: new Date().toISOString(),
    });
    // Keep last 100 alerts
    if (alertHistory.length > 100)
        alertHistory.shift();
}
/**
 * Get recent alerts.
 */
export function getRecentAlerts() {
    return [...alertHistory];
}
/**
 * Reset all metrics (for testing).
 */
export function resetMetrics() {
    queryDurations.length = 0;
    totalQueries = 0;
    slowQueries = 0;
    runningAvgMs = 0;
    cacheHits = 0;
    cacheMisses = 0;
    alertHistory.length = 0;
    cacheStore.clear();
}
//# sourceMappingURL=dbMonitor.js.map