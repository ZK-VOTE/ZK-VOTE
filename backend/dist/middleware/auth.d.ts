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
            isCoverTraffic?: boolean;
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
export declare function extractSessionToken(req: Request): string | undefined;
export declare function extractDaoId(req: Request): number | undefined;
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
/**
 * Anonymous authentication guard for public submission endpoints.
 * Allows requests without an auth token, typical for cover traffic and
 * anonymous vote submission via the decentralized relay network.
 * If the request is identified as cover traffic via the x-cover-traffic
 * header, a flag is set on the request for downstream tally filtering.
 */
export declare function anonymousGuard(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=auth.d.ts.map