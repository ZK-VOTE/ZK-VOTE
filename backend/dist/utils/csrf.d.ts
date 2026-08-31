/**
 * CSRF Token Utilities
 *
 * Generates and validates CSRF tokens for defense-in-depth protection.
 * Uses cryptographically secure random tokens with session binding.
 */
import type { Request } from "express";
/**
 * Generate a cryptographically secure CSRF token
 * Binds the token to the session for additional security
 */
export declare function generateCsrfToken(req: Request): string;
/**
 * Validate a CSRF token against the stored token for the session
 */
export declare function validateCsrfToken(token: string, req: Request): boolean;
/**
 * Invalidate a CSRF token for a session
 * Called after successful token validation to prevent replay attacks
 */
export declare function invalidateCsrfToken(req: Request): void;
//# sourceMappingURL=csrf.d.ts.map