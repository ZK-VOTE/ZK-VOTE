/**
 * Request Logging Middleware
 *
 * Provides request context and structured logging for all requests.
 */
import type { Request, Response, NextFunction } from "express";
/**
 * Request logging middleware
 * Adds context ID and logs request start/end
 */
export declare function requestLogger(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=logging.d.ts.map