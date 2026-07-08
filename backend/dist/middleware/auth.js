/**
 * Authentication Middleware
 *
 * Provides auth token verification for write endpoints.
 * Uses constant-time comparison to prevent timing attacks.
 */
import { timingSafeEqual } from "crypto";
import { config } from "../config.js";
import { log } from "../services/logger.js";
/**
 * Extract auth token from request headers
 */
export function extractAuthToken(req) {
    const header = req.headers["x-relayer-auth"] || req.headers["authorization"];
    if (typeof header === "string" && header.startsWith("Bearer ")) {
        return header.slice("Bearer ".length);
    }
    return header;
}
/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true if strings are equal, false otherwise.
 */
function safeCompare(a, b) {
    // If lengths differ, we still need to do a constant-time compare
    // to avoid leaking length information. Pad the shorter one.
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        // Compare with padded buffer to maintain constant time
        // but always return false since lengths differ
        const padded = Buffer.alloc(bufA.length);
        bufB.copy(padded);
        timingSafeEqual(bufA, padded);
        return false;
    }
    return timingSafeEqual(bufA, bufB);
}
/**
 * Authentication guard for write endpoints
 * Requires RELAYER_AUTH_TOKEN to be set and match
 * Uses constant-time comparison to prevent timing attacks
 */
export function authGuard(req, res, next) {
    const token = extractAuthToken(req);
    const expectedToken = config.relayerAuthToken;
    if (!token || !expectedToken || !safeCompare(token, expectedToken)) {
        log("warn", "auth_failed", { path: req.path });
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}
//# sourceMappingURL=auth.js.map