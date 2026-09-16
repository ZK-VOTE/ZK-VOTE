/**
 * Request Logging Middleware
 *
 * Provides request context, structured logging, and configurable sampling.
 *
 * Features:
 * - Configurable sampling rates per endpoint category
 * - Full request/response body logging for errors (4xx/5xx)
 * - Full body logging for slow requests (configurable threshold)
 * - Sensitive field redaction in logged bodies
 * - Request body logging opt-in per route
 * - Log volume metrics
 * - Trace ID correlation across all log entries
 * - Supports PII redaction via the enhanced logger
 * Provides request context and structured logging for all requests.
 * Supports PII redaction via the enhanced logger and correlation ID
 * propagation via AsyncLocalStorage so every downstream log call from
 * services/routes automatically carries the request's correlation + trace ID.
 */
import type { Request, Response, NextFunction } from "express";
declare global {
    namespace Express {
        interface Request {
            ctx?: string;
            traceId?: string;
            spanId?: string;
        }
    }
}
/**
 * Parses an inbound W3C `traceparent` header (version-traceid-parentid-flags,
 * https://www.w3.org/TR/trace-context/#traceparent-header) and returns its
 * trace ID, or `undefined` if the header is absent or malformed.
 */
export declare function parseIncomingTraceId(header: string | undefined): string | undefined;
interface LogMetrics {
    totalRequests: number;
    sampledIn: number;
    sampledOut: number;
    bodyLogged: number;
    errorLogged: number;
    slowLogged: number;
    lastReset: number;
}
/**
 * Get current log metrics snapshot and optionally reset counters.
 */
export declare function getLogMetrics(reset?: boolean): LogMetrics;
/**
 * Capture the request body for logging.
 * Middleware must be mounted before body parsing for this to work.
 * We use a response interceptor to capture the final response.
 */
export declare function captureResponseBody(res: Response): {
    getBody: () => unknown;
};
/**
 * Enhanced request logging middleware with sampling and body logging.
 *
 * Features:
 * - Context ID (trace ID) for request correlation
 * - Configurable sampling rates (per-route, per-error, per-slow)
 * - Full request/response body logging for errors and slow requests
 * - Sensitive field redaction
 * - Log volume metrics
 */
export declare function requestLogger(req: Request, res: Response, next: NextFunction): void;
/**
 * Middleware to expose log metrics on a diagnostic endpoint.
 */
export declare function logMetricsEndpoint(_req: Request, res: Response, _next: NextFunction): void;
/**
 * Error logging middleware with redaction
 * Logs errors without exposing sensitive data
 */
export declare function errorLogger(err: Error, req: Request, res: Response, next: NextFunction): void;
export {};
//# sourceMappingURL=logging.d.ts.map