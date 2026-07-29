/**
 * Verifies distributed (Redis-backed) rate limiting in isolation.
 *
 * Deliberately does NOT import src/index.ts or any route file — several
 * unrelated route files (voting.ts, backup.ts, dbWorkerPool.ts) currently
 * have pre-existing syntax corruption on main unrelated to #131 and are
 * out of scope for this fix. This test only exercises RedisStore and the
 * rateLimit.ts middleware directly against a real Redis instance.
 */

import test from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import http from "node:http";
import { RedisStore } from "../src/middleware/redisStore.js";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { redis } from "../src/services/redisClient.js";

function buildApp(prefix: string, max: number): Express {
  const app = express();
  app.set("trust proxy", true);
  const limiter = rateLimit({
    windowMs: 5000,
    max,
    standardHeaders: true,
    legacyHeaders: true,
    store: new RedisStore(prefix),
    keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  });
  app.get("/probe", limiter, (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

async function listen(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function get(port: number, ip: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/probe", method: "GET", headers: { "X-Forwarded-For": ip } },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode || 0, headers: res.headers });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("shares rate limit counters across separate app instances via Redis (#131)", async () => {
  const max = 5;
  const prefix = `test_vote_${Date.now()}`;
  const instances = [buildApp(prefix, max), buildApp(prefix, max), buildApp(prefix, max)];
  const servers = await Promise.all(instances.map(listen));

  try {
    const ip = "203.0.113.7";
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      const server = servers[i % servers.length];
      const res = await get(server.port, ip);
      statuses.push(res.status);
    }

    const successCount = statuses.filter((s) => s === 200).length;
    const blockedCount = statuses.filter((s) => s === 429).length;

    assert.equal(successCount, max, `expected exactly ${max} successes across 3 instances, got ${successCount}`);
    assert.equal(blockedCount, 9 - max);
  } finally {
    await Promise.all(servers.map((s) => s.close()));
  }
});

test("sets X-RateLimit headers on every response", async () => {
  const prefix = `test_headers_${Date.now()}`;
  const app = buildApp(prefix, 10);
  const server = await listen(app);
  try {
    const res = await get(server.port, "203.0.113.8");
    assert.ok(res.headers["ratelimit-limit"] || res.headers["x-ratelimit-limit"]);
  } finally {
    await server.close();
  }
});

test("isolates buckets by IP", async () => {
  const prefix = `test_ip_${Date.now()}`;
  const app = buildApp(prefix, 2);
  const server = await listen(app);
  try {
    await get(server.port, "203.0.113.10");
    await get(server.port, "203.0.113.10");
    const blocked = await get(server.port, "203.0.113.10");
    const ok = await get(server.port, "203.0.113.11");

    assert.equal(blocked.status, 429);
    assert.equal(ok.status, 200);
  } finally {
    await server.close();
  }
});

test.after(async () => {
  if (redis) await redis.quit();
});
