/**
 * CSRF Protection Middleware
 *
 * Validates Origin header for write requests when CORS is configured.
 * This adds defense-in-depth beyond the auth token.
 */
import type { Request, Response, NextFunction } from "express";
/**
 * CSRF guard middleware
 * Validates Origin header against allowed origins for write operations
 */
export declare function csrfGuard(req: Request, res: Response, next: NextFunction): void | Response;
//# sourceMappingURL=csrf.d.ts.map