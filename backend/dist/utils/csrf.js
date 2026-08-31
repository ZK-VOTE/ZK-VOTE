/**
 * CSRF Token Utilities
 *
 * Generates and validates CSRF tokens for defense-in-depth protection.
 * Uses cryptographically secure random tokens with session binding.
 */
import { createHash, randomBytes } from "crypto";
/**
 * Token storage for in-memory session management
 * In production, this should be replaced with a proper session store (Redis, etc.)
 */
const tokenStore = new Map();
/**
 * Clean up expired tokens periodically
 */
const TOKEN_TTL = 3600000; // 1 hour
const CLEANUP_INTERVAL = 300000; // 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, data] of tokenStore.entries()) {
        if (data.expires < now) {
            tokenStore.delete(sessionId);
        }
    }
}, CLEANUP_INTERVAL);
/**
 * Generate a session identifier for the request
 * Uses IP address and user agent for basic session binding
 */
function getSessionId(req) {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const userAgent = req.headers["user-agent"] || "unknown";
    return createHash("sha256").update(`${ip}:${userAgent}`).digest("hex");
}
/**
 * Generate a cryptographically secure CSRF token
 * Binds the token to the session for additional security
 */
export function generateCsrfToken(req) {
    const sessionId = getSessionId(req);
    const randomToken = randomBytes(32).toString("hex");
    // Create a token bound to the session
    const token = createHash("sha256")
        .update(`${sessionId}:${randomToken}`)
        .digest("hex");
    // Store the token with expiration
    tokenStore.set(sessionId, {
        token,
        expires: Date.now() + TOKEN_TTL,
    });
    return token;
}
/**
 * Validate a CSRF token against the stored token for the session
 */
export function validateCsrfToken(token, req) {
    const sessionId = getSessionId(req);
    const storedData = tokenStore.get(sessionId);
    if (!storedData) {
        return false;
    }
    // Check if token has expired
    if (storedData.expires < Date.now()) {
        tokenStore.delete(sessionId);
        return false;
    }
    // Use constant-time comparison to prevent timing attacks
    return timingSafeEqual(token, storedData.token);
}
/**
 * Constant-time string comparison to prevent timing attacks
 */
function timingSafeEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}
/**
 * Invalidate a CSRF token for a session
 * Called after successful token validation to prevent replay attacks
 */
export function invalidateCsrfToken(req) {
    const sessionId = getSessionId(req);
    tokenStore.delete(sessionId);
}
//# sourceMappingURL=csrf.js.map