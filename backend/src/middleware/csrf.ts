/**
 * CSRF Protection Middleware
 *
 * Validates Origin/Referer headers and CSRF tokens for write requests when CORS is configured.
 * This adds defense-in-depth beyond the auth token following OWASP recommendations.
 *
 * Security hardening for issue #130 / #333:
 * - Server-to-server requests (no Origin AND no Referer) are bypassed — they cannot be CSRF
 *   because there is no browser session to hijack
 * - Rejects null origins explicitly (from sandboxed iframes, data URIs)
 * - Uses exact origin matching (no wildcard subdomains)
 * - Implements CSRF token-based protection as defense-in-depth for browser requests
 *
 * Decision logic for write methods (POST, PUT, DELETE, PATCH):
 *   1. GET / HEAD / OPTIONS → pass through (safe methods)
 *   2. No Origin AND no Referer → pass through (server-to-server, cannot be CSRF)
 *   3. CORS configured as wildcard → block (fail-closed)
 *   4. origin === "null" → block (sandboxed iframe / data URI)
 *   5. Malformed Referer → block
 *   6. Resolved origin NOT in allowedOrigins → block
 *   7. Resolved origin in allowedOrigins + no X-CSRF-Token → block
 *   8. Resolved origin in allowedOrigins + invalid X-CSRF-Token → block
 *   9. Resolved origin in allowedOrigins + valid X-CSRF-Token → allow
 */

import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { log } from "../services/logger.js";
import { generateCsrfToken, validateCsrfToken } from "../utils/csrf.js";

/**
 * CSRF guard middleware
 *
 * Validates Origin/Referer headers AND CSRF tokens for write operations.
 * Server-to-server calls (no browser Origin/Referer headers) bypass the check
 * because there is no browser session to protect against cross-site hijacking.
 */
export function csrfGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void | Response {
  // Step 1: Skip for safe methods — GET, HEAD, OPTIONS are read-only
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  // Step 2: Server-to-server bypass.
  // Requests with no Origin AND no Referer are not browser-initiated, so they
  // cannot be cross-site request forgeries (there is no session to hijack).
  // Legitimate API clients, cron jobs, and CLI tools fall into this category.
  if (!origin && !referer) {
    return next();
  }

  // From here on we know at least one of origin/referer is present, which
  // means this is a browser request and CSRF protection applies in full.

  // Step 3: With wildcard CORS any third-party origin could POST to write
  // endpoints — fail-closed instead of waving the request through.
  // Production deploys must set CORS_ORIGIN to the frontend origin.
  if (config.corsOrigins === "*" || !config.corsOrigins) {
    log("warn", "csrf_blocked_wildcard_cors", { path: req.path });
    return res
      .status(403)
      .json({ error: "CORS_ORIGIN must be configured for write endpoints" });
  }

  // Step 4: Reject null origins explicitly.
  // Null origins come from sandboxed iframes, data URIs, and other potentially
  // malicious contexts.
  if (origin === "null") {
    log("warn", "csrf_blocked_null_origin", { path: req.path });
    return res.status(403).json({ error: "Null origin not allowed" });
  }

  // Step 5: Resolve the request origin from Origin header first, then Referer.
  // A malformed Referer must fail closed rather than throwing and being
  // converted into an internal server error.
  let requestOrigin: string | null = typeof origin === "string" ? origin : null;

  if (!requestOrigin && typeof referer === "string") {
    try {
      requestOrigin = new URL(referer).origin;
    } catch {
      log("warn", "csrf_invalid_referer", {
        path: req.path,
        referer,
      });
      return res.status(403).json({ error: "Origin not allowed" });
    }
  }

  // Step 6: Validate origin against the allow-list using exact matching.
  // This prevents subdomain takeover attacks.
  const allowedOrigins = Array.isArray(config.corsOrigins)
    ? config.corsOrigins
    : [config.corsOrigins];

  if (!requestOrigin || !allowedOrigins.includes(requestOrigin)) {
    log("warn", "csrf_origin_mismatch", {
      path: req.path,
      origin: requestOrigin,
      allowed: allowedOrigins,
    });
    return res.status(403).json({ error: "Origin not allowed" });
  }

  // Steps 7–9: Origin is valid. Now enforce the CSRF token as the second
  // defence-in-depth layer. This stops attacks from same-origin but different
  // pages (e.g. XSS-assisted forgery is still prevented by token mismatch).
  const csrfToken = req.headers["x-csrf-token"] as string | undefined;
  if (!csrfToken) {
    log("warn", "csrf_missing_token", {
      path: req.path,
    });
    return res.status(403).json({ error: "Invalid or missing CSRF token" });
  }

  if (!validateCsrfToken(csrfToken, req)) {
    log("warn", "csrf_invalid_token", {
      path: req.path,
      hasToken: true,
    });
    return res.status(403).json({ error: "Invalid or missing CSRF token" });
  }

  next();
}

/**
 * Middleware to generate and set a fresh CSRF token for the caller.
 *
 * Apply this to safe GET routes so the frontend can obtain a token
 * before making any state-changing request.  The token is returned in
 * the X-CSRF-Token response header — the frontend must read that header
 * and include it in subsequent POST/PUT/DELETE requests.
 */
export function csrfTokenMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Only issue tokens on safe methods — don't re-issue on the write path
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  // Generate a new CSRF token bound to this session
  const token = generateCsrfToken(req);

  // Expose the token in the response header so the SPA can read it.
  // We intentionally do NOT set a cookie (the frontend reads the header
  // directly, which avoids the subdomain-cookie-theft vector).
  res.setHeader("X-CSRF-Token", token);

  next();
}
