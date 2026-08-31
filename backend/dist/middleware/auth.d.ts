/**
 * Authentication Middleware
 *
 * Provides auth token verification for write endpoints.
 * Supports multiple per-client tokens with expiration, rotation, and audit logging.
 * Uses constant-time comparison to prevent timing attacks.
 */
import type { Request, Response, NextFunction } from "express";
import type { AuthToken } from "../services/db.js";
declare global {
    namespace Express {
        interface Request {
            authToken?: AuthToken;
            authClientId?: string;
            authTokenId?: string;
        }
    }
}
/**
 * Extract auth token from request headers
 */
export declare function extractAuthToken(req: Request): string | undefined;
/**
 * Extract client ID from request headers
 */
export declare function extractClientId(req: Request): string | undefined;
/**
 * Authentication guard for write endpoints
 * Validates tokens against database with expiration and revocation checks.
 * Supports graceful rotation where old tokens remain valid during transition.
 */
export declare function authGuard(req: Request, res: Response, next: NextFunction): void | Response;
/**
 * Master key authentication guard for token management endpoints.
 * Uses the AUTH_MASTER_KEY environment variable.
 */
export declare function masterKeyGuard(req: Request, res: Response, next: NextFunction): void | Response;
//# sourceMappingURL=auth.d.ts.map