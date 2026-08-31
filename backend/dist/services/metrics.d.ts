/**
 * Prometheus Metrics Service
 *
 * Central metrics registry for all application metrics.
 * Uses prom-client for Prometheus-compatible export.
 */
import { Registry, Counter, Histogram, Gauge } from "prom-client";
export declare const register: Registry<"text/plain; version=0.0.4; charset=utf-8">;
export declare const httpRequestsTotal: Counter<"status" | "method" | "route">;
export declare const httpRequestDuration: Histogram<"status" | "method" | "route">;
export declare const httpRequestSize: Histogram<"method" | "route">;
export declare const httpResponseSize: Histogram<"status" | "method" | "route">;
export declare const coalescingHitsTotal: Counter<"key">;
export declare const coalescingMissesTotal: Counter<"key">;
export declare const coalescingWaitTime: Histogram<"key">;
export declare const rpcCallsTotal: Counter<"status" | "method">;
export declare const rpcCallDuration: Histogram<"status" | "method">;
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
export declare const circuitBreakerState: Gauge<"breaker">;
export declare const circuitBreakerTripsTotal: Counter<"breaker">;
export declare const memoryUsageRatio: Gauge<string>;
export declare const memoryThresholdBreachesTotal: Counter<"level">;
/**
 * Normalise Express route path to a low-cardinality label.
 * Strips parameter values (e.g. /dao/123 -> /dao/:daoId)
 */
export declare function normalizeRoute(path: string): string;
//# sourceMappingURL=metrics.d.ts.map