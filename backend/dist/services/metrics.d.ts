/**
 * Prometheus Metrics Service
 *
 * Central metrics registry for all application metrics.
 * Uses prom-client for Prometheus-compatible export.
 */
import { Registry, Counter, Histogram, Gauge } from "prom-client";
export declare const register: Registry<"text/plain; version=0.0.4; charset=utf-8">;
export declare const httpRequestsTotal: Counter<"method" | "route" | "status">;
export declare const httpRequestDuration: Histogram<"method" | "route" | "status">;
export declare const httpRequestSize: Histogram<"method" | "route">;
export declare const httpRequestsInFlight: Gauge<"method" | "route">;
export declare const httpResponseSize: Histogram<"method" | "route" | "status">;
export declare const coalescingHitsTotal: Counter<"key">;
export declare const coalescingMissesTotal: Counter<"key">;
export declare const coalescingWaitTime: Histogram<"key">;
export declare const membershipRegistrationTotal: Counter<"status">;
export declare const membershipRegistrationLimited: Counter<"reason">;
export declare const rpcCallsTotal: Counter<"method" | "status">;
export declare const rpcCallDuration: Histogram<"method" | "status">;
export declare const rpcErrors: Counter<"method" | "error_type">;
export declare const rpcPoolHealthyEndpoints: Gauge<string>;
export declare const rpcPoolTotalEndpoints: Gauge<string>;
export declare const rpcEndpointLatency: Gauge<"url">;
export declare const dbQueriesTotal: Counter<"status" | "operation">;
export declare const dbQueryDuration: Histogram<"operation">;
export declare const dbConnectionsActive: Gauge<string>;
export declare const dbWalSizeBytes: Gauge<string>;
export declare const dbSlowQueries: Counter<string>;
export declare const dbCacheHitRate: Gauge<string>;
export declare const dbReadLagMs: Gauge<string>;
export declare const dbWriteFailoverTotal: Counter<"result">;
export declare const dbWriteHealthy: Gauge<string>;
export declare const ipfsPinsTotal: Counter<"status" | "type">;
export declare const ipfsFetchDuration: Histogram<"type">;
export declare const ipfsCacheHits: Counter<string>;
export declare const ipfsCacheMisses: Counter<string>;
export declare const ipfsPinsVerified: Gauge<string>;
export declare const ipfsPinsFailed: Gauge<string>;
export declare const serviceLastRunTime: Gauge<"service">;
export declare const serviceErrors: Counter<"service">;
export declare const serviceProcessingLag: Gauge<"service">;
export declare const serviceRunning: Gauge<"service">;
export declare const votesProcessed: Counter<"status">;
export declare const commentsSubmitted: Counter<"status">;
export declare const daosSynced: Counter<string>;
export declare const membershipSyncsTotal: Counter<"status">;
export declare const indexerEventsProcessed: Counter<"event_type">;
export declare const indexerLag: Gauge<string>;
export declare const indexerWatermarkLedger: Gauge<string>;
export declare const indexerPollDuration: Histogram<string>;
export declare const indexerOverrunSkips: Counter<string>;
export declare const indexerPollMissesTotal: Counter<string>;
export declare const indexerQueueDepth: Gauge<string>;
export declare const indexerRpcStreamReconnectsTotal: Counter<string>;
export declare const indexerGapRecoveriesTotal: Counter<string>;
export declare const circuitBreakerState: Gauge<"breaker">;
export declare const circuitBreakerTripsTotal: Counter<"breaker">;
export declare const sequenceRecoveriesTotal: Counter<"status">;
export declare const sequenceMismatchesTotal: Counter<string>;
export declare const sequenceRecoveryDuration: Histogram<string>;
export declare const sequenceHealthStatus: Gauge<string>;
export declare const memoryUsageRatio: Gauge<string>;
export declare const memoryThresholdBreachesTotal: Counter<"level">;
export declare const txConfirmationsTotal: Counter<"status">;
export declare const txConfirmationDuration: Histogram<"status">;
export declare const txConfirmationAttempts: Histogram<"status">;
export declare const txConfirmationQueueDepth: Gauge<string>;
export declare const txConfirmationCacheSize: Gauge<string>;
export declare const txConfirmationPollTotal: Counter<string>;
export declare const wsConnections: Gauge<string>;
export declare const wsMessagesSent: Counter<string>;
export declare const wsAuthDuration: Histogram<string>;
export declare const wsMessageDuration: Histogram<string>;
export declare const wsRateLimitTotal: Counter<"ip">;
export declare const relayerKeyBalance: Gauge<"key_id" | "role">;
export declare const relayerKeyRotationsTotal: Counter<"status" | "trigger">;
export declare const relayerKeyAgeSeconds: Gauge<"key_id">;
export declare const relayerKeyTransactionsTotal: Counter<"key_id">;
/**
 * Normalise Express route path to a low-cardinality label.
 * Strips parameter values, hashes, addresses, and query strings.
 */
export declare function normalizeRoute(path: string): string;
export declare const archivalRunsTotal: Counter<"status">;
export declare const archivalDuration: Histogram<string>;
export declare const unauthenticated_rejection_total: Counter<"reason" | "endpoint">;
export declare const cross_tenant_denial_total: Counter<"reason" | "tenant_id" | "target_resource">;
export declare const reconciliation_mismatch_total: Counter<"component" | "mismatch_type">;
export declare const rate_limit_store_size: Gauge<string>;
export declare const session_store_size: Gauge<string>;
export declare const batch_partial_failure_total: Counter<"reason" | "batch_type">;
export declare const paymentOpsPerMinute: Histogram<string>;
export declare const costRateLimitExceeded: Counter<"limiter" | "cost">;
export declare const backupAge: Gauge<string>;
export declare const backupTamperDetected: Counter<"keyId">;
export declare const backupRestoreSuccess: Counter<"keyId">;
export declare const backupRestoreFailed: Counter<"reason">;
export declare const backupEncryptionDuration: Histogram<string>;
export declare const backupDecryptionDuration: Histogram<string>;
export declare const daoReconciliationRunsTotal: Counter<"status">;
export declare const daoReconciliationLastOk: Gauge<string>;
export declare const offlineRetryTotal: Counter<"status" | "type">;
export declare const outboxLagGauge: Gauge<"channel">;
//# sourceMappingURL=metrics.d.ts.map