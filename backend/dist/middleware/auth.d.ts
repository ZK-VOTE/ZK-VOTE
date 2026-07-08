/**
 * Authentication Middleware
 *
 * Provides auth token verification for write endpoints.
 * Uses constant-time comparison to prevent timing attacks.
 */
import type { Request, Response, NextFunction } from "express";
/**
 * Extract auth token from request headers
 */
export declare function extractAuthToken(req: Request): string | undefined;
/**
 * Authentication guard for write endpoints
 * Requires RELAYER_AUTH_TOKEN to be set and match
 * Uses constant-time comparison to prevent timing attacks
 */
export declare function authGuard(req: Request, res: Response, next: NextFunction): void | Response;
//# sourceMappingURL=auth.d.ts.map