import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RELAYER_TEST_MODE = "true";
process.env.VOTING_CONTRACT_ID = "C".padEnd(56, "A");
process.env.TREE_CONTRACT_ID = "C".padEnd(56, "B");
process.env.COMMENTS_CONTRACT_ID = "C".padEnd(56, "D");
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test";

const { config } = await import("../src/config.js");
const {
  renewAllTTLs,
  setTTLSubmitterForTests,
} = await import("../src/services/ttl.js");
const db = await import("../src/services/db.js");

const contractA = "C".padEnd(56, "A");
const contractB = "C".padEnd(56, "B");
const contractD = "C".padEnd(56, "D");

const originalConfig = {
  votingContractId: config.votingContractId,
  treeContractId: config.treeContractId,
  commentsContractId: config.commentsContractId,
  daoRegistryContractId: config.daoRegistryContractId,
  membershipSbtContractId: config.membershipSbtContractId,
  ttlCheckEnabled: config.ttlCheckEnabled,
  ttlCostTrackingEnabled: config.ttlCostTrackingEnabled,
  ttlBatchSize: config.ttlBatchSize,
};

function configure(overrides = {}) {
  Object.assign(config, {
    votingContractId: undefined,
    treeContractId: undefined,
    commentsContractId: undefined,
    daoRegistryContractId: undefined,
    membershipSbtContractId: undefined,
    ttlCheckEnabled: false,
    ttlCostTrackingEnabled: true,
    ttlBatchSize: 2,
    ...overrides,
  });
}

function createDatabase() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "zkvote-ttl-service-"),
  );
  const databasePath = path.join(directory, "ttl.db");

  db.initDb(databasePath);

  return {
    cleanup() {
      db.closeDb();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function restore(database) {
  setTTLSubmitterForTests(null);
  Object.assign(config, originalConfig);
  database.cleanup();
}

test("TTL renewal records an empty healthy cycle", async (t) => {
  const database = createDatabase();
  t.after(() => restore(database));

  configure();

  let submitCalls = 0;

  setTTLSubmitterForTests(async () => {
    submitCalls++;
    return { success: true };
  });

  await renewAllTTLs();

  assert.equal(submitCalls, 0);

  const logs = db.getTTLCostLogs();

  assert.equal(logs.length, 1);
  assert.equal(logs[0].entriesRenewed, 0);
  assert.equal(logs[0].entriesSkipped, 0);
  assert.equal(logs[0].txCount, 0);
  assert.equal(logs[0].totalFeeXlm, 0);
  assert.equal(logs[0].status, "completed");
});

test("TTL renewal persists successful tracking", async (t) => {
  const database = createDatabase();
  t.after(() => restore(database));

  configure({
    votingContractId: contractA,
  });

  const calls = [];

  setTTLSubmitterForTests(async (contractId, method, args) => {
    calls.push({ contractId, method, args });

    return {
      success: true,
      feeXlm: 0.01,
      txHash: "ttl_success_tx",
    };
  });

  await renewAllTTLs();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].contractId, contractA);
  assert.equal(calls[0].method, "version");
  assert.equal(calls[0].args.length, 0);

  const tracking = db.getAllTTLTracking();

  assert.equal(tracking.length, 1);
  assert.equal(tracking[0].contractId, contractA);
  assert.equal(tracking[0].method, "version");
  assert.equal(tracking[0].urgency, "healthy");
  assert.ok(tracking[0].lastRenewedAt);

  const logs = db.getTTLCostLogs();

  assert.equal(logs.length, 1);
  assert.equal(logs[0].entriesRenewed, 1);
  assert.equal(logs[0].txCount, 1);
  assert.ok(Math.abs(logs[0].totalFeeXlm - 0.01) < 1e-9);
  assert.equal(logs[0].status, "completed");
});

test("TTL renewal records failed submissions", async (t) => {
  const database = createDatabase();
  t.after(() => restore(database));

  configure({
    votingContractId: contractA,
  });

  setTTLSubmitterForTests(async () => ({
    success: false,
    error: "simulated submit failure",
  }));

  await renewAllTTLs();

  assert.equal(db.getAllTTLTracking().length, 0);

  const logs = db.getTTLCostLogs();

  assert.equal(logs.length, 1);
  assert.equal(logs[0].entriesRenewed, 0);
  assert.equal(logs[0].txCount, 0);
  assert.equal(logs[0].status, "completed_with_errors");
});

test("TTL renewal processes multiple entries in batches", async (t) => {
  const database = createDatabase();
  t.after(() => restore(database));

  configure({
    votingContractId: contractA,
    treeContractId: contractB,
    commentsContractId: contractD,
    ttlBatchSize: 2,
  });

  const calls = [];

  setTTLSubmitterForTests(async (contractId, method) => {
    calls.push({ contractId, method });

    return {
      success: true,
      feeXlm: 0.005,
      txHash: `ttl_tx_${calls.length}`,
    };
  });

  await renewAllTTLs();

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["version", "version", "version"],
  );

  assert.equal(db.getAllTTLTracking().length, 3);

  const logs = db.getTTLCostLogs();

  assert.equal(logs.length, 1);
  assert.equal(logs[0].entriesRenewed, 3);
  assert.equal(logs[0].txCount, 3);
  assert.ok(Math.abs(logs[0].totalFeeXlm - 0.015) < 1e-9);
  assert.equal(logs[0].status, "completed");
});
