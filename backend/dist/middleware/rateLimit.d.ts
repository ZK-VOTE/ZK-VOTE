/**
 * Rate Limiting Middleware
 *
 * Provides rate limiting with IP hashing for privacy.
 * Disabled in test mode (RELAYER_TEST_MODE=true) to allow test suite to run without rate limit interference.
 */
import type { Request, Response, NextFunction } from "express";
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
//# sourceMappingURL=rateLimit.d.ts.map