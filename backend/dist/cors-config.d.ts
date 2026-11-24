/**
 * CORS Configuration & Utilities
 */
import type { CorsOptions } from "cors";
/**
 * Parse and return the list of allowed CORS origins.
 */
export declare function getAllowedOrigins(input?: string | string[]): string[];
/**
 * Validate that CORS origins are exact URLs (no wildcards) in production.
 */
export declare function validateCorsOrigins(origins: string[]): void;
/**
 * Create CORS options with origin validator function.
 */
export declare function createCorsOptions(allowed?: string[] | string): CorsOptions;
//# sourceMappingURL=cors-config.d.ts.map