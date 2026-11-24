/**
 * Shared token-bucket limiter: NAT fairness, cross-replica sharing, atomic
 * consumption under concurrency and live quota overrides.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";

const DIR = fs.mkdtempSync(path.join(tmpdir(), "zkvote-rate-limit-"));
const DB_PATH = path.join(DIR, "rate.db");

const { initDb } = await import("../src/services/db.js");
const db = initDb(DB_PATH) as never;

const rateLimiter = await import("../src/middleware/rateLimiter.js");

test.after(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

const CFG = {
  ...rateLimiter.DEFAULT_RATE_LIMIT_CONFIG,
  votesPerWindow: 3,
  queriesPerWindow: 5,
  authPerWindow: 2,
};

test("members behind one NAT get independent budgets", () => {
  rateLimiter.configureRateLimitTokens({ hmacSecret: "test-secret-at-least-16" });
  const sign = (sub: string): string => {
    const payload = Buffer.from(
      JSON.stringify({ sub, exp: Date.now() + 60_000 }),
    ).toString("base64url");
    const signature = createHmac("sha256", "test-secret-at-least-16")
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  };
  const keyA = rateLimiter.getRateLimitKey("203.0.113.1", undefined, {
    membershipToken: sign("member-a"),
  });
  const keyB = rateLimiter.getRateLimitKey("203.0.113.1", undefined, {
    membershipToken: sign("member-b"),
  });
  assert.notEqual(keyA, keyB);

  const store = new rateLimiter.SharedRateLimitStore(db as never);
  for (let i = 0; i < 3; i++) {
    assert.equal(store.consume(keyA, "vote", CFG).allowed, true);
  }
  assert.equal(store.consume(keyA, "vote", CFG).allowed, false);
  // Same IP, different member: full independent budget remains.
  assert.equal(store.consume(keyB, "vote", CFG).allowed, true);
  assert.equal(store.status(keyB, CFG).votesRemaining, 2);
});

test("two replica stores share one atomic budget", () => {
  const storeA = new rateLimiter.SharedRateLimitStore(db as never);
  const storeB = new rateLimiter.SharedRateLimitStore(db as never);
  const key = "ratelimit:test:shared-budget";
  storeA.reset(key);

  assert.equal(storeA.consume(key, "vote", CFG).allowed, true);
  assert.equal(storeB.consume(key, "vote", CFG).allowed, true);
  const remaining = storeA.status(key, CFG).votesRemaining;
  assert.equal(remaining, 1, "both replicas must draw from the same bucket");
  assert.equal(storeB.consume(key, "vote", CFG).allowed, true);
  assert.equal(storeB.consume(key, "vote", CFG).allowed, false);
});

test("separate vote/query/auth buckets do not share quota", () => {
  const store = new rateLimiter.SharedRateLimitStore(db as never);
  const key = "ratelimit:test:separate-buckets";
  store.reset(key);
  for (let i = 0; i < CFG.votesPerWindow; i++) {
    store.consume(key, "vote", CFG);
  }
  assert.equal(store.consume(key, "vote", CFG).allowed, false);
  assert.equal(store.consume(key, "query", CFG).allowed, true);
  assert.equal(store.consume(key, "auth", CFG).allowed, true);
});

test("concurrent workers never over-issue tokens", async () => {
  // Two independent connections model two processes sharing one DB file.
  const secondConnection = new Database(DB_PATH);
  secondConnection.pragma("busy_timeout = 5000");
  const storeA = new rateLimiter.SharedRateLimitStore(db as never);
  const storeB = new rateLimiter.SharedRateLimitStore(
    secondConnection as never,
  );
  const key = "ratelimit:test:concurrent";
  storeA.reset(key);

  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      Promise.resolve().then(() =>
        (i % 2 === 0 ? storeA : storeB).consume(key, "vote", CFG).allowed,
      ),
    ),
  );
  assert.equal(
    results.filter(Boolean).length,
    CFG.votesPerWindow,
    "exactly the bucket capacity must be issued",
  );
  secondConnection.close();
});

test("admin quota overrides are read live by the limiter", () => {
  const store = new rateLimiter.SharedRateLimitStore(db as never);
  const key = "ratelimit:test:override";
  store.reset(key);
  rateLimiter.setQuotaOverride(key.replace("ratelimit:", ""), "vote", {
    maxTokens: 1,
    windowMs: CFG.windowMs,
  });
  // Overrides are keyed by the full bucket key in the limiter.
  rateLimiter.setQuotaOverride(key, "vote", {
    maxTokens: 1,
    windowMs: CFG.windowMs,
  });
  assert.equal(store.consume(key, "vote", CFG).allowed, true);
  assert.equal(store.consume(key, "vote", CFG).allowed, false);
});
