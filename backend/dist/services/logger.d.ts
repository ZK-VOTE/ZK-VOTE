/**
 * Structured Logger Service with PII Redaction
 *
 * Provides:
 *  - Structured JSON logging to stdout
 *  - PII redaction (field- and pattern-based)
 *  - Per-request correlation context via AsyncLocalStorage so every nested
 *    log call carries the request's correlation ID + trace ID automatically
 *  - Trace sampling (`LOG_SAMPLE_RATE`) so high-volume requests can be
 *    probabilistically dropped while keeping an entire request consistent
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogMeta = Record<string, any>;
export interface RedactionPolicy {
    redactedFields: string[];
    detailedLevels: LogLevel[];
    showClientIp: "plain" | "hash" | "none";
    showBodyKeysOnly: boolean;
    stellarTruncateLength: number;
}
/**
 * Per-request correlation context. Populated by the request logging
 * middleware and propagated through AsyncLocalStorage to every nested
 * log call (services, routes, background work spawned from a request).
 */
export interface RequestContext {
    ctx: string;
    traceId: string;
    path?: string;
    method?: string;
}
/**
 * Runs `fn` within the given correlation context. Every log call made
 * synchronously or asynchronously (via awaited promises, timers, etc.)
 * spawned from `fn` will automatically include `ctx` and `traceId`.
 */
export declare function runWithContext<T>(context: RequestContext, fn: () => T): T;
/**
 * Returns the correlation context active for the current async execution,
 * or `undefined` when no request context is present (e.g. background jobs).
 */
export declare function getRequestContext(): RequestContext | undefined;
export declare function setLogSampleRate(rate: number): void;
export declare function getLogSampleRate(): number;
export declare function setRedactionPolicy(policy: Partial<RedactionPolicy>): void;
export declare function getRedactionPolicy(): RedactionPolicy;
export declare function truncateStellarAddress(address: string): string;
export declare function redact(meta: LogMeta, level?: LogLevel): LogMeta;
export interface Logger {
    log(level: LogLevel, event: string, meta?: LogMeta): void;
    debug(event: string, meta?: LogMeta): void;
    info(event: string, meta?: LogMeta): void;
    warn(event: string, meta?: LogMeta): void;
    error(event: string, meta?: LogMeta): void;
}
export declare function createLogger(service: string): Logger;
export declare function generateRequestId(): string;
export declare function hashIp(ip: string | undefined): string;
export declare function log(level: LogLevel, event: string, meta?: LogMeta): void;
export declare const logger: Logger;
//# sourceMappingURL=logger.d.ts.map