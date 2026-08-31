/**
 * Rate Limiting Middleware
 *
 * Provides rate limiting with IP hashing for privacy.
 * Disabled in test mode (RELAYER_TEST_MODE=true) to allow test suite to run without rate limit interference.
 */
import type { Request, Response, NextFunction } from "express";
interface RateLimitMetricEntry {
    total: number;
    blocked: number;
}
/**
 * Get per-limiter request/block counts (in-process, resets on restart).
 * Surfaced via GET /health for authenticated callers.
 */
export declare function getRateLimitMetrics(): Record<string, RateLimitMetricEntry & {
    blockRate: number;
}>;
/**
 * Rate limiter for vote submissions per wallet address
 * Default 5 per minute per wallet address
 *
 * NOTE (#131): this and every limiter below use express-rate-limit's default
 * in-memory MemoryStore (or ClusterRateLimitStore when RELAYER_CLUSTER is
 * enabled, which only shares state across worker processes on the *same*
 * host). Neither is a true distributed store: when the backend runs as
 * multiple separate instances behind a load balancer (e.g. Fly.io scaling
 * across machines), each instance still counts independently, so the
 * effective limit is multiplied by the instance count. Fixing that requires
 * a shared external store (e.g. Redis via `rate-limit-redis`), which is a
 * new runtime dependency and real infra work — intentionally out of scope
 * for this pass. What's included here instead: both limiters now emit the
 * standard `RateLimit-*` headers plus the legacy `X-RateLimit-Remaining` /
 * `X-RateLimit-Reset` headers (previously only some limiters set the legacy
 * form), so clients can see and react to their remaining budget regardless
 * of which store ends up backing this later.
 */
export declare const walletRateLimiter: (_req: Request, _res: Response, next: NextFunction) => void;
/**
 * Rate limiter for vote submissions
 * 10 votes per minute per IP
 */
export declare const voteLimiter: (_req: Request, _res: Response, next: NextFunction) => void;
/**
 * Rate limiter for general queries
 * 60 requests per minute per IP
 */
export declare const queryLimiter: (_req: Request, _res: Response, next: NextFunction) => void;
/**
 * Rate limiter for IPFS uploads
 * 10 uploads per minute per IP
 */
export declare const ipfsUploadLimiter: (_req: Request, _res: Response, next: NextFunction) => void;
/**
 * Rate limiter for IPFS reads (more generous, cached content)
 * 200 reads per minute per IP
 */
export declare const ipfsReadLimiter: (_req: Request, _res: Response, next: NextFunction) => void;
/**
 * Rate limiter for comment submissions
 * 20 comments per minute per IP
 */
export declare const commentLimiter: (_req: Request, _res: Response, next: NextFunction) => void;
/**
 * Graduated throttling — applied globally, ahead of the per-route hard limiters.
 * Adds an increasing delay once a client crosses 40 requests/minute, capped at
 * 3s, so clients slow down before they get hard-blocked by a route's limiter.
 */
export declare const graduatedSlowDown: (_req: Request, _res: Response, next: NextFunction) => void;
/**
 * Rate limiter for vote-to-earn claim submissions
 * 10 claims per minute per IP (same as vote, anonymity-sensitive)
 */
export declare const claimLimiter: (_req: Request, _res: Response, next: NextFunction) => void;
export {};
//# sourceMappingURL=rateLimit.d.ts.map