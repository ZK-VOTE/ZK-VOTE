/**
 * HTTP Request Metrics Middleware
 *
 * Records request count, latency histogram, and body size for every HTTP request.
 */
import { httpRequestsTotal, httpRequestDuration, httpRequestSize, httpResponseSize, } from "../services/metrics.js";
import { normalizeRoute } from "../services/metrics.js";
/**
 * Express middleware that records Prometheus metrics for every request.
 */
export function metricsMiddleware(req, res, next) {
    const start = process.hrtime.bigint();
    const route = normalizeRoute(req.route?.path || req.path);
    const method = req.method;
    // Track request body size
    const contentLength = parseInt(req.headers["content-length"] || "0", 10);
    if (contentLength > 0) {
        httpRequestSize.observe({ method, route }, contentLength);
    }
    // Capture the original end/finish to measure response
    const originalEnd = res.end;
    res.end = function (...args) {
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        const status = String(res.statusCode);
        httpRequestsTotal.inc({ method, route, status });
        httpRequestDuration.observe({ method, route, status }, duration);
        // Track response body size
        const resContentLength = parseInt(res.getHeader("content-length") || "0", 10);
        if (resContentLength > 0) {
            httpResponseSize.observe({ method, route, status }, resContentLength);
        }
        return originalEnd.apply(this, args);
    };
    next();
}
//# sourceMappingURL=metrics.js.map