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
/**
 * CSRF guard middleware
 *
 * Validates Origin/Referer headers AND CSRF tokens for write operations.
 * Server-to-server calls (no browser Origin/Referer headers) bypass the check
 * because there is no browser session to protect against cross-site hijacking.
 */
export declare function csrfGuard(req: Request, res: Response, next: NextFunction): void | Response;
/**
 * Middleware to generate and set a fresh CSRF token for the caller.
 *
 * Apply this to safe GET routes so the frontend can obtain a token
 * before making any state-changing request.  The token is returned in
 * the X-CSRF-Token response header — the frontend must read that header
 * and include it in subsequent POST/PUT/DELETE requests.
 */
export declare function csrfTokenMiddleware(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=csrf.d.ts.map