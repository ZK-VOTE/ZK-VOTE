/**
 * HTTP Request Metrics Middleware
 *
 * Records request count, latency histogram, and body size for every HTTP request.
 */
import type { Request, Response, NextFunction } from "express";
/**
 * Express middleware that records Prometheus metrics for every request.
 */
export declare function metricsMiddleware(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=metrics.d.ts.map