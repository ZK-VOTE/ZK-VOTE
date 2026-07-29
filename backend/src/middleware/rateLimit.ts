/**
 * Rate Limiting Middleware
 *
 * Provides rate limiting with IP hashing for privacy.
 * Disabled in test mode (RELAYER_TEST_MODE=true) to allow test suite to run without rate limit interference.
 */

import rateLimit from "express-rate-limit";
import slowDown from "express-slow-down";
import crypto from "crypto";
import cluster from "node:cluster";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { config } from "../config.js";
import { log } from "../services/logger.js";
import { extractAuthToken } from "./auth.js";
import { RedisStore } from "./redisStore.js";
import { ClusterRateLimitStore } from "../services/cluster.js";
import type { Store } from "express-rate-limit";

const isTestMode = process.env.RELAYER_TEST_MODE === "true";

/**
 * Store selection: cluster IPC store when running as a Node cluster worker
 * on a single machine (CLUSTER_ENABLED=true), otherwise Redis so counters
 * are shared across separate Fly.io machines (#131). Cluster mode does NOT
 * cross machine boundaries, so Redis remains required whenever
 * CLUSTER_ENABLED is unset/false, which is the current Fly.io default.
 */
function getStore(name: string): Store {
  if (config.clusterEnabled && cluster.isWorker) {
    return new ClusterRateLimitStore(name);
  }
  return new RedisStore(name);
}

// N11 hardening: RELAYER_TEST_MODE neuters auth + rate limits AND stubs the
// relayer keypair (stellar.ts). Refusing to start in this configuration in
// production prevents a post-foothold env flip from silently breaking every
// guardrail at the next restart.
if (process.env.NODE_ENV === "production" && isTestMode) {
  console.error(
    "[fatal] RELAYER_TEST_MODE=true is forbidden when NODE_ENV=production",
  );
  process.exit(1);
}

/**
 * No-op middleware for test mode - skips rate limiting
 */
const noopMiddleware = (_req: Request, _res: Response, next: NextFunction) =>
  next();

/**
 * Hash an IP address to avoid storing raw IPs
 */
function hashIp(ip: string | undefined): string {
  return crypto
    .createHash("sha256")
    .update(ip || "")
    .digest("hex");
}

/**
 * Key generator for rate limiters - uses hashed IP
 */
const keyGenerator = (req: Express.Request): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hashIp((req as any).ip || "");

/**
 * Key generator that buckets by auth token when present, falling back to
 * hashed IP. Prevents an authenticated client from resetting its limit by
 * rotating IPs, while still rate limiting unauthenticated traffic by IP.
 */
const authOrIpKeyGenerator = (req: Express.Request): string => {
  const token = extractAuthToken(req as unknown as Request);
  if (token) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return hashIp((req as any).ip || "");
};

// ============================================
// PER-ENDPOINT METRICS (#193)
// ============================================

interface RateLimitMetricEntry {
  total: number;
  blocked: number;
}

const rateLimitMetrics: Record<string, RateLimitMetricEntry> = {};

function recordRequest(name: string): void {
  const entry = (rateLimitMetrics[name] ??= { total: 0, blocked: 0 });
  entry.total++;
}

function recordBlocked(name: string): void {
  const entry = (rateLimitMetrics[name] ??= { total: 0, blocked: 0 });
  entry.blocked++;
}

/**
 * Get per-limiter request/block counts (in-process, resets on restart).
 * Surfaced via GET /health for authenticated callers.
 */
export function getRateLimitMetrics(): Record<
  string,
  RateLimitMetricEntry & { blockRate: number }
> {
  const out: Record<string, RateLimitMetricEntry & { blockRate: number }> = {};
  for (const [name, m] of Object.entries(rateLimitMetrics)) {
    out[name] = {
      ...m,
      blockRate:
        m.total > 0 ? Math.round((m.blocked / m.total) * 100) / 100 : 0,
    };
  }
  return out;
}

/**
 * Wrap a limiter to count every request that passes through it (allowed or blocked).
 */
function withMetrics(name: string, limiter: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    recordRequest(name);
    limiter(req, res, next);
  };
}

/**
 * Build a 429 handler that includes structured rate-limit info in the body
 * (limit/remaining/retryAfter/resetTime), on top of the standard headers
 * express-rate-limit already sets (RateLimit-*, X-RateLimit-*, Retry-After).
 */
function makeHandler(name: string, message: string) {
  return (req: Request, res: Response): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = (req as any).rateLimit as
      | { limit: number; remaining: number; resetTime?: Date }
      | undefined;
    const resetTime = info?.resetTime;
    const retryAfter = resetTime
      ? Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
      : 60;

    recordBlocked(name);
    log("warn", "rate_limit_exceeded", { limiter: name, path: req.path });

    res.status(429).json({
      error: message,
      limiter: name,
      limit: info?.limit,
      remaining: info?.remaining ?? 0,
      retryAfter,
      resetTime: resetTime ? resetTime.toISOString() : undefined,
    });
  };
}

/**
 * Shared header config: both the modern RateLimit-* (draft-6) headers and the
 * legacy X-RateLimit-* headers are sent, since API consumers may expect either.
 */
const headerOptions = {
  standardHeaders: true as const,
  legacyHeaders: true,
};

/**
 * Key generator for wallet address rate limiter
 */
const walletKeyGenerator = (req: Express.Request): string => {
  const wallet = (req as any).body?.walletAddress || (req as any).headers?.["x-wallet-address"] || (req as any).ip || "";
  return crypto.createHash("sha256").update(String(wallet)).digest("hex");
};

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
export const walletRateLimiter = isTestMode
  ? noopMiddleware
  : rateLimit({
      windowMs: 60 * 1000,
      max: 5,
      message: { error: "Too many proof submissions for this wallet address, please try again later" },
      standardHeaders: true,
      legacyHeaders: true,
      keyGenerator: walletKeyGenerator,
    });

/**
 * Rate limiter for vote submissions
 * 10 votes per minute per IP
 */
export const voteLimiter = isTestMode
  ? noopMiddleware
  : withMetrics(
      "vote",
      rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 10,
        ...headerOptions,
        keyGenerator: authOrIpKeyGenerator,
        store: getStore("vote"),
        handler: makeHandler(
          "vote",
          "Too many vote requests, please try again later",
        ),
      }),
    );

/**
 * Rate limiter for general queries
 * 60 requests per minute per IP
 */
export const queryLimiter = isTestMode
  ? noopMiddleware
  : withMetrics(
      "query",
      rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 60,
        ...headerOptions,
        keyGenerator: authOrIpKeyGenerator,
        store: getStore("query"),
        handler: makeHandler(
          "query",
          "Too many requests, please try again later",
        ),
      }),
    );

/**
 * Rate limiter for IPFS uploads
 * 10 uploads per minute per IP
 */
export const ipfsUploadLimiter = isTestMode
  ? noopMiddleware
  : withMetrics(
      "ipfsUpload",
      rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 10,
        ...headerOptions,
        keyGenerator: authOrIpKeyGenerator,
        store: getStore("ipfsUpload"),
        handler: makeHandler(
          "ipfsUpload",
          "Too many upload requests, please try again later",
        ),
      }),
    );

/**
 * Rate limiter for IPFS reads (more generous, cached content)
 * 200 reads per minute per IP
 */
export const ipfsReadLimiter = isTestMode
  ? noopMiddleware
  : withMetrics(
      "ipfsRead",
      rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 200,
        ...headerOptions,
        keyGenerator: authOrIpKeyGenerator,
        store: getStore("ipfsRead"),
        handler: makeHandler(
          "ipfsRead",
          "Too many requests, please try again later",
        ),
      }),
    );

/**
 * Rate limiter for comment submissions
 * 20 comments per minute per IP
 */
export const commentLimiter = isTestMode
  ? noopMiddleware
  : withMetrics(
      "comment",
      rateLimit({
        windowMs: 60 * 1000, // 1 minute
        max: 20,
        ...headerOptions,
        keyGenerator: authOrIpKeyGenerator,
        store: getStore("comment"),
        handler: makeHandler(
          "comment",
          "Too many comment requests, please try again later",
        ),
      }),
    );

/**
 * Graduated throttling — applied globally, ahead of the per-route hard limiters.
 * Adds an increasing delay once a client crosses 40 requests/minute, capped at
 * 3s, so clients slow down before they get hard-blocked by a route's limiter.
 */
export const graduatedSlowDown = isTestMode
  ? noopMiddleware
  : slowDown({
      windowMs: 60 * 1000,
      delayAfter: 40,
      delayMs: (used: number) => Math.min((used - 40) * 100, 3000),
      maxDelayMs: 3000,
      store: getStore("slowDown"),
      keyGenerator,
      validate: { delayMs: false },
    });
