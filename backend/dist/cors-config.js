// @ts-nocheck
/**
 * CORS Configuration & Utilities
 */
import { config } from "./config.js";
/**
 * Parse and return the list of allowed CORS origins.
 */
export function getAllowedOrigins(input) {
    if (input === undefined) {
        const corsOrigins = config?.corsOrigins ?? config?.corsOrigin;
        if (corsOrigins) {
            return getAllowedOrigins(corsOrigins);
        }
        return ["*"];
    }
    if (Array.isArray(input)) {
        return input.map((s) => s.trim()).filter(Boolean);
    }
    if (typeof input === "string") {
        if (!input.trim())
            return [];
        return input
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }
    return ["*"];
}
/**
 * Validate that CORS origins are exact URLs (no wildcards) in production.
 */
export function validateCorsOrigins(origins) {
    const isProduction = process.env.NODE_ENV === "production";
    if (isProduction && origins.length === 0) {
        throw new Error("CORS_ORIGINS must specify at least one origin in production");
    }
    if (isProduction && origins.includes("*")) {
        throw new Error("CORS_ORIGINS must not be '*' in production; configure exact origins");
    }
    for (const origin of origins) {
        if (origin !== "*" && /[*?]/.test(origin)) {
            throw new Error(`CORS_ORIGINS origins must be exact URLs, not wildcard patterns: ${origin}`);
        }
        // Validate URL format for non-wildcard origins
        if (origin !== "*" && !origin.startsWith("http://") && !origin.startsWith("https://")) {
            throw new Error(`CORS_ORIGINS origin must be a valid URL starting with http:// or https://: ${origin}`);
        }
    }
}
/**
 * Create CORS options with origin validator function.
 */
export function createCorsOptions(allowed) {
    const origins = getAllowedOrigins(allowed);
    // Validate origins before creating options
    // Even in test mode, validate CORS origins to prevent test-mode bypass (#655)
    const isProduction = process.env.NODE_ENV === "production";
    const isTestMode = process.env.RELAYER_TEST_MODE === "true";
    if (isTestMode && isProduction) {
        throw new Error("RELAYER_TEST_MODE=true is forbidden in production");
    }
    validateCorsOrigins(origins);
    const allowAllCors = !isProduction && origins.includes("*");
    return {
        origin: (origin, callback) => {
            // Allow requests with no origin (like mobile apps, curl, server-to-server)
            if (!origin) {
                return callback(null, true);
            }
            if (allowAllCors) {
                return callback(null, true);
            }
            if (origins.includes(origin)) {
                return callback(null, true);
            }
            return callback(new Error(`Not allowed by CORS: ${origin}`));
        },
        credentials: !allowAllCors,
        methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
        allowedHeaders: [
            "Content-Type",
            "Authorization",
            "X-Requested-With",
            "X-CSRF-Token",
            "X-Idempotency-Key",
            "X-RateLimit-Limit",
            "X-RateLimit-Remaining",
        ],
        exposedHeaders: [
            "X-Token-Id",
            "X-Client-Id",
            "X-Service-Degraded",
            "X-Service-Status",
        ],
        maxAge: 3600,
    };
}
//# sourceMappingURL=cors-config.js.map