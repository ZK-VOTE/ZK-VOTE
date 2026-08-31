/**
 * CSRF Protection Middleware
 *
 * Validates Origin/Referer headers and CSRF tokens for write requests when CORS is configured.
 * This adds defense-in-depth beyond the auth token following OWASP recommendations.
 *
 * Security hardening for issue #130:
 * - Rejects null origins explicitly (from sandboxed iframes, data URIs)
 * - Rejects requests with missing Origin AND missing Referer on write endpoints
 * - Uses exact origin matching (no wildcard subdomains)
 * - Implements CSRF token-based protection as defense-in-depth
 */
import { config } from "../config.js";
import { log } from "../services/logger.js";
import { generateCsrfToken, validateCsrfToken } from "../utils/csrf.js";
/**
 * CSRF guard middleware
 * Validates Origin/Referer headers and CSRF tokens for write operations
 */
export function csrfGuard(req, res, next) {
    // Skip for safe methods
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        return next();
    }
    // N12 hardening: with wildcard CORS, any third-party origin could POST
    // to write endpoints — fail-closed instead of waving the request through.
    // Production deploys must set CORS_ORIGIN to the frontend origin.
    if (config.corsOrigins === "*" || !config.corsOrigins) {
        log("warn", "csrf_blocked_wildcard_cors", { path: req.path });
        return res
            .status(403)
            .json({ error: "CORS_ORIGIN must be configured for write endpoints" });
    }
    // Get origin from headers. A malformed Referer must fail closed rather
    // than throwing and being converted into an internal server error.
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    let requestOrigin = typeof origin === "string" ? origin : null;
    if (!requestOrigin && typeof referer === "string") {
        try {
            requestOrigin = new URL(referer).origin;
        }
        catch {
            log("warn", "csrf_invalid_referer", {
                path: req.path,
                referer,
            });
            return res.status(403).json({ error: "Origin not allowed" });
        }
    }
    // Security hardening #1: Reject null origins explicitly
    // Null origins come from sandboxed iframes, data URIs, and other potentially malicious contexts
    if (origin === "null") {
        log("warn", "csrf_blocked_null_origin", { path: req.path });
        return res.status(403).json({ error: "Null origin not allowed" });
    }
    // Security hardening #2: Reject requests with missing Origin AND missing Referer
    // Some privacy browsers strip these headers, but for write endpoints we require at least one
    if (!origin && !referer) {
        log("warn", "csrf_blocked_missing_origin_referer", { path: req.path });
        return res
            .status(403)
            .json({ error: "Origin or Referer header required for write endpoints" });
    }
    // requestOrigin already computed above (origin || referer origin)
    // If we have an origin, validate it against allowed origins
    if (requestOrigin) {
        // Security hardening #3: Exact origin matching (no wildcard subdomains)
        // This prevents subdomain takeover attacks
        const allowedOrigins = Array.isArray(config.corsOrigins)
            ? config.corsOrigins
            : [config.corsOrigins];
        // Use exact matching only - no wildcard subdomain support
        if (!allowedOrigins.includes(requestOrigin)) {
            log("warn", "csrf_origin_mismatch", {
                path: req.path,
                origin: requestOrigin,
                allowed: allowedOrigins,
            });
            return res.status(403).json({ error: "Origin not allowed" });
        }
    }
    // Security hardening #4: CSRF token validation as defense-in-depth
    // Validate X-CSRF-Token header for state-changing requests
    const csrfToken = req.headers["x-csrf-token"];
    if (!csrfToken || !validateCsrfToken(csrfToken, req)) {
        log("warn", "csrf_invalid_token", {
            path: req.path,
            hasToken: !!csrfToken,
        });
        return res.status(403).json({ error: "Invalid or missing CSRF token" });
    }
    next();
}
/**
 * Middleware to generate and set CSRF token for clients
 * This should be applied to safe methods (GET, HEAD, OPTIONS) to provide tokens to the frontend
 */
export function csrfTokenMiddleware(req, res, next) {
    // Generate a new CSRF token for this session
    const token = generateCsrfToken(req);
    // Set the token in a response header so the frontend can retrieve it
    res.setHeader("X-CSRF-Token", token);
    // Also set it as a cookie for convenience (httpOnly for security)
    res.cookie("csrf_token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 3600000, // 1 hour
    });
    next();
}
//# sourceMappingURL=csrf.js.map