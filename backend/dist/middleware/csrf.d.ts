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
import type { Request, Response, NextFunction } from "express";
/**
 * CSRF guard middleware
 * Validates Origin/Referer headers and CSRF tokens for write operations
 */
export declare function csrfGuard(req: Request, res: Response, next: NextFunction): void | Response;
/**
 * Middleware to generate and set CSRF token for clients
 * This should be applied to safe methods (GET, HEAD, OPTIONS) to provide tokens to the frontend
 */
export declare function csrfTokenMiddleware(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=csrf.d.ts.map