/**
 * Request Logging Middleware
 *
 * Provides request context and structured logging for all requests.
 * Supports PII redaction via the enhanced logger.
 */
import type { Request, Response, NextFunction } from "express";
declare global {
    namespace Express {
        interface Request {
            ctx?: string;
            traceId?: string;
        }
    }
}
/**
 * Parses an inbound W3C `traceparent` header (version-traceid-parentid-flags,
 * https://www.w3.org/TR/trace-context/#traceparent-header) and returns its
 * trace ID, or `undefined` if the header is absent or malformed.
 */
export declare function parseIncomingTraceId(header: string | undefined): string | undefined;
/**
 * Request logging middleware
 * Adds context ID and logs request start/end
 */
export declare function requestLogger(req: Request, res: Response, next: NextFunction): void;
/**
 * Error logging middleware with redaction
 * Logs errors without exposing sensitive data
 */
export declare function errorLogger(err: Error, req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=logging.d.ts.map