import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "zkvote-vote-outcomes-"),
);
const dbPath = path.join(tempDir, "vote.db");

process.env.RELAYER_TEST_MODE = "true";
process.env.RELAYER_SECRET_KEY =
  "SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF";
process.env.RELAYER_AUTH_TOKEN = "vote-outcomes-token";
process.env.VOTING_CONTRACT_ID = "C".padEnd(56, "A");
process.env.TREE_CONTRACT_ID = "C".padEnd(56, "B");
process.env.COMMENTS_CONTRACT_ID = "C".padEnd(56, "D");
process.env.BRIDGE_CONTRACT_ID = "C".padEnd(56, "E");
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test";
process.env.CORS_ORIGIN = "http://localhost";

const { app } = await import("../src/index.ts");
const { setVoteExecutorForTests } = await import(
  "../src/routes/voting.js"
);
const {
  initDb,
  closeDb,
  getTransactionLog,
  recordTransactionLog,
} = await import("../src/services/db.js");

function votePayload(nullifier) {
  return {
    daoId: 9,
    proposalId: 17,
    choice: false,
    nullifier,
    root: "02".padStart(64, "0"),
    proof: {
      a: "11".repeat(64),
      b: "22".repeat(128),
      c: "33".repeat(64),
    },
  };
}

test("POST /vote records failed confirmation and prevents replay", async (t) => {
  initDb(dbPath);

  t.after(() => {
    setVoteExecutorForTests(null);
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const failedNullifier = "03".padStart(64, "0");

  setVoteExecutorForTests(async () => ({
    sendResult: {
      status: "PENDING",
      hash: "vote_failed_tx_001",
    },
    result: {
      status: "FAILED",
    },
  }));

  const failedResponse = await request(app)
    .post("/vote")
    .set("Authorization", "Bearer vote-outcomes-token")
    .send(votePayload(failedNullifier));

  assert.equal(failedResponse.statusCode, 500);
  assert.deepEqual(failedResponse.body, {
    error: "Transaction failed",
    txHash: "vote_failed_tx_001",
    status: "FAILED",
  });

  const failedTransaction = getTransactionLog(failedNullifier);

  assert.ok(failedTransaction);
  assert.equal(failedTransaction.tx_hash, "vote_failed_tx_001");
  assert.equal(failedTransaction.status, "FAILED");

  const replayNullifier = "04".padStart(64, "0");
  recordTransactionLog(
    replayNullifier,
    "vote_existing_tx_001",
    "PENDING",
  );

  let executorCalls = 0;

  setVoteExecutorForTests(async () => {
    executorCalls++;

    return {
      sendResult: {
        status: "PENDING",
        hash: "should_not_execute",
      },
      result: {
        status: "SUCCESS",
      },
    };
  });

  const replayResponse = await request(app)
    .post("/vote")
    .set("Authorization", "Bearer vote-outcomes-token")
    .send(votePayload(replayNullifier));

  assert.equal(replayResponse.statusCode, 200);
  assert.deepEqual(replayResponse.body, {
    success: true,
    txHash: "vote_existing_tx_001",
    status: "PENDING",
    replayed: true,
  });
  assert.equal(executorCalls, 0);
});
