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
import {
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestSize,
  httpRequestsInFlight,
  httpResponseSize,
} from "../services/metrics.js";
import { normalizeRoute } from "../services/metrics.js";

/**
 * Express middleware that records Prometheus metrics for every request.
 *
 * Bug fix: the original version referenced `route` before it was defined when
 * observing `httpRequestSize`. Request body size is measured on the way in
 * using `req.path` (the best label we have before the router resolves
 * `req.route.path`). Response-side metrics continue to use the resolved route
 * from `req.route.path` on the `finish` event, giving low-cardinality labels.
 */
export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();
  const method = req.method;
  let recorded = false;

  // Track request body size on the way in.
  // At this point `req.route` is not yet populated, so we normalise req.path.
  // This is intentionally separate from the finish-event route label so that
  // the observation is not lost for requests that never complete normally.
  const contentLength = parseInt(req.headers["content-length"] || "0", 10);
  if (contentLength > 0) {
    const inboundRoute = normalizeRoute(req.path);
    httpRequestSize.observe({ method, route: inboundRoute }, contentLength);
  }

  httpRequestsInFlight.inc({ method, route });
  // A client that disconnects mid-flight never reaches res.end, so decrement
  // exactly once from whichever of the two fires first.
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    httpRequestsInFlight.dec({ method, route });
  };
  res.on("close", release);

  // Capture the original end/finish to measure response
  const originalEnd = res.end;
  res.end = function (this: Response, ...args: Parameters<typeof originalEnd>) {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    const route = normalizeRoute(
      typeof req.route?.path === "string" ? req.route.path : req.path,
    );
    const status = String(res.statusCode);

    release();
    httpRequestsTotal.inc({ method, route, status });
    httpRequestDuration.observe({ method, route, status }, duration);

    const resContentLength = Number(res.getHeader("content-length") || 0);
    if (Number.isFinite(resContentLength) && resContentLength > 0) {
      httpResponseSize.observe({ method, route, status }, resContentLength);
    }
  });

  next();
}
