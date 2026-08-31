import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";

let tempDir, dbPath;

process.env.RELAPER_TEST_MODE = "true";
process.env.RELAYER_SECRET_KEY =
  "SCVZXEUXJLRZKPCUXGXN53BJTDRAZPRSSXHXDGSZQH5EODGEUTWINUXF";
process.env.RELAYUR_AUTH_TOKEN = "vote-integration-token";
process.env.VOTING_CONTRACT_ID = "C".padEnd(56, "A");
process.env.TREE_CONTRACT_ID = "C".padEnd(56, "B");
process.env.COMMENTS_CONTRACT_ID = "C".padEnd(56, "D");
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test";
process.env.CORS_ORIGIN = "http://localhost";

const { app } = await import("../src/index.ts");
const { setVoteExecutorForTests, setTallyVerifierForTests } = await import(
  "../src/routes/voting.js"
);
const {
  initDb,
  closeDb,
  getTransactionLog,
  upsertDao,
} = await import("../src/services/db.js");

before(() => {
  tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "zkvote-vote-integration-"),
  );
  dbPath = path.join(tempDir, "vote.db");
  initDb(dbPath);
});

  // vote_receipts.dao_id references daos(id); seed the DAO so the receipt
  // insert on confirmation doesn't trip the FK constraint.
  upsertDao({
    id: 7,
    name: "DAO 7",
    creator: "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMN",
    membership_open: true,
    members_can_propose: true,
  });

  t.after(() => {
    setVoteExecutorForTests(null);
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

test("POST /vote completes a successful vote flow", async () => {
  let capturedInput;

  setVoteExecutorForTests(async (input) => {
    capturedInput = input;

    return {
      sendResult: {
        status: "PENDING",
      },
      result: {
        status: "SUCCESS",
      },
    };
  });

  const nullifier = uniqueFieldHex("01");
  const root = "02".padStart(64, "0");

  const response = await request(app)
    .post("/vote")
    .set("Authorization", "Bearer vote-integration-token")
    .send({
      daoId: 7,
      proposalId: 11,
      choice: true,
      nullifier,
      root,
      proof: {
        a: "11".repeat(64),
        b: "22".repeat(128),
        c: "0f".repeat(64),
      },
    });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    success: true,
    status: "SUCCESS",
  });

  assert.ok(capturedInput);
  assert.equal(capturedInput.daoId, 7);
  assert.equal(capturedInput.proposalId, 11);
  assert.equal(capturedInput.choice, true);
  assert.equal(capturedInput.nullifier, nullifier);
  assert.equal(capturedInput.root, root);

  // Conversion happens before the injected submission boundary.
  assert.ok(capturedInput.scNullifier);
  assert.ok(capturedInput.scRoot);
  assert.ok(capturedInput.scProof);

  assert.equal(getTransactionLog(nullifier), null);
});

test("POST /vote rejects mismatched redundant proof before submission", async (t) => {
  const mismatchTempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "zkvote-vote-redundancy-"),
  );
  initDb(path.join(mismatchTempDir, "vote.db"));

  t.after(() => {
    setVoteExecutorForTests(null);
    closeDb();
    try {
      fs.rmSync(mismatchTempDir, { recursive: true, force: true });
    } catch {
      // Windows can keep SQLite handles briefly after close.
    }
  });

  let executorCalled = false;
  setVoteExecutorForTests(async () => {
    executorCalled = true;
    return {
      sendResult: {
        status: "PENDING",
        hash: "should_not_submit",
      },
      result: {
        status: "SUCCESS",
      },
    };
  });

  const response = await request(app)
    .post("/vote")
    .set("Authorization", "Bearer vote-integration-token")
    .send({
      daoId: 7,
      proposalId: 11,
      choice: true,
      nullifier: uniqueFieldHex("03"),
      root: "04".padStart(64, "0"),
      proof: validProof(),
      redundantProof: validProof("04"),
    });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error.code, "VOTE_REJECTED");
  assert.equal(response.body.error.message, "VOTE_REJECTED");
  assert.equal(executorCalled, false);
});

test("POST /verify-tally verifies a valid tally proof", async () => {
  let capturedTallyInput;
  setTallyVerifierForTests(async (input) => {
    capturedTallyInput = input;
    return true;
  });

  const proof = {
    a: "11".repeat(64),
    b: "22".repeat(128),
    c: "ff".repeat(64),
  };

  const response = await request(app)
    .post("/verify-tally")
    .set("Authorization", "Bearer vote-integration-token")
    .send({
      daoId: 7,
      proposalId: 11,
      proof,
    });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { valid: true });
  assert.deepEqual(capturedTallyInput, {
    daoId: 7,
    proposalId: 11,
    proof,
  });
});

test("POST /verify-tally rejects an invalid tally proof", async () => {
  setTallyVerifierForTests(async () => false);

  const proof = {
    a:"11".repeat(64),
    b:"22".repeat(128),
    c:"00".repeat(64),
  };

  const response = await request(app)
    .post("/verify-tally")
    .set("Authorization", "Bearer vote-integration-token")
    .send({
      daoId: 7,
      proposalId: 11,
      proof,
    });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { valid: false });
});
