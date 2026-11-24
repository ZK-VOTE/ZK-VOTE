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
import {
  BANNED_LABELS,
  auditRegistry,
  installCardinalityGuard,
} from "./metric-cardinality.js";

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
// COALESCING METRICS (Bounded cardinality)
// ============================================

/**
 * Normalise SingleFlight / coalescing deduplication key to a bounded operation category.
 * Prevents dynamic IDs (daoId, proposalId) from creating unbounded metric series.
 */
export function normalizeCoalesceKey(key: string): string {
  if (!key) return "unknown";
  const prefix = key.split(":")[0];
  switch (prefix) {
    case "proposal":
    case "root":
    case "root-history":
    case "daos":
    case "comments":
    case "comment":
    case "membership":
    case "sync":
      return prefix;
    default:
      return "other";
  }
}

export const coalescingHitsTotal = new Counter({
  name: "zkvote_coalescing_hits_total",
  help: "Total request coalescing hits",
  labelNames: ["operation"] as const,
  registers: [register],
});

export const coalescingMissesTotal = new Counter({
  name: "zkvote_coalescing_misses_total",
  help: "Total request coalescing misses (original requests)",
  labelNames: ["operation"] as const,
  registers: [register],
});

export const coalescingWaitTime = new Histogram({
  name: "zkvote_coalescing_wait_time_seconds",
  help: "Time spent waiting for coalesced requests in seconds",
  labelNames: ["operation"] as const,
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

/**
 * Normalise RPC endpoint URL to a bounded hostname or alias.
 * Strips authentication tokens, query parameters, paths, and user info.
 */
export function normalizeEndpoint(rawUrl: string): string {
  if (!rawUrl) return "unknown";
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname + (parsed.port ? `:${parsed.port}` : "");
  } catch {
    return rawUrl.split("?")[0].split("/")[0] || "unknown";
  }
}

export const rpcEndpointLatency = new Gauge({
  name: "zkvote_rpc_endpoint_latency_seconds",
  help: "RPC endpoint latency in seconds",
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

// Imported by routes/voting.ts, routes/pay.ts and routes/health.ts but
// missing from this file, which broke importing those routers (and
// therefore backend/src/index.ts) entirely - found while adding the
// ZV-113 compatibility-matrix route test, unrelated to voting/payment
// instrumentation itself.
export const proofVerificationDuration = new Histogram({
  name: "zkvote_proof_verification_duration_seconds",
  help: "Time to verify a submitted vote proof, in seconds",
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

export const proofValidationErrors = new Counter({
  name: "zkvote_proof_validation_errors_total",
  help: "Total vote proof validation errors, by reason",
  labelNames: ["reason"] as const,
  registers: [register],
});

export const proofSubmissionsTotal = new Counter({
  name: "zkvote_proof_submissions_total",
  help: "Total vote proof submissions, by outcome",
  labelNames: ["status"] as const,
  registers: [register],
});

export const relayAttemptsTotal = new Counter({
  name: "zkvote_relay_attempts_total",
  help: "Total relayer submission attempts for vote proofs",
  labelNames: ["status"] as const,
  registers: [register],
});

export const relayDuration = new Histogram({
  name: "zkvote_relay_duration_seconds",
  help: "Time to relay a vote proof to the chain, in seconds",
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const relayErrors = new Counter({
  name: "zkvote_relay_errors_total",
  help: "Total relayer submission errors, by reason",
  labelNames: ["reason"] as const,
  registers: [register],
});

export const relayQueueDepth = new Gauge({
  name: "zkvote_relay_queue_depth",
  help: "Current depth of the vote-relay submission queue",
  registers: [register],
});

export const rootFetchFailuresTotal = new Counter({
  name: "zkvote_root_fetch_failures_total",
  help: "Total failures fetching a DAO's current Merkle root, by reason",
  labelNames: ["reason"] as const,
  registers: [register],
});

export const paymentOpsPerMinute = new Histogram({
  name: "zkvote_payment_ops_per_minute",
  help: "Number of payment ops submitted per /pay/batch request",
  buckets: [1, 2, 5, 10, 20, 50, 100],
  registers: [register],
});

export const healthEndpointStatus = new Gauge({
  name: "zkvote_health_endpoint_status",
  help: "HTTP status code most recently returned by the /health endpoint",
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
// EXTERNAL ENDPOINT POOL METRICS (#745)
// ============================================
//
// Per-endpoint health for every external dependency on a money path
// (Horizon, Soroban RPC, anchors). `endpoint` is the URL origin only so
// API keys in paths/queries never become label values.

export const endpointHealthy = new Gauge({
  name: "zkvote_endpoint_healthy",
  help: "Whether an external endpoint is eligible for routing (1) or not (0)",
  labelNames: ["dependency", "endpoint"] as const,
  registers: [register],
});

export const endpointLedgerLag = new Gauge({
  name: "zkvote_endpoint_ledger_lag",
  help: "Ledgers an endpoint trails the highest ledger observed across its pool",
  labelNames: ["dependency", "endpoint"] as const,
  registers: [register],
});

export const endpointLatencySeconds = new Gauge({
  name: "zkvote_endpoint_latency_ewma_seconds",
  help: "Exponentially weighted moving average of endpoint call latency",
  labelNames: ["dependency", "endpoint"] as const,
  registers: [register],
});

export const endpointRequestsTotal = new Counter({
  name: "zkvote_endpoint_requests_total",
  help: "External endpoint calls by operation class and outcome",
  labelNames: ["dependency", "endpoint", "op_class", "outcome"] as const,
  registers: [register],
});

export const endpointFailoverTotal = new Counter({
  name: "zkvote_endpoint_failover_total",
  help: "Calls that succeeded only after rerouting away from a failed endpoint",
  labelNames: ["dependency", "op_class"] as const,
  registers: [register],
});

export const endpointFailoverLatency = new Histogram({
  name: "zkvote_endpoint_failover_latency_seconds",
  help: "Time from first endpoint failure to successful reroute within one call",
  labelNames: ["dependency"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

export const endpointRetriesTotal = new Counter({
  name: "zkvote_endpoint_retries_total",
  help: "Retries issued by the shared endpoint retry policy",
  labelNames: ["dependency", "op_class", "reason"] as const,
  registers: [register],
});

export const endpointRetryBudgetExhaustedTotal = new Counter({
  name: "zkvote_endpoint_retry_budget_exhausted_total",
  help: "Retries suppressed because the dependency's retry budget was spent",
  labelNames: ["dependency"] as const,
  registers: [register],
});

export const endpointStaleRejectedTotal = new Counter({
  name: "zkvote_endpoint_stale_rejected_total",
  help: "Reads refused because no endpoint was within the finality-lag bound",
  labelNames: ["dependency", "op_class"] as const,
  registers: [register],
});

export const endpointDisagreementTotal = new Counter({
  name: "zkvote_endpoint_disagreement_total",
  help: "Arbitrated reads where endpoints returned different values at the same ledger",
  labelNames: ["dependency"] as const,
  registers: [register],
});

export const dependencyAvailableEndpoints = new Gauge({
  name: "zkvote_dependency_available_endpoints",
  help: "Endpoints currently eligible for routing per dependency",
  labelNames: ["dependency"] as const,
  registers: [register],
});

export const dependencyTotalEndpoints = new Gauge({
  name: "zkvote_dependency_total_endpoints",
  help: "Endpoints configured per dependency",
  labelNames: ["dependency"] as const,
  registers: [register],
});

// Restored: payments.ts / swap.ts import these, but a merge dropped them.
export const swapContractRejectedTotal = new Counter({
  name: "zkvote_swap_contract_rejected_total",
  help: "Soroswap quote responses rejected because the returned contract id was absent or did not match the pinned router",
  labelNames: ["reason"] as const,
  registers: [register],
});

export const trustlinePreflightFailureTotal = new Counter({
  name: "zkvote_trustline_preflight_failure_total",
  help: "Payment or swap operations rejected before submission because a required Stellar trustline was missing or unauthorized",
  labelNames: ["asset", "role", "reason"] as const,
  registers: [register],
});

export const sponsorshipReserveXlm = new Gauge({
  name: "zkvote_sponsorship_reserve_xlm",
  help: "XLM locked in claimable-balance/MuxedAccount sponsorship reserves (#540)",
  registers: [register],
});

export const sponsorshipReserveDepletedTotal = new Counter({
  name: "zkvote_sponsorship_reserve_depleted_total",
  help: "Reserve-check rejections before depletion (#540)",
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
  registers: [register],
});

// ============================================
// RELAYER KEY ROTATION METRICS (#177)
// ============================================

export const relayerKeyBalance = new Gauge({
  name: "zkvote_relayer_key_balance_xlm",
  help: "Current balance of relayer keys in XLM",
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
  help: "Age of relayer key in seconds since activation",
  labelNames: ["role"] as const,
  registers: [register],
});

export const relayerKeyTransactionsTotal = new Counter({
  name: "zkvote_relayer_key_transactions_total",
  help: "Total transactions signed by relayer key role",
  labelNames: ["role"] as const,
  registers: [register],
});

// ── Relayer key lifecycle (#746) ────────────────────────────────────────────

let activeKeyActivatedAt: () => string | null = () => null;

/**
 * Register where the active key's activation time comes from. Only the
 * process-wide relayerKeyManager calls this; test fixtures with their own
 * managers must not take over the process gauge.
 */
export function setActiveKeyAgeSource(source: () => string | null): void {
  activeKeyActivatedAt = source;
}

// Computed at scrape time: an untouched key must keep ageing, or the
// rotation-overdue alert never fires for exactly the key nobody rotates.
export const relayerActiveKeyAgeSeconds = new Gauge({
  name: "zkvote_relayer_active_key_age_seconds",
  help: "Seconds since the currently active relayer identity was activated",
  registers: [register],
  collect() {
    const at = activeKeyActivatedAt();
    this.set(at ? Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 1000)) : 0);
  },
});

export const relayerKeyMaxAgeSeconds = new Gauge({
  name: "zkvote_relayer_key_max_age_seconds",
  help: "Configured maximum active-key age before rotation is overdue (RELAYER_KEY_MAX_AGE_DAYS)",
  registers: [register],
});

export const relayerFundedStandbyKeys = new Gauge({
  name: "zkvote_relayer_funded_standby_keys",
  help: "Standby relayer keys with a verified balance at or above the minimum",
  registers: [register],
});

export const relayerDrainingKeys = new Gauge({
  name: "zkvote_relayer_draining_keys",
  help: "Relayer identities currently inside a dual-identity drain window",
  registers: [register],
});

export const relayerSigningRefusedTotal = new Counter({
  name: "zkvote_relayer_signing_refused_total",
  help: "Relayer signatures refused, by reason (identity fencing, tier policy, halt)",
  labelNames: ["reason"] as const,
  registers: [register],
});

// Notification delivery (ZV-037 / #886). `channel` is email | webpush;
// `result` is sent | retry | gone | skipped. No destination or token is a label.
export const notificationDeliveriesTotal = new Counter({
  name: "zkvote_notification_deliveries_total",
  help: "Notification delivery attempts by channel and result",
  labelNames: ["channel", "result"] as const,
  registers: [register],
});

export const notificationDeadLetterTotal = new Counter({
  name: "zkvote_notification_dead_letter_total",
  help: "Notifications moved to the dead-letter queue after exhausting retries",
  labelNames: ["channel"] as const,
  registers: [register],
});

export const relayerSigningTierTotal = new Counter({
  name: "zkvote_relayer_signing_tier_total",
  help: "Relayer signatures by signing tier",
  labelNames: ["tier"] as const,
  registers: [register],
});

export const relayerSigningHalted = new Gauge({
  name: "zkvote_relayer_signing_halted",
  help: "1 while a co-signer halt is stopping all non-sweep relayer signing",
  registers: [register],
});

export const relayerRotationPhase = new Gauge({
  name: "zkvote_relayer_rotation_phase",
  help: "1 for the current relayer rotation phase, 0 otherwise",
  labelNames: ["phase"] as const,
  registers: [register],
});

export const relayerRotationsCompletedTotal = new Counter({
  name: "zkvote_relayer_rotations_completed_total",
  help: "Relayer rotations by kind (planned, compromise) and outcome",
  labelNames: ["kind", "outcome"] as const,
  registers: [register],
});

export const relayerRotationDurationSeconds = new Histogram({
  name: "zkvote_relayer_rotation_duration_seconds",
  help: "Time from rotation start to cutover",
  labelNames: ["kind"] as const,
  buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600],
  registers: [register],
});

export const relayerCompromiseTimeToRotatedSeconds = new Gauge({
  name: "zkvote_relayer_compromise_time_to_rotated_seconds",
  help: "Declaration-to-rotated time of the most recent compromise response",
  registers: [register],
});

export const relayerCompromiseSloBreachesTotal = new Counter({
  name: "zkvote_relayer_compromise_slo_breaches_total",
  help: "Compromise responses slower than RELAYER_COMPROMISE_SLO_SECONDS",
  registers: [register],
});

export const relayerCompromiseDeclarationsTotal = new Counter({
  name: "zkvote_relayer_compromise_declarations_total",
  help: "Relayer key compromise declarations by outcome",
  labelNames: ["outcome"] as const,
  registers: [register],
});

export const relayerSweepsTotal = new Counter({
  name: "zkvote_relayer_sweeps_total",
  help: "Compromise sweeps of a relayer account to the safe account, by outcome",
  labelNames: ["outcome"] as const,
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

/**
 * Normalise target resource to a bounded category.
 * Prevents dynamic resource IDs/paths from expanding Prometheus cardinality.
 */
export function normalizeResourceType(resource: string): string {
  if (!resource) return "unknown";
  const lower = resource.toLowerCase();
  if (lower.startsWith("dao")) return "dao";
  if (lower.startsWith("proposal")) return "proposal";
  if (lower.startsWith("key") || lower.startsWith("secret")) return "key";
  if (lower.startsWith("comment")) return "comment";
  if (lower.startsWith("membership") || lower.startsWith("voter")) return "membership";
  if (lower.startsWith("session")) return "session";
  if (lower.startsWith("registry")) return "registry";
  return "unknown";
}

export const cross_tenant_denial_total = new Counter({
  name: "zkvote_cross_tenant_denial_total",
  help: "Total access attempts denied due to cross-tenant or cross-DAO resource isolation policies",
  labelNames: ["resource_type", "reason"] as const,
  registers: [register],
});

export const reconciliation_mismatch_total = new Counter({
  name: "zkvote_reconciliation_mismatch_total",
  help: "Total reconciliation mismatches detected between SQLite state, relayer events, and on-chain Soroban ledger state",
  labelNames: ["component", "mismatch_type"] as const,
  registers: [register],
});

export const coverTrafficScheduledTotal = new Counter({
  name: "zkvote_cover_traffic_scheduled_total",
  help: "Cover-traffic slots the scheduler fired (no dummy is sent yet)",
  registers: [register],
});

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

export const priorityQueueDepth = new Gauge({
  name: "zkvote_priority_queue_depth",
  help: "Current number of requests waiting in a priority tier's queue (not yet running)",
  labelNames: ["tier"] as const,
  registers: [register],
});

export const priorityQueueInFlight = new Gauge({
  name: "zkvote_priority_queue_in_flight",
  help: "Current number of requests running in a priority tier's reserved worker pool",
  labelNames: ["tier"] as const,
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

// Imported by backupCrypto.ts but missing from this file, which broke
// every import of that module (and therefore anything that transitively
// imports it, including backend/src/index.ts) - found while adding the
// ZV-113 compatibility-matrix route test, unrelated to backup/crypto work
// itself.
export const backupTamperDetected = new Counter({
  name: "zkvote_backup_tamper_detected_total",
  help: "Total backup restores that detected tampering (AEAD auth-tag failure or size mismatch)",
  labelNames: ["keyId"] as const,
  registers: [register],
});

export const backupRestoreSuccess = new Counter({
  name: "zkvote_backup_restore_success_total",
  help: "Total backup restores that completed successfully",
  labelNames: ["keyId"] as const,
  registers: [register],
});

export const backupRestoreFailed = new Counter({
  name: "zkvote_backup_restore_failed_total",
  help: "Total backup restores that failed, by reason",
  labelNames: ["reason"] as const,
  registers: [register],
});

export const backupEncryptionDuration = new Histogram({
  name: "zkvote_backup_encryption_duration_seconds",
  help: "Time to encrypt a backup payload, in seconds",
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30],
  registers: [register],
});

export const backupDecryptionDuration = new Histogram({
  name: "zkvote_backup_decryption_duration_seconds",
  help: "Time to decrypt a backup payload, in seconds",
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30],
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

export const paymentHoldsTotal = new Counter({
  name: "zkvote_payment_holds_total",
  help: "Graduated enforcement actions (hold/block) taken on flagged payments, by pattern and action (ZV-111)",
  labelNames: ["pattern", "action"] as const,
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

// ============================================
// STORAGE FOOTPRINT & RENT METRICS (ZV-032 / #881)
// Bounded cardinality: labels are bounded by category, priority, reason, status
// ============================================

export const storageEntriesUsage = new Gauge({
  name: "zkvote_storage_entries_usage",
  help: "Current persistent storage entries by category and usage level",
  labelNames: ["category", "status"] as const,
  registers: [register],
});

export const storageBytesUsage = new Gauge({
  name: "zkvote_storage_bytes_usage",
  help: "Current persistent storage byte usage by category",
  labelNames: ["category"] as const,
  registers: [register],
});

export const storageLimitsConfigured = new Gauge({
  name: "zkvote_storage_limits_configured",
  help: "Aggregated configured storage entry and byte caps",
  labelNames: ["type"] as const, // "entries" | "bytes"
  registers: [register],
});

export const storageQuotaRejectionsTotal = new Counter({
  name: "zkvote_storage_quota_rejections_total",
  help: "Total writes rejected due to per-DAO storage footprint limits",
  labelNames: ["category", "reason"] as const,
  registers: [register],
});

// TTL Budget Metrics
export const ttlBudgetConsumptionTotal = new Counter({
  name: "zkvote_ttl_budget_consumption_total",
  help: "Total TTL-extension budget units consumed",
  labelNames: ["priority"] as const,
  registers: [register],
});

export const ttlExtensionRejectionsTotal = new Counter({
  name: "zkvote_ttl_extension_rejections_total",
  help: "Total TTL extensions rejected due to budget exhaustion or priority rules",
  labelNames: ["priority", "reason"] as const,
  registers: [register],
});

export const ttlBudgetExhaustionWarnings = new Counter({
  name: "zkvote_ttl_budget_exhaustion_warnings_total",
  help: "Warnings triggered when a DAO approaches TTL budget exhaustion",
  labelNames: ["priority"] as const,
  registers: [register],
});

// Archival & Commitment Metrics
export const archivalOperationsTotal = new Counter({
  name: "zkvote_archival_operations_total",
  help: "Total archival lifecycle operations (archive, restore, recommit)",
  labelNames: ["operation", "status"] as const,
  registers: [register],
});

export const archivalVerificationFailuresTotal = new Counter({
  name: "zkvote_archival_verification_failures_total",
  help: "Total cryptographic commitment verification failures during cold-state restoration",
  labelNames: ["reason"] as const,
  registers: [register],
});

// ============================================
// STORAGE RENT & TTL ALERTING (ZV-032 / ZV-044)
// ============================================

const recentAlerts = new Map<string, number>();
const ALERT_DEDUPLICATION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function shouldSuppressAlert(alertKey: string): boolean {
  const now = Date.now();
  const lastEmitted = recentAlerts.get(alertKey);
  if (lastEmitted && now - lastEmitted < ALERT_DEDUPLICATION_WINDOW_MS) {
    return true;
  }
  recentAlerts.set(alertKey, now);
  return false;
}

export interface StorageAlertPayload {
  alertType:
    | "footprint_limit_warning"
    | "footprint_limit_exceeded"
    | "ttl_budget_warning"
    | "ttl_budget_exhausted"
    | "archival_failure"
    | "verification_failure";
  level: "warn" | "error";
  daoId?: number;
  details: Record<string, unknown>;
}

/**
 * Dispatch or log rent and storage alerts. Integrates with ZV-044 alerting if
 * configured, or surfaces structured logger alerts with deduplication.
 */
export function dispatchRentAlert(payload: StorageAlertPayload): void {
  const alertKey = `${payload.alertType}:${payload.daoId ?? "global"}:${JSON.stringify(payload.details)}`;
  if (shouldSuppressAlert(alertKey)) {
    return;
  }

  // Check if ZV-044 global alert dispatcher exists
  const globalAlertManager = (globalThis as any).__ZV044_ALERT_MANAGER__;
  if (globalAlertManager && typeof globalAlertManager.dispatch === "function") {
    try {
      globalAlertManager.dispatch({
        service: "storage_rent_enforcement",
        type: payload.alertType,
        level: payload.level,
        daoId: payload.daoId,
        details: payload.details,
        timestamp: new Date().toISOString(),
      });
      return;
    } catch (_) {
      // Fallback to structured logging on dispatcher error
    }
  }

  // Structured logging (redaction-safe)
  console.warn(
    JSON.stringify({
      level: payload.level,
      event: `alert_${payload.alertType}`,
      daoId: payload.daoId,
      details: payload.details,
      timestamp: new Date().toISOString(),
      integration: "zv044_fallback_logged",
    }),
  );
}

export function checkStorageFootprintAlert(
  daoId: number,
  currentEntries: number,
  maxEntries: number,
  currentBytes: number,
  maxBytes: number,
): void {
  const entryRatio = maxEntries > 0 ? currentEntries / maxEntries : 0;
  const byteRatio = maxBytes > 0 ? currentBytes / maxBytes : 0;

  if (entryRatio >= 1.0 || byteRatio >= 1.0) {
    dispatchRentAlert({
      alertType: "footprint_limit_exceeded",
      level: "error",
      daoId,
      details: { currentEntries, maxEntries, currentBytes, maxBytes, entryRatio, byteRatio },
    });
  } else if (entryRatio >= 0.85 || byteRatio >= 0.85) {
    dispatchRentAlert({
      alertType: "footprint_limit_warning",
      level: "warn",
      daoId,
      details: { currentEntries, maxEntries, currentBytes, maxBytes, entryRatio, byteRatio },
    });
  }
}

export function checkTtlBudgetAlert(
  daoId: number,
  consumedBudget: number,
  maxBudget: number,
  priority: string,
): void {
  const ratio = maxBudget > 0 ? consumedBudget / maxBudget : 0;
  if (ratio >= 1.0) {
    ttlBudgetExhaustionWarnings.inc({ priority });
    dispatchRentAlert({
      alertType: "ttl_budget_exhausted",
      level: "error",
      daoId,
      details: { consumedBudget, maxBudget, priority, ratio },
    });
  } else if (ratio >= 0.8) {
    ttlBudgetExhaustionWarnings.inc({ priority });
    dispatchRentAlert({
      alertType: "ttl_budget_warning",
      level: "warn",
      daoId,
      details: { consumedBudget, maxBudget, priority, ratio },
    });
  }
}

// ============================================
// METRICS CARDINALITY GOVERNANCE & AUDIT (#749)
// ============================================

/**
 * High-cardinality and attacker-controlled label dimensions banned from
 * Prometheus metrics. The policy (bounds, budgets, runtime guard) lives in
 * metric-cardinality.ts; any metric declaring one of these fails the CI gate.
 */
export const PROHIBITED_METRIC_LABELS: ReadonlySet<string> = new Set(
  Object.keys(BANNED_LABELS),
);

export interface CardinalityAuditResult {
  valid: boolean;
  totalMetrics: number;
  violations: Array<{
    metric: string;
    reason: string;
    labels?: string[];
  }>;
}

/**
 * Audits the registry against cardinality governance rules: no prohibited
 * labels, every label declared with a bound, live children within each
 * metric's budget, and modeled samples within the global budget.
 */
export async function auditRegistryCardinality(
  customRegister: Registry = register,
): Promise<CardinalityAuditResult> {
  const report = auditRegistry(customRegister);
  const labelsOf = new Map(report.metrics.map((m) => [m.name, m.labels]));
  return {
    valid: report.violations.length === 0,
    totalMetrics: report.metrics.length,
    violations: report.violations.map((v) => ({
      metric: v.metric,
      reason: `${v.rule}: ${v.detail}`,
      labels: labelsOf.get(v.metric),
    })),
  };
}

// Bind the guard to this registry last, so it sees every metric above and
// repairs any constructed before prom-client was patched.
installCardinalityGuard(register);
