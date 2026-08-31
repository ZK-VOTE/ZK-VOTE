import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "zkvote-route-coverage-"),
);
const dbPath = path.join(tempDir, "routes.db");

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_SECRET_KEY =
  "SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF";
process.env.RELAYER_AUTH_TOKEN = "route-coverage-token";
process.env.VOTING_CONTRACT_ID = "C".padEnd(56, "A");
process.env.TREE_CONTRACT_ID = "C".padEnd(56, "B");
process.env.COMMENTS_CONTRACT_ID = "C".padEnd(56, "D");
process.env.BRIDGE_CONTRACT_ID = "C".padEnd(56, "E");
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test";
process.env.CORS_ORIGIN = "http://localhost";
process.env.IPFS_ENABLED = "false";

delete process.env.DAO_REGISTRY_CONTRACT_ID;
delete process.env.MEMBERSHIP_SBT_CONTRACT_ID;

const { app } = await import("../src/index.ts");
const { initDb, closeDb } = await import("../src/services/db.js");

const auth = {
  Authorization: "Bearer route-coverage-token",
};

test("backend route matrix covers deterministic success and failure paths", async (t) => {
  initDb(dbPath);

  t.after(() => {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  let response = await request(app).get("/daos");

  assert.equal(response.statusCode, 200);
  assert.ok(Array.isArray(response.body.data));

  response = await request(app).get("/dao/999999");

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, {
    error: "DAO not found in cache",
  });

  response = await request(app).post("/daos/sync").set(auth);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    success: true,
    synced: 0,
  });

  response = await request(app).get("/ipfs/health");

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    enabled: false,
    status: "not_configured",
  });

  const validCid = `Qm${"1".repeat(44)}`;

  response = await request(app).get(`/ipfs/${validCid}`);
  assert.equal(response.statusCode, 503);

  response = await request(app).get(`/ipfs/image/${validCid}`);
  assert.equal(response.statusCode, 503);

  response = await request(app).get("/events/archived");

  assert.equal(response.statusCode, 200);
  assert.ok(Array.isArray(response.body.archives));

  response = await request(app).get("/indexer/status");
  assert.equal(response.statusCode, 200);

  response = await request(app).get("/indexer/daos");

  assert.equal(response.statusCode, 200);
  assert.ok(Array.isArray(response.body.daos));

  response = await request(app).post("/events").set(auth).send({});

  assert.equal(response.statusCode, 400);

  response = await request(app)
    .post("/events")
    .set(auth)
    .send({
      daoId: 1,
      type: "vote_cast",
      data: {
        proposalId: 1,
        choice: true,
      },
    });

  assert.equal(response.statusCode, 200);

  response = await request(app).get("/events/1");

  assert.equal(response.statusCode, 200);
  assert.ok(Array.isArray(response.body.data));
  assert.ok(response.body.data.length >= 1);

  response = await request(app).post("/events/notify").set(auth).send({});

  assert.equal(response.statusCode, 400);

  response = await request(app).post("/bridge/relay").set(auth);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);

  const commitment = "a".repeat(64);

  response = await request(app).get(`/comment/challenge/${commitment}`);

  assert.equal(response.statusCode, 200);
  assert.equal(typeof response.body, "object");
  assert.ok(Object.keys(response.body).length > 0);

  response = await request(app).get("/comments/1/1/nonce");

  assert.equal(response.statusCode, 400);

  response = await request(app).post("/comment/edit").set(auth).send({});

  assert.equal(response.statusCode, 400);

  response = await request(app).post("/comment/delete").set(auth).send({});

  assert.equal(response.statusCode, 400);

  // These handlers reach their controlled RPC boundary and fail closed
  // because the test server intentionally does not perform Soroban calls.
  response = await request(app).get("/proposal/1/1");
  assert.equal(response.statusCode, 500);

  response = await request(app).get("/root/1");
  assert.equal(response.statusCode, 500);

  // The comments list fails gracefully with 503 (service unavailable) when
  // the Soroban boundary is down, rather than a bare 500.
  response = await request(app).get("/comments/1/1");
  assert.equal(response.statusCode, 503);

  response = await request(app).get("/comment/1/1/1");
  assert.equal(response.statusCode, 500);

  const nullifier = `0x${"1".repeat(64)}`;

  response = await request(app).get(`/bridge/nullifier/1/1/${nullifier}`);

  assert.equal(response.statusCode, 500);
});
