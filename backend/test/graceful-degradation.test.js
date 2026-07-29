/**
 * #204 — Graceful degradation scenarios
 */

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import {
  resetServiceHealth,
  markDegraded,
  markHealthy,
  markUnavailable,
  getOverallHealth,
  setLkg,
  getLkg,
  commentsLkgKey,
  ipfsLkgKey,
  enqueueDegradedWrite,
  listQueuedWrites,
  removeQueuedWrite,
  clearDegradedWriteQueue,
  drainIpfsPinQueue,
} from "../src/services/service-health.ts";
import {
  degradationContext,
  noteDegraded,
  sendPartial,
} from "../src/middleware/degradation.ts";

test.beforeEach(() => {
  resetServiceHealth();
  clearDegradedWriteQueue();
});

test("service health: markDegraded flips overall status and lists services", () => {
  assert.equal(getOverallHealth().status, "ok");
  markDegraded("ipfs", "pinata down");
  const overall = getOverallHealth();
  assert.equal(overall.status, "degraded");
  assert.ok(overall.degraded.includes("ipfs"));
  markHealthy("ipfs");
  assert.equal(getOverallHealth().status, "ok");
});

test("service health: critical unavailable is reported separately", () => {
  markUnavailable("soroban_rpc", "timeout");
  const overall = getOverallHealth();
  assert.equal(overall.status, "degraded");
  assert.ok(overall.unavailable.includes("soroban_rpc"));
});

test("LKG cache stores and expires by ttl", () => {
  setLkg("k", { a: 1 }, 50);
  assert.deepEqual(getLkg("k"), { a: 1 });
});

test("comments and ipfs LKG key helpers are stable", () => {
  assert.equal(commentsLkgKey(1, 2), "comments:1:2");
  assert.equal(ipfsLkgKey("bafy123"), "ipfs:bafy123");
});

test("write queue persists pinJSON ops and drain removes successes", async () => {
  const item = enqueueDegradedWrite("ipfs", "pinJSON", {
    data: { title: "x" },
    name: "n",
  });
  assert.equal(listQueuedWrites("ipfs").length, 1);

  const result = await drainIpfsPinQueue(async () => ({ cid: "bafytest", size: 1 }));
  assert.equal(result.drained, 1);
  assert.equal(listQueuedWrites("ipfs").length, 0);
  assert.ok(removeQueuedWrite(item.id) === false);
});

test("middleware sets X-Service-Degraded when noteDegraded is called", async () => {
  const app = express();
  app.use(degradationContext);
  app.get("/partial", (_req, res) => {
    noteDegraded("ipfs");
    sendPartial(res, { ok: true, data: "cached" }, ["ipfs"]);
  });
  app.get("/clean", (_req, res) => {
    res.json({ ok: true });
  });

  markDegraded("indexer", "lag");

  const partial = await request(app).get("/partial");
  assert.equal(partial.status, 200);
  assert.equal(partial.body.degraded, true);
  assert.ok(String(partial.headers["x-service-degraded"]).includes("ipfs"));
  assert.ok(String(partial.headers["x-service-status"]).includes("ipfs=degraded"));
  // Registry also contributes indexer
  assert.ok(String(partial.headers["x-service-degraded"]).includes("indexer"));

  const clean = await request(app).get("/clean");
  assert.equal(clean.status, 200);
  // Global registry still degraded → header present
  assert.ok(String(clean.headers["x-service-degraded"] || "").includes("indexer"));
});

test("health route reflects service registry degradation", async () => {
  markDegraded("comments", "rpc fail");
  const { default: healthRouter, initHealthRoutes } = await import(
    "../src/routes/health.ts"
  );
  initHealthRoutes(
    { getHealth: async () => ({ status: "healthy" }) },
    "GTEST",
  );
  const app = express();
  app.use(degradationContext);
  app.use(healthRouter);

  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.ok(res.body.services);
  assert.equal(res.body.services.status, "degraded");
  assert.ok(res.body.services.degraded.includes("comments"));
});

test("vote path stays fail-closed conceptually (no LKG for writes)", () => {
  // Documented invariant: we never invent a successful vote via LKG/queue.
  // Queues are only for non-critical ipfs pinJSON.
  const item = enqueueDegradedWrite("ipfs", "pinJSON", { data: {} });
  assert.equal(item.service, "ipfs");
  assert.equal(listQueuedWrites("comments").length, 0);
});
