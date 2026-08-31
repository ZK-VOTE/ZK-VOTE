/**
 * Prometheus Metrics Service
 *
 * Central metrics registry for all application metrics.
 * Uses prom-client for Prometheus-compatible export.
 */

import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";

// ============================================
// REGISTRY
// ============================================

export const register = new Registry();

// Collect default Node.js runtime metrics (memory, GC, event loop, CPU)
collectDefaultMetrics({
  register,
  prefix: "zkvote_",
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
  eventLoopMonitoringPrecision: 10,
});

// ============================================
// HTTP REQUEST METRICS
// ============================================

export const httpRequestsTotal = new Counter({
  name: "zkvote_http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [register],
});

export const httpRequestDuration = new Histogram({
  name: "zkvote_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestSize = new Histogram({
  name: "zkvote_http_request_size_bytes",
  help: "HTTP request body size in bytes",
  labelNames: ["method", "route"] as const,
  buckets: [100, 500, 1000, 5000, 10000, 50000, 100000],
  registers: [register],
});

export const httpRequestsInFlight = new Gauge({
  name: "zkvote_http_requests_in_flight",
  help: "HTTP requests currently being served (concurrency / backpressure signal)",
  labelNames: ["method", "route"] as const,
  registers: [register],
});

export const httpResponseSize = new Histogram({
  name: "zkvote_http_response_size_bytes",
  help: "HTTP response body size in bytes",
  labelNames: ["method", "route", "status"] as const,
  buckets: [100, 500, 1000, 5000, 10000, 50000, 100000],
  registers: [register],
});

// ============================================
// COALESCING METRICS
// ============================================

export const coalescingHitsTotal = new Counter({
  name: "zkvote_coalescing_hits_total",
  help: "Total request coalescing hits",
  labelNames: ["key"] as const,
  registers: [register],
});

export const coalescingMissesTotal = new Counter({
  name: "zkvote_coalescing_misses_total",
  help: "Total request coalescing misses (original requests)",
  labelNames: ["key"] as const,
  registers: [register],
});

export const coalescingWaitTime = new Histogram({
  name: "zkvote_coalescing_wait_time_seconds",
  help: "Time spent waiting for coalesced requests in seconds",
  labelNames: ["key"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

// ============================================
// MEMBERSHIP REGISTRATION METRICS (#371)
// ============================================

export const membershipRegistrationTotal = new Counter({
  name: "zkvote_membership_registration_requests_total",
  help: "Total commitment registration requests served by the membership route",
  labelNames: ["dao_id"] as const,
  registers: [register],
});

export const membershipRegistrationLimited = new Counter({
  name: "zkvote_membership_registration_limited_total",
  help: "Commitment registration requests blocked by rate limiting or the on-chain registration cooldown",
  labelNames: ["reason"] as const,
  registers: [register],
});

// ============================================
// SOROBAN RPC METRICS
// ============================================

export const rpcCallsTotal = new Counter({
  name: "zkvote_rpc_calls_total",
  help: "Total Soroban RPC calls",
  labelNames: ["method", "status"] as const,
  registers: [register],
});

export const rpcCallDuration = new Histogram({
  name: "zkvote_rpc_call_duration_seconds",
  help: "Soroban RPC call duration in seconds",
  labelNames: ["method", "status"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

export const rpcErrors = new Counter({
  name: "zkvote_rpc_errors_total",
  help: "Total Soroban RPC errors",
  labelNames: ["method", "error_type"] as const,
  registers: [register],
});

export const rpcPoolHealthyEndpoints = new Gauge({
  name: "zkvote_rpc_pool_healthy_endpoints",
  help: "Number of healthy RPC endpoints in pool",
  registers: [register],
});

export const rpcPoolTotalEndpoints = new Gauge({
  name: "zkvote_rpc_pool_total_endpoints",
  help: "Total number of RPC endpoints in pool",
  registers: [register],
});

export const rpcEndpointLatency = new Gauge({
  name: "zkvote_rpc_endpoint_latency_seconds",
  help: "RPC endpoint latency in seconds",
  labelNames: ["url"] as const,
  registers: [register],
});

// ============================================
// DATABASE METRICS
// ============================================

export const dbQueriesTotal = new Counter({
  name: "zkvote_db_queries_total",
  help: "Total database queries",
  labelNames: ["operation", "status"] as const,
  registers: [register],
});

export const dbQueryDuration = new Histogram({
  name: "zkvote_db_query_duration_seconds",
  help: "Database query duration in seconds",
  labelNames: ["operation"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const dbConnectionsActive = new Gauge({
  name: "zkvote_db_connections_active",
  help: "Number of active database connections",
  registers: [register],
});

export const dbWalSizeBytes = new Gauge({
  name: "zkvote_db_wal_size_bytes",
  help: "Database WAL file size in bytes",
  registers: [register],
});

export const dbSlowQueries = new Counter({
  name: "zkvote_db_slow_queries_total",
  help: "Total number of slow database queries",
  registers: [register],
});

export const dbCacheHitRate = new Gauge({
  name: "zkvote_db_cache_hit_rate",
  help: "Database cache hit rate",
  registers: [register],
});

export const dbReadLagMs = new Gauge({
  name: "zkvote_db_read_lag_ms",
  help: "Estimated lag of the read connection behind the write connection in milliseconds",
  registers: [register],
});

export const dbWriteFailoverTotal = new Counter({
  name: "zkvote_db_write_failover_total",
  help: "Write connection failover / reconnect attempts",
  labelNames: ["result"] as const,
  registers: [register],
});

export const dbWriteHealthy = new Gauge({
  name: "zkvote_db_write_healthy",
  help: "1 if the write SQLite connection is healthy, else 0",
  registers: [register],
});

// ============================================
// IPFS METRICS
// ============================================

export const ipfsPinsTotal = new Counter({
  name: "zkvote_ipfs_pins_total",
  help: "Total IPFS pin operations",
  labelNames: ["type", "status"] as const,
  registers: [register],
});

export const ipfsFetchDuration = new Histogram({
  name: "zkvote_ipfs_fetch_duration_seconds",
  help: "IPFS fetch duration in seconds",
  labelNames: ["type"] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

export const ipfsCacheHits = new Counter({
  name: "zkvote_ipfs_cache_hits_total",
  help: "Total IPFS cache hits",
  registers: [register],
});

export const ipfsCacheMisses = new Counter({
  name: "zkvote_ipfs_cache_misses_total",
  help: "Total IPFS cache misses",
  registers: [register],
});

export const ipfsPinsVerified = new Gauge({
  name: "zkvote_ipfs_pins_verified",
  help: "Number of verified IPFS pins",
  registers: [register],
});

export const ipfsPinsFailed = new Gauge({
  name: "zkvote_ipfs_pins_failed",
  help: "Number of failed IPFS pins",
  registers: [register],
});

// ============================================
// BACKGROUND SERVICE METRICS
// ============================================

export const serviceLastRunTime = new Gauge({
  name: "zkvote_service_last_run_timestamp_seconds",
  help: "Last successful run timestamp of background service",
  labelNames: ["service"] as const,
  registers: [register],
});

export const serviceErrors = new Counter({
  name: "zkvote_service_errors_total",
  help: "Total errors from background service",
  labelNames: ["service"] as const,
  registers: [register],
});

export const serviceProcessingLag = new Gauge({
  name: "zkvote_service_processing_lag_seconds",
  help: "Processing lag of background service in seconds",
  labelNames: ["service"] as const,
  registers: [register],
});

export const serviceRunning = new Gauge({
  name: "zkvote_service_running",
  help: "Whether background service is currently running (1) or stopped (0)",
  labelNames: ["service"] as const,
  registers: [register],
});

// ============================================
// BUSINESS METRICS
// ============================================

export const votesProcessed = new Counter({
  name: "zkvote_votes_processed_total",
  help: "Total votes processed",
  labelNames: ["status"] as const,
  registers: [register],
});

export const commentsSubmitted = new Counter({
  name: "zkvote_comments_submitted_total",
  help: "Total comments submitted",
  labelNames: ["status"] as const,
  registers: [register],
});

export const daosSynced = new Counter({
  name: "zkvote_daos_synced_total",
  help: "Total DAOs synced",
  registers: [register],
});

export const membershipSyncsTotal = new Counter({
  name: "zkvote_membership_syncs_total",
  help: "Total membership sync operations",
  labelNames: ["status"] as const,
  registers: [register],
});

export const indexerEventsProcessed = new Counter({
  name: "zkvote_indexer_events_processed_total",
  help: "Total events processed by indexer",
  labelNames: ["event_type"] as const,
  registers: [register],
});

export const indexerLag = new Gauge({
  name: "zkvote_indexer_lag_ledgers",
  help: "Number of ledgers behind the indexer is",
  registers: [register],
});

export const indexerWatermarkLedger = new Gauge({
  name: "zkvote_indexer_watermark_ledger",
  help: "Latest ledger durably processed by the indexer",
  registers: [register],
});

export const indexerPollDuration = new Histogram({
  name: "zkvote_indexer_poll_duration_seconds",
  help: "Duration of a complete indexer polling cycle",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const indexerOverrunSkips = new Counter({
  name: "zkvote_indexer_overrun_skips_total",
  help: "Polling cycles skipped because the prior indexer cycle was still active",
  registers: [register],
});

export const indexerQueueDepth = new Gauge({
  name: "zkvote_indexer_queue_depth",
  help: "Current number of buffered events in the indexer backpressure queue",
  registers: [register],
});

export const indexerRpcStreamReconnectsTotal = new Counter({
  name: "zkvote_indexer_rpc_stream_reconnects_total",
  help: "Total number of indexer RPC streaming reconnections",
  registers: [register],
});

export const indexerGapRecoveriesTotal = new Counter({
  name: "zkvote_indexer_gap_recoveries_total",
  help: "Total number of ledger gap replay recoveries initiated by the indexer",
  registers: [register],
});

// ============================================
// CIRCUIT BREAKER METRICS
// ============================================

export const circuitBreakerState = new Gauge({
  name: "zkvote_circuit_breaker_state",
  help: "Circuit breaker state (0=closed, 1=open, 2=half_open)",
  labelNames: ["breaker"] as const,
  registers: [register],
});

export const circuitBreakerTripsTotal = new Counter({
  name: "zkvote_circuit_breaker_trips_total",
  help: "Total number of times a circuit breaker has tripped open",
  labelNames: ["breaker"] as const,
  registers: [register],
});

// ============================================
// MEMORY MONITORING METRICS
// ============================================

export const memoryUsageRatio = new Gauge({
  name: "zkvote_memory_usage_ratio",
  help: "Process RSS memory as a ratio of the configured container memory limit",
  registers: [register],
});

export const memoryThresholdBreachesTotal = new Counter({
  name: "zkvote_memory_threshold_breaches_total",
  help: "Total number of times memory usage crossed the warn/critical threshold",
  labelNames: ["level"] as const,
  registers: [register],
});

// ============================================
// HELPER: Normalise route labels
// ============================================

/**
 * Normalise Express route path to a low-cardinality label.
 * Strips parameter values (e.g. /dao/123 -> /dao/:daoId)
 */
export function normalizeRoute(path: string): string {
  if (!path) return "unknown";

  return path
    .replace(/\/[0-9a-f]{20,}/g, "/:hash")
    .replace(
      /\/(dao|proposal|comment|events|bridge|circuits|ipfs)\/[^/]+/g,
      "/$1/:param",
    )
    .replace(/\/(root|daos|ready|health|config|metrics|db)(\/|$)/g, "/$1$2");
}
