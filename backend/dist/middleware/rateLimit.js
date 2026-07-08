/**
 * Rate Limiting Middleware
 *
 * Provides rate limiting with IP hashing for privacy.
 * Disabled in test mode (RELAYER_TEST_MODE=true) to allow test suite to run without rate limit interference.
 */
import rateLimit from "express-rate-limit";
import crypto from "crypto";
const isTestMode = process.env.RELAYER_TEST_MODE === "true";
// N11 hardening: RELAYER_TEST_MODE neuters auth + rate limits AND stubs the
// relayer keypair (stellar.ts). Refusing to start in this configuration in
// production prevents a post-foothold env flip from silently breaking every
// guardrail at the next restart.
if (process.env.NODE_ENV === "production" && isTestMode) {
    // eslint-disable-next-line no-console
    console.error("[fatal] RELAYER_TEST_MODE=true is forbidden when NODE_ENV=production");
    process.exit(1);
}
/**
 * No-op middleware for test mode - skips rate limiting
 */
const noopMiddleware = (_req, _res, next) => next();
/**
 * Hash an IP address to avoid storing raw IPs
 */
function hashIp(ip) {
    return crypto
        .createHash("sha256")
        .update(ip || "")
        .digest("hex");
}
/**
 * Key generator for rate limiters - uses hashed IP
 */
const keyGenerator = (req) => hashIp(req.ip || "");
/**
 * Rate limiter for vote submissions
 * 10 votes per minute per IP
 */
export const voteLimiter = isTestMode
    ? noopMiddleware
    : rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 10,
        message: { error: "Too many vote requests, please try again later" },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator,
    });
/**
 * Rate limiter for general queries
 * 60 requests per minute per IP
 */
export const queryLimiter = isTestMode
    ? noopMiddleware
    : rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 60,
        message: { error: "Too many requests, please try again later" },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator,
    });
/**
 * Rate limiter for IPFS uploads
 * 10 uploads per minute per IP
 */
export const ipfsUploadLimiter = isTestMode
    ? noopMiddleware
    : rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 10,
        message: { error: "Too many upload requests, please try again later" },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator,
    });
/**
 * Rate limiter for IPFS reads (more generous, cached content)
 * 200 reads per minute per IP
 */
export const ipfsReadLimiter = isTestMode
    ? noopMiddleware
    : rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 200,
        message: { error: "Too many requests, please try again later" },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator,
    });
/**
 * Rate limiter for comment submissions
 * 20 comments per minute per IP
 */
export const commentLimiter = isTestMode
    ? noopMiddleware
    : rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 20,
        message: { error: "Too many comment requests, please try again later" },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator,
    });
//# sourceMappingURL=rateLimit.js.map