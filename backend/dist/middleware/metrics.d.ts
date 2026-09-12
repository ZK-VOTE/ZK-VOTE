/**
 * HTTP Request Metrics Middleware
 *
 * Records request count, latency histogram, and body size for every HTTP
 * request, plus the in-flight concurrency gauge that makes relay backpressure
 * visible (#323): a rising in-flight count alongside a widening indexer poll
 * interval is the signature of a pipeline that is shedding rather than
 * queueing.
 */
import type { Request, Response, NextFunction } from "express";
/**
 * Express middleware that records Prometheus metrics for every request.
 *
 * Bug fix: the original version referenced `route` before it was defined when
 * observing `httpRequestSize`. Request body size is measured on the way in
 * using `req.path` (the best label we have before the router resolves
 * `req.route.path`). Response-side metrics continue to use the resolved route
 * from `req.route.path` on the `finish` event, giving low-cardinality labels.
 */
export declare function metricsMiddleware(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=metrics.d.ts.map