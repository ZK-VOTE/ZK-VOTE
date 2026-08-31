import test from "node:test";
import assert from "node:assert";
import request from "supertest";
import express from "express";

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_SECRET_KEY =
  "SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF";
process.env.RELAYER_AUTH_TOKEN = "public-stats-token";
process.env.AUTH_MASTER_KEY = "public-stats-master-key";
process.env.VOTING_CONTRACT_ID = "C".padEnd(56, "A");
process.env.TREE_CONTRACT_ID = "C".padEnd(56, "B");
process.env.COMMENTS_CONTRACT_ID = "C".padEnd(56, "D");
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test";
process.env.CORS_ORIGIN = "http://localhost";

const { default: healthRoutes } = await import("../src/routes/health.js");

test("Public protocol stats endpoint exposes anonymized aggregate counts", async () => {
  const app = express();
  app.use(healthRoutes);

  const res = await request(app).get("/public-stats");

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
  assert.ok(typeof res.body.data.totalDaos === "number");
  assert.ok(typeof res.body.data.totalEvents === "number");
  assert.ok(typeof res.body.data.lastLedger === "number");
  assert.ok(typeof res.body.data.lastUpdated === "string");
  assert.ok(!("user" in res.body.data));
  assert.ok(!("address" in res.body.data));
  assert.ok(!("daoIds" in res.body.data));
});
