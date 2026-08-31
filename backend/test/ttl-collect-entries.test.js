/**
 * Coverage for src/services/ttl.ts's collectEntries()/renewAllTTLs() when
 * `config.ttlCheckEnabled` is true (issue #367). The existing
 * ttl-service.test.js suite always sets `ttlCheckEnabled: false` to isolate
 * batching/cost-log behavior, so the TTL-check branches themselves — the
 * per-contract grace/warning/healthy classification, the healthy-skip
 * `continue`, the per-DAO method loop, and the grace-first batch ordering —
 * were never exercised.
 *
 * `config.testMode` stays true throughout (as in the rest of the suite), so
 * `hasActiveProposals()` and `queryContractInstanceTTL()` take their
 * test-mode short-circuits; only the TTL-tracking-driven classification in
 * `queryInstanceTTLWithFallback`/`queryPersistentTTLWithFallback` is under
 * test here. The real-RPC bodies of `hasActiveProposals` and `submitCall`
 * are intentionally left to the RPC-mocked tests in
 * ttl-checker-onchain.test.js and to the injectable `ttlSubmitter` boundary
 * that the rest of the suite already exercises.
 */

import test from "node:test";
import assert from "node:assert/strict";

// Wire refactored services for tests: since #358 services receive their
// dependencies via init*() instead of importing module globals, tests must
// perform the same wiring the production composition root does at boot.
import { buildAppServices } from "../src/composition-root.js";
buildAppServices();

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RELAYER_TEST_MODE = "true";
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test";

const { config } = await import("../src/config.js");
const { renewAllTTLs, setTTLSubmitterForTests } =
  await import("../src/services/ttl.js");
const db = await import("../src/services/db.js");

const votingContractId = "C".padEnd(56, "A");
const treeContractId = "C".padEnd(56, "B");
const commentsContractId = "C".padEnd(56, "D");
const daoRegistryContractId = "C".padEnd(56, "E");

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

// Mirrors the private buildEntryId() in src/services/ttl.ts so seeded TTL
// tracking rows line up with the entries collectEntries() looks up.
function entryId(contractId, method, daoId) {
  const parts = [contractId.slice(0, 16)];
  if (daoId !== undefined) parts.push(`dao${daoId}`);
  parts.push(method);
  return parts.join("_");
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function seedTracking(contractId, method, daysAgo, daoId) {
  db.upsertTTLTracking({
    entryId: entryId(contractId, method, daoId),
    contractId,
    daoId: daoId ?? null,
    method,
    lastRenewedAt: isoDaysAgo(daysAgo),
    remainingLedgers: null,
    urgency: "unknown",
  });
}

function createDatabase() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "zkvote-ttl-collect-"),
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

test("instance-level entries are classified grace / needs-renewal / healthy-skip", async (t) => {
  const database = createDatabase();
  t.after(() => restore(database));

  Object.assign(config, {
    votingContractId,
    treeContractId,
    commentsContractId,
    daoRegistryContractId: undefined,
    membershipSbtContractId: undefined,
    ttlCheckEnabled: true,
    ttlCostTrackingEnabled: true,
    ttlBatchSize: 5,
  });

  buildAppServices();

  // voting: renewed 29 days ago -> within the 3-day grace period.
  seedTracking(votingContractId, "version", 29);
  // tree: renewed 20 days ago -> "warning", past the 14-day threshold.
  seedTracking(treeContractId, "version", 20);
  // comments: renewed 1 hour ago -> healthy, well under the threshold.
  seedTracking(commentsContractId, "version", 1 / 24);

  const calls = [];
  setTTLSubmitterForTests(async (contractId, method) => {
    calls.push({ contractId, method });
    return { success: true, feeXlm: 0.001, txHash: `tx_${calls.length}` };
  });

  await renewAllTTLs();

  const renewedContracts = calls.map((c) => c.contractId);
  assert.ok(renewedContracts.includes(votingContractId), "grace entry renewed");
  assert.ok(renewedContracts.includes(treeContractId), "warning entry renewed");
  assert.ok(
    !renewedContracts.includes(commentsContractId),
    "healthy entry skipped",
  );

  // Grace entries sort ahead of plain needs-renewal entries within a batch.
  assert.equal(calls[0].contractId, votingContractId);

  const logs = db.getTTLCostLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].entriesRenewed, 2);
  assert.equal(logs[0].status, "completed");
});

test("per-DAO entries follow the same grace/warning/healthy classification", async (t) => {
  const database = createDatabase();
  t.after(() => restore(database));

  Object.assign(config, {
    votingContractId,
    treeContractId,
    commentsContractId: undefined,
    daoRegistryContractId,
    membershipSbtContractId: undefined,
    ttlCheckEnabled: true,
    ttlCostTrackingEnabled: true,
    ttlBatchSize: 5,
  });

  buildAppServices();

  db.upsertDaos([
    {
      id: 1,
      name: "Test DAO",
      creator: "GABCDEF",
      membership_open: true,
      members_can_propose: true,
      metadata_cid: null,
      member_count: 1,
    },
  ]);

  // dao_registry.get_dao: grace (29 days).
  seedTracking(daoRegistryContractId, "get_dao", 29, 1);
  // tree.current_root: warning (20 days) -> renewed.
  seedTracking(treeContractId, "current_root", 20, 1);
  // voting.proposal_count: healthy (1 hour) -> skipped.
  seedTracking(votingContractId, "proposal_count", 1 / 24, 1);

  // Instance-level entries for the same three contracts, all freshly
  // "renewed" so only the per-DAO rows drive this test's assertions.
  seedTracking(votingContractId, "version", 1 / 24);
  seedTracking(treeContractId, "version", 1 / 24);
  seedTracking(daoRegistryContractId, "version", 1 / 24);

  const calls = [];
  setTTLSubmitterForTests(async (contractId, method, args) => {
    calls.push({ contractId, method, args });
    return { success: true, feeXlm: 0.001, txHash: `tx_${calls.length}` };
  });

  await renewAllTTLs();

  const daoCalls = calls.filter((c) => c.args.length > 0);
  const daoMethods = daoCalls.map((c) => c.method);

  assert.ok(daoMethods.includes("get_dao"), "grace DAO entry renewed");
  assert.ok(daoMethods.includes("current_root"), "warning DAO entry renewed");
  assert.ok(
    !daoMethods.includes("proposal_count"),
    "healthy DAO entry skipped",
  );

  const tracking = db.getAllTTLTracking();
  const daoTracking = tracking.filter((row) => row.daoId === 1);
  assert.ok(daoTracking.some((row) => row.method === "get_dao"));
  assert.ok(daoTracking.some((row) => row.method === "current_root"));
});

test("an untracked contract with no history defaults to healthy and is skipped", async (t) => {
  const database = createDatabase();
  t.after(() => restore(database));

  Object.assign(config, {
    votingContractId: undefined,
    treeContractId: undefined,
    commentsContractId: undefined,
    daoRegistryContractId,
    membershipSbtContractId: undefined,
    ttlCheckEnabled: true,
    ttlCostTrackingEnabled: true,
    ttlBatchSize: 5,
  });

  buildAppServices();

  let submitCalls = 0;
  setTTLSubmitterForTests(async () => {
    submitCalls++;
    return { success: true };
  });

  await renewAllTTLs();

  assert.equal(submitCalls, 0);
  assert.equal(db.getAllTTLTracking().length, 0);
});
