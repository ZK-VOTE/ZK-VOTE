import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zkvote-health-ttl-"));
const dbPath = path.join(tempDir, "health.db");

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_AUTH_TOKEN = "health-test-token";
process.env.RELAYER_SECRET_KEY =
  "SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF";
process.env.VOTING_CONTRACT_ID = StellarSdk.StrKey.encodeContract(
  Buffer.alloc(32, 21),
);
process.env.TREE_CONTRACT_ID = StellarSdk.StrKey.encodeContract(
  Buffer.alloc(32, 22),
);
process.env.COMMENTS_CONTRACT_ID = StellarSdk.StrKey.encodeContract(
  Buffer.alloc(32, 23),
);
process.env.SOROBAN_RPC_URL = "http://127.0.0.1:1";
process.env.NETWORK_PASSPHRASE = "Test";

const { config } = await import("../src/config.js");
const { default: healthRouter, initHealthRoutes } =
  await import("../src/routes/health.js");
const { initDb, closeDb } = await import("../src/services/db.js");
const ttlChecker = await import("../src/services/ttl-checker.js");

// Wire the DI-migrated ttl-checker (#358): it no longer reads the config/db
// module singletons directly, so tests must perform the same wiring the
// composition root does at boot, using the real singletons.
ttlChecker.initTtlChecker({
  server: (await import("../src/services/stellar.js")).server,
  ttlGracePeriodMs: config.ttlGracePeriodMs,
  ttlRenewalThresholdMs: config.ttlRenewalThresholdMs,
  testMode: config.testMode,
  getTTLTracking: (await import("../src/services/db.js")).getTTLTracking,
  upsertTTLTracking: (await import("../src/services/db.js")).upsertTTLTracking,
  log: (await import("../src/services/logger.js")).logger.log.bind(
    (await import("../src/services/logger.js")).logger,
  ),
});

const originalConfig = {
  healthcheckPing: config.healthcheckPing,
  healthExposeDetails: config.healthExposeDetails,
  relayerAuthToken: config.relayerAuthToken,
};

const app = express();
app.use(express.json());
app.use(healthRouter);

const auth = {
  Authorization: "Bearer health-test-token",
};

test.before(() => {
  initDb(dbPath);

  Object.assign(config, {
    healthcheckPing: true,
    healthExposeDetails: true,
    relayerAuthToken: "health-test-token",
  });
});

test.after(() => {
  Object.assign(config, originalConfig);
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("health reports an uninitialised RPC without exposing details", async () => {
  const response = await request(app).get("/health");

  assert.equal(response.statusCode, 200);
  // An unavailable RPC marks the "soroban_rpc" service unavailable, which
  // flips overall status to "degraded" per the graceful-degradation
  // behavior in routes/health.ts (process stays up, but callers are told).
  assert.equal(response.body.status, "degraded");
  assert.equal(response.body.rpc.ok, false);
  assert.match(response.body.rpc.error, /RPC server not initialized/);
  assert.equal(response.body.relayer, undefined);
  assert.equal(typeof response.body.db, "object");
});

test("health exposes details for an authenticated healthy RPC", async () => {
  initHealthRoutes(
    {
      async getHealth() {
        return { status: "healthy" };
      },
    },
    "GHEALTHRELAYER000000000000000000000000000000000000000000",
  );

  const response = await request(app).get("/health").set(auth);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.rpc.ok, true);
  assert.equal(
    response.body.relayer,
    "GHEALTHRELAYER000000000000000000000000000000000000000000",
  );
  assert.equal(response.body.votingContract, config.votingContractId);
  assert.equal(response.body.treeContract, config.treeContractId);
});

test("readiness rejects an offline RPC", async () => {
  initHealthRoutes(
    {
      async getHealth() {
        return { status: "offline" };
      },
    },
    "GOFFLINE",
  );

  const response = await request(app).get("/ready");

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.status, "degraded");
  assert.equal(response.body.rpc.ok, false);
});

test("readiness handles an RPC exception", async () => {
  initHealthRoutes(
    {
      async getHealth() {
        throw new Error("RPC unavailable");
      },
    },
    "GFAILED",
  );

  const response = await request(app).get("/ready");

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.status, "degraded");
  assert.equal(response.body.rpc.ok, false);
  assert.match(response.body.rpc.error, /RPC unavailable/);
});

test("readiness accepts online RPC and exposes authenticated details", async () => {
  initHealthRoutes(
    {
      async getHealth() {
        return { status: "online" };
      },
    },
    "GREADYRELAYER0000000000000000000000000000000000000000000",
  );

  let response = await request(app).get("/ready");

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ready");
  assert.equal(response.body.relayer, undefined);

  response = await request(app).get("/ready").set(auth);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "ready");
  assert.equal(
    response.body.relayer,
    "GREADYRELAYER0000000000000000000000000000000000000000000",
  );
});

test("public configuration returns backend contract settings", async () => {
  const response = await request(app).get("/config");

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.votingContract, config.votingContractId);
  assert.equal(response.body.treeContract, config.treeContractId);
  assert.equal(response.body.commentsContract, config.commentsContractId);
  assert.equal(response.body.networkPassphrase, config.networkPassphrase);
  assert.equal(typeof response.body.ipfsEnabled, "boolean");
});

test("database statistics hide diagnostics without authentication", async () => {
  const response = await request(app).get("/db/stats");

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "unauthorized");
  assert.equal(typeof response.body.db, "object");
});

test("database statistics expose diagnostics with authentication", async () => {
  const response = await request(app).get("/db/stats").set(auth);

  assert.equal(response.statusCode, 200);
  assert.equal(typeof response.body, "object");
  assert.notEqual(response.body.status, "unauthorized");
});

test("persistent TTL fallback returns a healthy untracked estimate", async () => {
  const contractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 24));

  const info = await ttlChecker.queryPersistentTTLWithFallback(
    contractId,
    7,
    "current_root",
    "ttl-test-entry",
  );

  assert.equal(info.entryId, "ttl-test-entry");
  assert.equal(info.contractId, contractId);
  assert.equal(info.daoId, 7);
  assert.equal(info.method, "current_root");
  assert.equal(info.urgency, "healthy");
  assert.equal(info.tracked, false);
  assert.ok(info.remainingMs > 0);
  assert.ok(info.remainingLedgers > 0);
});

test("TTL helper decisions cover healthy, warning and grace states", () => {
  const healthy = {
    remainingMs: config.ttlRenewalThresholdMs + 1,
    urgency: "healthy",
  };

  const warning = {
    remainingMs: config.ttlRenewalThresholdMs - 1,
    urgency: "warning",
  };

  const grace = {
    remainingMs: 90_000_000,
    urgency: "grace",
  };

  assert.equal(ttlChecker.needsRenewal(healthy), false);
  assert.equal(ttlChecker.needsRenewal(warning), true);

  assert.equal(ttlChecker.isInGracePeriod(healthy), false);
  assert.equal(ttlChecker.isInGracePeriod(grace), true);

  assert.equal(ttlChecker.formatRemaining(grace), "1d 1h");
});
