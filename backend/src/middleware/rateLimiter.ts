/**
 * Shared, cross-replica rate limiter with atomic token buckets.
 *
 * Counters live in the durable SQLite store, so all replicas enforce one
 * budget. Keys are derived from a signed anonymous membership token (or a
 * blinded credential) with IP only as a weak fallback — members behind one
 * NAT therefore get independent budgets. Separate vote/query/auth buckets
 * prevent polling from consuming a vote's quota.
 */

import crypto from "crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { config } from "../config.js";
import { getDb } from "../services/db.js";
import { ensureDurableSchema, type SqliteLike } from "../services/durable-schema.js";
import { log } from "../services/logger.js";
import {
  quotaOverridesReloadedTotal,
  rate_limit_store_size,
  sharedRateLimitDecisionsTotal,
} from "../services/metrics.js";

export type RateLimitBucket = "vote" | "query" | "auth";

export interface RateLimitConfig {
  votesPerWindow: number;
  queriesPerWindow: number;
  authPerWindow: number;
  windowMs: number;
  separateBudgets: boolean;
}

export interface RateLimitBudget {
  votesRemaining: number;
  queriesRemaining: number;
  authRemaining: number;
  windowResetAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  /** Key kind used for this decision, for audit logs (never a metric label). */
  keyKind: "membership" | "blinded" | "auth" | "ip";
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  votesPerWindow: 10,
  queriesPerWindow: 60,
  authPerWindow: 20,
  windowMs: 60 * 1000,
  separateBudgets: true,
};

type Db = SqliteLike & {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
};

let tokenHmacSecret: string | undefined = config.rateLimitTokenHmacSecret;

/** Inject/rotate the HMAC secret used to verify membership tokens at runtime. */
export function configureRateLimitTokens(opts: { hmacSecret?: string }): void {
  tokenHmacSecret = opts.hmacSecret ?? tokenHmacSecret;
}

/**
 * Verify a signed anonymous membership token without learning the member's
 * identity. Format: `<base64url(payload)>.<base64url(HMAC-SHA256(payload))>`.
 * Returns the payload only when the signature is valid and unexpired.
 */
export function verifyMembershipToken(token: string): Record<string, unknown> | null {
  if (!tokenHmacSecret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signatureB64] = parts;
  let expected: string;
  try {
    expected = crypto
      .createHmac("sha256", tokenHmacSecret)
      .update(payloadB64)
      .digest("base64url");
  } catch {
    return null;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureB64);
  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(Uint8Array.from(a), Uint8Array.from(b))
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (typeof payload.exp === "number" && payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export interface RateLimitKeyInput {
  ip?: string;
  userAgent?: string;
  /** Signed anonymous membership token from x-membership-token. */
  membershipToken?: string;
  /** Blinded credential (RSA blind-signature output), stable per voter. */
  blindedCredential?: string;
  /** Authenticated API-key client id — stronger fallback than IP. */
  clientId?: string;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Build a stable key. Strongest available identity wins so that all members
 * behind a NAT are isolated, while unknown callers still get an IP bucket.
 */
export function getRateLimitKey(
  ip: string,
  _userAgent?: string,
  input: Omit<RateLimitKeyInput, "ip"> = {},
): string {
  const membership = input.membershipToken
    ? verifyMembershipToken(input.membershipToken)
    : null;
  if (membership) return `ratelimit:membership:${hash(String(membership.sub))}`;
  if (input.blindedCredential) {
    return `ratelimit:blinded:${hash(input.blindedCredential)}`;
  }
  if (input.clientId) return `ratelimit:auth:${hash(input.clientId)}`;
  return `ratelimit:ip:${hash(ip || "unknown")}`;
}

export function getRateLimitKeyKind(input: RateLimitKeyInput): RateLimitDecision["keyKind"] {
  if (input.membershipToken && verifyMembershipToken(input.membershipToken)) {
    return "membership";
  }
  if (input.blindedCredential) return "blinded";
  if (input.clientId) return "auth";
  return "ip";
}

/** Request-aware key extraction (header names are documented in the API). */
export function rateLimitKeyFromRequest(req: Request): {
  key: string;
  keyKind: RateLimitDecision["keyKind"];
} {
  const headers = req.headers;
  const header = (name: string): string | undefined => {
    const value = headers[name];
    return typeof value === "string" ? value : undefined;
  };
  const input: RateLimitKeyInput = {
    ip: req.ip,
    userAgent: header("user-agent"),
    membershipToken: header("x-membership-token"),
    blindedCredential: header("x-blinded-credential"),
    clientId: header("x-client-id"),
  };
  return {
    key: getRateLimitKey(input.ip ?? "", input.userAgent, input),
    keyKind: getRateLimitKeyKind(input),
  };
}

// ── Live quota overrides ─────────────────────────────────────────────────────

export interface QuotaOverride {
  maxTokens: number;
  windowMs: number;
}

/** Admin API: write an override that the live limiter reads on every check. */
export function setQuotaOverride(
  subjectKey: string,
  bucket: RateLimitBucket,
  override: QuotaOverride,
  db: Db = getDb() as unknown as Db,
): void {
  ensureDurableSchema(db);
  db.prepare(
    `INSERT INTO rate_quota_overrides (subject_key, bucket, max_tokens, window_ms, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(subject_key, bucket) DO UPDATE SET
       max_tokens = excluded.max_tokens,
       window_ms = excluded.window_ms,
       updated_at = excluded.updated_at`,
  ).run(subjectKey, bucket, override.maxTokens, override.windowMs, Date.now());
}

/** Reconcile admin config (QUOTA_OVERAGE_JSON) into the live override table. */
export function reloadQuotaOverridesFromConfig(
  db: Db = getDb() as unknown as Db,
): number {
  if (!config.rateLimitOverridesJson) return 0;
  let parsed: Record<string, Partial<Record<RateLimitBucket, QuotaOverride>>>;
  try {
    parsed = JSON.parse(config.rateLimitOverridesJson);
  } catch (error) {
    log("error", "rate_limit_override_parse_failed", {
      error: (error as Error).message,
    });
    return 0;
  }
  ensureDurableSchema(db);
  let count = 0;
  const tx = db.transaction(() => {
    for (const [subject, buckets] of Object.entries(parsed)) {
      for (const bucket of ["vote", "query", "auth"] as const) {
        const override = buckets?.[bucket];
        if (!override) continue;
        setQuotaOverride(subject, bucket, override, db);
        count++;
      }
    }
  });
  tx();
  quotaOverridesReloadedTotal.inc(count);
  return count;
}

function getOverride(
  db: Db,
  subjectKey: string,
  bucket: RateLimitBucket,
): QuotaOverride | null {
  const row = db
    .prepare(
      "SELECT max_tokens, window_ms FROM rate_quota_overrides WHERE subject_key = ? AND bucket = ?",
    )
    .get(subjectKey, bucket) as { max_tokens: number; window_ms: number } | undefined;
  return row ? { maxTokens: row.max_tokens, windowMs: row.window_ms } : null;
}

function bucketColumn(bucket: RateLimitBucket): "tokens_vote" | "tokens_query" | "tokens_auth" {
  return bucket === "vote"
    ? "tokens_vote"
    : bucket === "query"
      ? "tokens_query"
      : "tokens_auth";
}

function capacityFor(
  bucket: RateLimitBucket,
  cfg: RateLimitConfig,
): number {
  if (!cfg.separateBudgets) return Math.max(cfg.votesPerWindow, cfg.queriesPerWindow);
  return bucket === "vote"
    ? cfg.votesPerWindow
    : bucket === "query"
      ? cfg.queriesPerWindow
      : cfg.authPerWindow;
}

// ── Atomic token bucket ──────────────────────────────────────────────────────

export class SharedRateLimitStore {
  constructor(private readonly db: Db = getDb() as unknown as Db) {
    ensureDurableSchema(db);
  }

  /**
   * Atomically consume one token. The conditional UPDATE is the whole critical
   * section: two workers sharing the DB file cannot both see the same token.
   */
  consume(
    key: string,
    type: RateLimitBucket,
    cfg: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
    now = Date.now(),
  ): RateLimitDecision {
    return this.db.transaction(() => {
      const override = getOverride(this.db, key, type);
      const column = bucketColumn(type);
      const initialTokens = {
        tokens_vote: capacityFor("vote", cfg),
        tokens_query: capacityFor("query", cfg),
        tokens_auth: capacityFor("auth", cfg),
      } as Record<string, number>;
      if (override) initialTokens[column] = override.maxTokens;

      this.db
        .prepare(
          `INSERT OR IGNORE INTO shared_rate_buckets
             (bucket_key, tokens_vote, tokens_query, tokens_auth, window_start, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          key,
          initialTokens.tokens_vote,
          initialTokens.tokens_query,
          initialTokens.tokens_auth,
          now,
          now,
        );

      const row = this.db
        .prepare("SELECT * FROM shared_rate_buckets WHERE bucket_key = ?")
        .get(key) as Record<string, number> | undefined;
      if (!row) throw new Error("rate limit bucket disappeared");

      const windowMs = override?.windowMs ?? cfg.windowMs;
      const resetAt = row.window_start + windowMs;

      if (now >= resetAt) {
        this.db
          .prepare(
            `UPDATE shared_rate_buckets
                SET tokens_vote = ?, tokens_query = ?, tokens_auth = ?,
                    window_start = ?, updated_at = ?
              WHERE bucket_key = ?`,
          )
          .run(
            initialTokens.tokens_vote,
            initialTokens.tokens_query,
            initialTokens.tokens_auth,
            now,
            now,
            key,
          );
      }

      // A live override that shrinks a bucket takes effect mid-window.
      if (override) {
        this.db
          .prepare(
            `UPDATE shared_rate_buckets SET ${column} = MIN(${column}, ?) WHERE bucket_key = ?`,
          )
          .run(override.maxTokens, key);
      }

      const consumed = this.db
        .prepare(
          `UPDATE shared_rate_buckets SET ${column} = ${column} - 1, updated_at = ?
            WHERE bucket_key = ? AND ${column} >= 1`,
        )
        .run(now, key);

      const allowed = consumed.changes === 1;
      const current = this.db
        .prepare(`SELECT ${column} AS tokens, window_start FROM shared_rate_buckets WHERE bucket_key = ?`)
        .get(key) as { tokens: number; window_start: number };
      sharedRateLimitDecisionsTotal.inc({ type, result: allowed ? "allowed" : "blocked" });
      return {
        allowed,
        remaining: Math.max(0, current.tokens),
        resetAt: current.window_start + windowMs,
        keyKind: "ip" as const,
      };
    })();
  }

  status(
    key: string,
    cfg: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
    now = Date.now(),
  ): RateLimitBudget {
    const row = this.db
      .prepare("SELECT * FROM shared_rate_buckets WHERE bucket_key = ?")
      .get(key) as Record<string, number> | undefined;
    if (!row || now >= row.window_start + cfg.windowMs) {
      return {
        votesRemaining: capacityFor("vote", cfg),
        queriesRemaining: capacityFor("query", cfg),
        authRemaining: capacityFor("auth", cfg),
        windowResetAt: now + cfg.windowMs,
      };
    }
    return {
      votesRemaining: Math.max(0, row.tokens_vote),
      queriesRemaining: Math.max(0, row.tokens_query),
      authRemaining: Math.max(0, row.tokens_auth),
      windowResetAt: row.window_start + cfg.windowMs,
    };
  }

  reset(key: string): void {
    this.db.prepare("DELETE FROM shared_rate_buckets WHERE bucket_key = ?").run(key);
  }

  clear(): void {
    this.db.prepare("DELETE FROM shared_rate_buckets").run();
  }

  size(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM shared_rate_buckets")
      .get() as { count: number };
    rate_limit_store_size.set(row.count);
    return row.count;
  }
}

const sharedStore = new SharedRateLimitStore();

// ── Module-level API (backwards compatible signatures) ──────────────────────

export function checkRateLimit(
  key: string,
  type: RateLimitBucket,
  cfg: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
): RateLimitDecision {
  return sharedStore.consume(key, type, cfg);
}

export function getRateLimitStatus(
  key: string,
  cfg: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
): RateLimitBudget {
  return sharedStore.status(key, cfg);
}

export function resetRateLimit(key: string): void {
  sharedStore.reset(key);
}

export function clearAllRateLimits(): void {
  sharedStore.clear();
}

export function getSharedRateLimitStoreSize(): number {
  return sharedStore.size();
}

// Keep the job scheduler's gauge hook consistent with the shared store.
(
  globalThis as { __rateLimitStoreSize?: () => number }
).__rateLimitStoreSize = getSharedRateLimitStoreSize;

/** Express middleware for a single bucket. Returns 429 with retry metadata. */
export function sharedRateLimiter(
  bucket: RateLimitBucket,
  cfg: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { key, keyKind } = rateLimitKeyFromRequest(req);
    const decision = sharedStore.consume(key, bucket, cfg);
    res.setHeader("RateLimit-Limit", String(capacityFor(bucket, cfg)));
    res.setHeader("RateLimit-Remaining", String(decision.remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil(decision.resetAt / 1000)));
    if (decision.allowed) {
      next();
      return;
    }
    log("warn", "shared_rate_limit_exceeded", { bucket, keyKind });
    res.status(429).json({
      error: "Too many requests",
      bucket,
      retryAfterMs: Math.max(0, decision.resetAt - Date.now()),
    });
  };
}
