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
// Imported first: patches prom-client so every metric below is budget-guarded
// (#749). See metric-cardinality.ts for the label policy.
import { installCardinalityGuard } from "./metric-cardinality.js";

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
  // scope = key prefix ("root"), never the key itself: keys embed DAO ids.
  labelNames: ["scope"] as const,
  registers: [register],
});

export const coalescingMissesTotal = new Counter({
  name: "zkvote_coalescing_misses_total",
  help: "Total request coalescing misses (original requests)",
  // scope = key prefix ("root"), never the key itself: keys embed DAO ids.
  labelNames: ["scope"] as const,
  registers: [register],
});

export const coalescingWaitTime = new Histogram({
  name: "zkvote_coalescing_wait_time_seconds",
  help: "Time spent waiting for coalesced requests in seconds",
  // scope = key prefix ("root"), never the key itself: keys embed DAO ids.
  labelNames: ["scope"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

// ============================================
// MEMBERSHIP REGISTRATION METRICS (#371)
// ============================================

export const membershipRegistrationTotal = new Counter({
  name: "zkvote_membership_registration_requests_total",
  help: "Total commitment registration requests served by the membership route",
  labelNames: ["status"] as const,
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
  // Origin only: full URLs can carry API keys and are not a bounded set.
  labelNames: ["endpoint"] as const,
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

export const indexerPollMissesTotal = new Counter({
  name: "zkvote_indexer_poll_misses_total",
  help: "Polling cycles that held the watermark because a contract's getEvents failed (window retried next cycle, #562)",
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
// SEQUENCE NUMBER METRICS
// ============================================

export const sequenceRecoveriesTotal = new Counter({
  name: "zkvote_sequence_recoveries_total",
  help: "Total number of sequence number recovery attempts",
  labelNames: ["status"] as const,
  registers: [register],
});

export const sequenceMismatchesTotal = new Counter({
  name: "zkvote_sequence_mismatches_total",
  help: "Total number of sequence number mismatches detected",
  registers: [register],
});

export const sequenceRecoveryDuration = new Histogram({
  name: "zkvote_sequence_recovery_duration_seconds",
  help: "Duration of sequence number recovery operations in seconds",
  buckets: [0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

export const sequenceHealthStatus = new Gauge({
  name: "zkvote_sequence_health_status",
  help: "Sequence number health status (1=healthy, 0=unhealthy)",
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
// TRANSACTION CONFIRMATION METRICS (#172)
// ============================================

export const txConfirmationsTotal = new Counter({
  name: "zkvote_tx_confirmations_total",
  help: "Total transaction confirmations resolved by the confirmation queue",
  labelNames: ["status"] as const,
  registers: [register],
});

export const txConfirmationDuration = new Histogram({
  name: "zkvote_tx_confirmation_duration_seconds",
  help: "Time from enqueue to confirmation resolution in seconds",
  labelNames: ["status"] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [register],
});

export const txConfirmationAttempts = new Histogram({
  name: "zkvote_tx_confirmation_attempts",
  help: "Number of getTransaction polls performed per confirmation",
  labelNames: ["status"] as const,
  buckets: [1, 2, 3, 4, 5, 8, 12, 16, 24, 32],
  registers: [register],
});

export const txConfirmationQueueDepth = new Gauge({
  name: "zkvote_tx_confirmation_queue_depth",
  help: "Number of transactions currently pending confirmation",
  registers: [register],
});

export const txConfirmationCacheSize = new Gauge({
  name: "zkvote_tx_confirmation_cache_size",
  help: "Number of transaction confirmation results currently cached",
  registers: [register],
});

export const txConfirmationPollTotal = new Counter({
  name: "zkvote_tx_confirmation_polls_total",
  help: "Total getTransaction polls performed by the confirmation worker",
  registers: [register],
});

// ============================================
// WEBSOCKET METRICS (#172)
// ============================================

export const wsConnections = new Gauge({
  name: "zkvote_ws_connections",
  help: "Number of currently connected WebSocket clients",
  registers: [register],
});

export const wsMessagesSent = new Counter({
  name: "zkvote_ws_messages_sent_total",
  help: "Total WebSocket messages sent to connected clients",
  registers: [register],
});

export const wsAuthDuration = new Histogram({
  name: "zkvote_ws_auth_duration_seconds",
  help: "WebSocket authentication/handshake duration in seconds",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

export const wsMessageDuration = new Histogram({
  name: "zkvote_ws_message_duration_seconds",
  help: "WebSocket message processing duration in seconds",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

export const wsRateLimitTotal = new Counter({
  name: "zkvote_ws_rate_limit_total",
  help: "Total WebSocket connections blocked by rate limiting",
  // No ip label: attacker-mintable. The client (hashed) is on the
  // metric_drilldown log record for this increment.
  registers: [register],
});

// ============================================
// RELAYER KEY ROTATION METRICS (#177)
// ============================================

export const relayerKeyBalance = new Gauge({
  name: "zkvote_relayer_key_balance_xlm",
  help: "Lowest balance among relayer keys in each role, in XLM",
  // Per role, not per key: key ids grow with every rotation/generation.
  labelNames: ["role"] as const,
  registers: [register],
});

export const relayerKeyRotationsTotal = new Counter({
  name: "zkvote_relayer_key_rotations_total",
  help: "Total number of relayer key rotations",
  labelNames: ["trigger", "status"] as const,
  registers: [register],
});

export const relayerKeyAgeSeconds = new Gauge({
  name: "zkvote_relayer_key_age_seconds",
  help: "Oldest activation age among relayer keys in each role, in seconds",
  labelNames: ["role"] as const,
  registers: [register],
});

export const relayerKeyTransactionsTotal = new Counter({
  name: "zkvote_relayer_key_transactions_total",
  help: "Total transactions signed by relayer keys, by role",
  labelNames: ["role"] as const,
  registers: [register],
});

// ============================================
// HELPER: Normalise route labels
// ============================================

/**
 * Normalise Express route path to a low-cardinality label.
 * Strips parameter values, hashes, addresses, and query strings.
 */
export function normalizeRoute(path: string): string {
  if (!path) return "unknown";

  const cleanPath = path.split("?")[0];

  return cleanPath
    .replace(/\/[0-9a-f]{20,}/gi, "/:hash")
    .replace(/\/[CG][A-Z2-7]{55}/g, "/:address")
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:uuid")
    .replace(
      /\/(dao|proposal|comment|comments|events|bridge|circuits|ipfs|membership|claim|pay|swap|ramp|nullifier|root|root-history|vote|threshold|randomness)\/[^/]+/gi,
      "/$1/:param",
    )
    .replace(
      /\/(proposal|nullifier|root-history|comments|comment|threshold)\/[^/]+\/[^/]+/gi,
      "/$1/:param/:id2",
    )
    .replace(/\/(root|daos|ready|health|config|metrics|db)(\/|$)/g, "/$1$2");
}

// ============================================
// ARCHIVAL METRICS (missing - stubbed for unblocked build)
// ============================================

export const archivalRunsTotal = new Counter({
  name: "zkvote_archival_runs_total",
  help: "Total archival runs",
  labelNames: ["status"] as const,
  registers: [register],
});

export const archivalDuration = new Histogram({
  name: "zkvote_archival_duration_seconds",
  help: "Archival duration in seconds",
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// ============================================
// SECURITY, MULTI-TENANT & RECONCILIATION METRICS (#307 / Toxic Waste Audit)
// ============================================

export const unauthenticated_rejection_total = new Counter({
  name: "zkvote_unauthenticated_rejection_total",
  help: "Total requests rejected due to missing or invalid authentication credentials",
  labelNames: ["endpoint", "reason"] as const,
  registers: [register],
});

export const cross_tenant_denial_total = new Counter({
  name: "zkvote_cross_tenant_denial_total",
  help: "Total access attempts denied due to cross-tenant or cross-DAO resource isolation policies",
  // tenant_id removed: caller-chosen. It is on the drill-down log instead.
  labelNames: ["target_resource", "reason"] as const,
  registers: [register],
});

export const reconciliation_mismatch_total = new Counter({
  name: "zkvote_reconciliation_mismatch_total",
  help: "Total reconciliation mismatches detected between SQLite state, relayer events, and on-chain Soroban ledger state",
  labelNames: ["component", "mismatch_type"] as const,
  registers: [register],
});

export const rootFetchFailuresTotal = new Counter({
  name: "zkvote_root_fetch_failures_total",
  help: "GET /root/:daoId failures by reason (dao_id is on the metric_drilldown log, #749)",
  labelNames: ["reason"] as const,
  registers: [register],
});

// camelCase aliases: registry-pin.ts imports these names.
export const unauthenticatedRejectionTotal = unauthenticated_rejection_total;
export const crossTenantDenialTotal = cross_tenant_denial_total;

export const rate_limit_store_size = new Gauge({
  name: "zkvote_rate_limit_store_size",
  help: "Current number of tracked rate-limiting client keys in memory",
  registers: [register],
});

export const session_store_size = new Gauge({
  name: "zkvote_session_store_size",
  help: "Current number of active authenticated relay sessions stored in memory or db",
  registers: [register],
});

export const batch_partial_failure_total = new Counter({
  name: "zkvote_batch_partial_failure_total",
  help: "Total partial failures encountered during batch operations (e.g. pay batch, vote batch)",
  labelNames: ["batch_type", "reason"] as const,
  registers: [register],
});

export const priorityStarvationTotal = new Counter({
  name: "zkvote_priority_starvation_total",
  help: "Total priority-queued requests that waited beyond the starvation threshold",
  labelNames: ["priority", "route"] as const,
  registers: [register],
});

// ============================================
// BACKUP FORWARD-SECRECY METRICS (#600)
// ============================================

export const backupKeyRotationsTotal = new Counter({
  name: "zkvote_backup_key_rotations_total",
  help: "Total backup encryption key rotations (old key archived, new key active)",
  labelNames: ["status"] as const,
  registers: [register],
});

export const backupAgeSeconds = new Gauge({
  name: "zkvote_backup_age_seconds",
  help: "Age of the most recent successful backup in seconds (staleness signal for litestream/S3 DR)",
  registers: [register],
});

export const backupRestoreDrillTotal = new Counter({
  name: "zkvote_backup_restore_drill_total",
  help: "Total encrypted restore drills run (verify/decrypt round-trip)",
  labelNames: ["status"] as const,
  registers: [register],
});

// ============================================
// DAO END-TO-END RECONCILIATION METRICS (#577)
// ============================================

export const daoReconciliationRunsTotal = new Counter({
  name: "zkvote_dao_reconciliation_runs_total",
  help: "Total DAO end-to-end reconciliation runs (create_dao→mint→register→proposal→vote→tally hash vs DB count)",
  labelNames: ["status"] as const,
  registers: [register],
});

export const daoReconciliationLastOk = new Gauge({
  name: "zkvote_dao_reconciliation_last_ok_timestamp_seconds",
  help: "Unix timestamp of the last fully-consistent DAO reconciliation run (0 when never clean)",
  registers: [register],
});

// ============================================
// ABUSE DETECTION METRICS (SPIKE-147 / #798)
// ============================================

export const abuseDetectionTotal = new Counter({
  name: "zkvote_abuse_detection_total",
  help: "Total abuse pattern detections (structuring, wash payments, mule convergence)",
  labelNames: ["pattern", "confidence_level"] as const,
  registers: [register],
});

export const abusePatternConfidence = new Histogram({
  name: "zkvote_abuse_pattern_confidence",
  help: "Confidence score distribution for detected abuse patterns (0.0 to 1.0)",
  labelNames: ["pattern"] as const,
  buckets: [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0],
  registers: [register],
});

export const suspiciousPaymentVolume = new Histogram({
  name: "zkvote_suspicious_payment_volume_stroops",
  help: "Total payment volume in stroops for transactions flagged as suspicious",
  labelNames: ["pattern"] as const,
  buckets: [1e10, 1e11, 1e12, 1e13, 1e14], // 1K to 10M XLM
  registers: [register],
});

export const paymentDestinationFanout = new Histogram({
  name: "zkvote_payment_destination_fanout",
  help: "Number of unique destinations per payment batch (mule detection signal)",
  buckets: [1, 2, 5, 10, 20, 50, 100],
  registers: [register],
});

// ============================================
// KYC BOUNDARY METRICS (SPIKE-146 / #797)
// ============================================

export const kycDataMinimizationTotal = new Counter({
  name: "zkvote_kyc_data_minimization_total",
  help: "Total anchor responses processed through KYC data minimization",
  labelNames: ["status", "has_excess_fields"] as const,
  registers: [register],
});

export const kycAccessDenialTotal = new Counter({
  name: "zkvote_kyc_access_denial_total",
  help: "Total KYC field access attempts denied due to insufficient access level",
  labelNames: ["field", "access_level"] as const,
  registers: [register],
});

export const kycRetentionPurgeTotal = new Counter({
  name: "zkvote_kyc_retention_purge_total",
  help: "Total KYC state records purged based on retention policy",
  labelNames: ["status"] as const,
  registers: [register],
});


// ============================================
// OFFLINE RETRY & CDC OUTBOX LAG METRICS (#542, #544)
// ============================================

export const offlineRetryTotal = new Counter({
  name: "zkvote_offline_retry_total",
  help: "Total offline retry attempts processed from client queue",
  labelNames: ["type", "status"] as const,
  registers: [register],
});

export const outboxLagGauge = new Gauge({
  name: "zkvote_outbox_lag_seconds",
  help: "Outbox pattern CDC WAL replication lag in seconds",
  labelNames: ["channel"] as const,
  registers: [register],
});

// Bind the guard to this registry last, so it sees every metric above and
// repairs any constructed before prom-client was patched (#749).
installCardinalityGuard(register);
