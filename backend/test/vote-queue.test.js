import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "zkvote-vote-queue-"),
);
const dbPath = path.join(tempDir, "vote_queue.db");

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_SECRET_KEY =
  "SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF";
process.env.RELAYER_AUTH_TOKEN = "queue-test-token";
process.env.VOTING_CONTRACT_ID = "C".padEnd(56, "A");
process.env.TREE_CONTRACT_ID = "C".padEnd(56, "B");
process.env.COMMENTS_CONTRACT_ID = "C".padEnd(56, "D");
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test";
process.env.CORS_ORIGIN = "http://localhost";

const { app } = await import("../src/index.ts");
const { setVoteExecutorForTests } = await import(
  "../src/routes/voting.js",
);
const { initDb, closeDb } = await import("../src/services/db.js");

test("POST /vote accepts async job and GET /vote/status/:jobId reports completion", async (t) => {
  initDb(dbPath);

  t.after(() => {
    setVoteExecutorForTests(null);
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  setVoteExecutorForTests(async () => ({
    sendResult: {
      status: "PENDING",
      hash: "queued_test_tx_123",
    },
    result: {
      status: "SUCCESS",
    },
  }));

  const nullifier = "01".padStart(64, "0");
  const root = "02".padStart(64, "0");

  const accepted = await request(app)
    .post("/vote")
    .set("Authorization", "Bearer queue-test-token")
    .send({
      daoId: 7,
      proposalId: 11,
      choice: true,
      nullifier,
      root,
      proof: {
        a: "11".repeat(64),
        b: "22".repeat(128),
        c: "33".repeat(64),
      },
    });

  assert.equal(accepted.statusCode, 202);
  assert.ok(accepted.body.jobId);
  assert.equal(accepted.body.status, "QUEUED");

  let statusResponse;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    statusResponse = await request(app).get(`/vote/status/${accepted.body.jobId}`);
    if (statusResponse.body.status === "COMPLETED") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(statusResponse.statusCode, 200);
  assert.equal(statusResponse.body.status, "COMPLETED");
  assert.equal(statusResponse.body.txHash, "queued_test_tx_123");
});
