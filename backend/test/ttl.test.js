import test from "node:test";

// Wire refactored services for tests: since #358 services receive their
// dependencies via init*() instead of importing module globals, tests must
// perform the same wiring the production composition root does at boot.
import { buildAppServices } from "../src/composition-root.js";
buildAppServices();

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dataDir = path.resolve("data");
const DEFAULT_DB = path.join(dataDir, "zkvote.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

async function resetDb() {
  try {
    const { closeDb } = await import("../src/services/db.js");
    closeDb();
  } catch {}
  try { fs.unlinkSync(DEFAULT_DB); } catch {}
}

test("TTL tracking: upsert and retrieve entry", async () => {
  await resetDb();
  const { initDb, closeDb, upsertTTLTracking, getTTLTracking } = await import("../src/services/db.js");
  initDb();

  upsertTTLTracking({
    entryId: "test_entry_1",
    contractId: "CAYKXPSPHEDELSDI3PN5I2QVZSQQ7FACWRJOJYQMYIHXRXLX37CFGAVQ",
    daoId: 1,
    method: "get_dao",
    lastRenewedAt: new Date().toISOString(),
    remainingLedgers: 30000,
    urgency: "healthy",
  });

  const retrieved = getTTLTracking("test_entry_1");
  assert.ok(retrieved);
  assert.equal(retrieved.entryId, "test_entry_1");
  assert.equal(retrieved.daoId, 1);
  assert.equal(retrieved.urgency, "healthy");
  assert.equal(retrieved.remainingLedgers, 30000);

  closeDb();
});

test("TTL tracking: upsert overwrites existing entry", async () => {
  await resetDb();
  const { initDb, closeDb, upsertTTLTracking, getTTLTracking } = await import("../src/services/db.js");
  initDb();

  upsertTTLTracking({
    entryId: "dup_entry",
    contractId: "CAYKXPSPHEDELSDI3PN5I2QVZSQQ7FACWRJOJYQMYIHXRXLX37CFGAVQ",
    daoId: null,
    method: "version",
    lastRenewedAt: "2024-01-01T00:00:00.000Z",
    remainingLedgers: 10000,
    urgency: "warning",
  });

  upsertTTLTracking({
    entryId: "dup_entry",
    contractId: "CAYKXPSPHEDELSDI3PN5I2QVZSQQ7FACWRJOJYQMYIHXRXLX37CFGAVQ",
    daoId: null,
    method: "version",
    lastRenewedAt: "2024-06-01T00:00:00.000Z",
    remainingLedgers: 40000,
    urgency: "healthy",
  });

  const retrieved = getTTLTracking("dup_entry");
  assert.equal(retrieved.remainingLedgers, 40000);
  assert.equal(retrieved.urgency, "healthy");
  assert.equal(retrieved.lastRenewedAt, "2024-06-01T00:00:00.000Z");

  closeDb();
});

test("TTL tracking: getAll sorts by remaining ledgers ascending", async () => {
  await resetDb();
  const { initDb, closeDb, upsertTTLTracking, getAllTTLTracking } = await import("../src/services/db.js");
  initDb();

  upsertTTLTracking({ entryId: "a", contractId: "C1", daoId: null, method: null, lastRenewedAt: null, remainingLedgers: 50000, urgency: "healthy" });
  upsertTTLTracking({ entryId: "b", contractId: "C2", daoId: null, method: null, lastRenewedAt: null, remainingLedgers: 2000, urgency: "grace" });
  upsertTTLTracking({ entryId: "c", contractId: "C3", daoId: null, method: null, lastRenewedAt: null, remainingLedgers: 10000, urgency: "warning" });

  const all = getAllTTLTracking();
  assert.equal(all.length, 3);
  assert.equal(all[0].entryId, "b");
  assert.equal(all[1].entryId, "c");
  assert.equal(all[2].entryId, "a");

  closeDb();
});

test("TTL tracking: getGracePeriodEntries returns only grace entries", async () => {
  await resetDb();
  const { initDb, closeDb, upsertTTLTracking, getGracePeriodEntries } = await import("../src/services/db.js");
  initDb();

  upsertTTLTracking({ entryId: "g1", contractId: "C1", daoId: null, method: null, lastRenewedAt: null, remainingLedgers: 500, urgency: "grace" });
  upsertTTLTracking({ entryId: "w1", contractId: "C2", daoId: null, method: null, lastRenewedAt: null, remainingLedgers: 5000, urgency: "warning" });
  upsertTTLTracking({ entryId: "h1", contractId: "C3", daoId: null, method: null, lastRenewedAt: null, remainingLedgers: 50000, urgency: "healthy" });
  upsertTTLTracking({ entryId: "g2", contractId: "C4", daoId: null, method: null, lastRenewedAt: null, remainingLedgers: 100, urgency: "grace" });

  const grace = getGracePeriodEntries();
  assert.equal(grace.length, 2);
  assert.ok(grace.every((e) => e.urgency === "grace"));
  assert.equal(grace[0].entryId, "g2");
  assert.equal(grace[1].entryId, "g1");

  closeDb();
});

test("TTL cost log: create, update, and query", async () => {
  await resetDb();
  const { initDb, closeDb, createTTLCostLog, updateTTLCostLog, getTTLCostLogs, getTotalTTLCostXLM } = await import("../src/services/db.js");
  initDb();

  const id = createTTLCostLog("cycle_1", "2024-01-01T00:00:00.000Z");
  assert.ok(id > 0);

  updateTTLCostLog(id, {
    cycleEnd: "2024-01-01T00:01:00.000Z",
    entriesRenewed: 10,
    entriesSkipped: 5,
    txCount: 3,
    totalFeeXlm: 0.015,
    status: "completed",
  });

  const logs = getTTLCostLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].cycleId, "cycle_1");
  assert.equal(logs[0].entriesRenewed, 10);
  assert.equal(logs[0].totalFeeXlm, 0.015);
  assert.equal(logs[0].status, "completed");

  const total = getTotalTTLCostXLM();
  assert.equal(total, 0.015);

  closeDb();
});

test("TTL cost log: multiple cycles accumulate total cost", async () => {
  await resetDb();
  const { initDb, closeDb, createTTLCostLog, updateTTLCostLog, getTotalTTLCostXLM } = await import("../src/services/db.js");
  initDb();

  const id1 = createTTLCostLog("c1", "2024-01-01T00:00:00.000Z");
  updateTTLCostLog(id1, { totalFeeXlm: 0.01, status: "completed" });

  const id2 = createTTLCostLog("c2", "2024-01-02T00:00:00.000Z");
  updateTTLCostLog(id2, { totalFeeXlm: 0.02, status: "completed" });

  assert.equal(getTotalTTLCostXLM(), 0.03);

  closeDb();
});

test("TTL urgency categorization", async () => {
  const { estimateRemainingFromTracked } = await import("../src/services/ttl-checker.js");

  const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400 * 1000).toISOString();
  const twentyDaysAgo = new Date(Date.now() - 20 * 86400 * 1000).toISOString();

  const result1 = estimateRemainingFromTracked({
    entryId: "e1", contractId: "C1", daoId: null, method: "version",
    lastRenewedAt: threeHoursAgo, remainingLedgers: null, urgency: "unknown",
  });
  assert.ok(result1);
  assert.equal(result1.urgency, "healthy");
  assert.ok(result1.remainingMs > 0);

  const result2 = estimateRemainingFromTracked({
    entryId: "e2", contractId: "C1", daoId: null, method: "version",
    lastRenewedAt: fiveDaysAgo, remainingLedgers: null, urgency: "unknown",
  });
  assert.ok(result2);
  assert.equal(result2.urgency, "healthy");
  assert.ok(result2.remainingMs > 0);

  const result3 = estimateRemainingFromTracked({
    entryId: "e3", contractId: "C1", daoId: null, method: "version",
    lastRenewedAt: twentyDaysAgo, remainingLedgers: null, urgency: "unknown",
  });
  assert.ok(result3);
  assert.equal(result3.urgency, "warning");
  assert.ok(result3.remainingMs > 0);

  const veryOld = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
  const result4 = estimateRemainingFromTracked({
    entryId: "e4", contractId: "C1", daoId: null, method: "version",
    lastRenewedAt: veryOld, remainingLedgers: null, urgency: "unknown",
  });
  assert.equal(result4, null, "Should return null for expired entry");
});

test("needsRenewal and isInGracePeriod", async () => {
  const m = await import("../src/services/ttl-checker.js");

  const dayInMs = 86400000;
  const baseInfo = {
    entryId: "test", contractId: "C1", daoId: null, method: null,
    remainingLedgers: 0, tracked: false,
  };

  assert.equal(m.needsRenewal({ ...baseInfo, remainingMs: 20 * dayInMs }), false);
  assert.equal(m.needsRenewal({ ...baseInfo, remainingMs: 10 * dayInMs }), true);
  assert.equal(m.needsRenewal({ ...baseInfo, remainingMs: 2 * dayInMs }), true);

  assert.equal(m.isInGracePeriod({ ...baseInfo, remainingMs: 4 * dayInMs, urgency: "warning" }), false);
  assert.equal(m.isInGracePeriod({ ...baseInfo, remainingMs: 2 * dayInMs, urgency: "grace" }), true);
});

test("formatRemaining displays correctly", async () => {
  const { formatRemaining } = await import("../src/services/ttl-checker.js");

  const info = {
    entryId: "test", contractId: "C1", daoId: null, method: null,
    remainingMs: 5 * 86400000 + 3 * 3600000,
    remainingLedgers: 0, urgency: "healthy", tracked: false,
  };

  assert.equal(formatRemaining(info), "5d 3h");
});

test("start/stop TTL renewal service", async () => {
  const { startTTLRenewal, stopTTLRenewal } = await import("../src/services/ttl.js");

  // In test mode, startTTLRenewal should return early without setting timer
  startTTLRenewal(1000);
  stopTTLRenewal();

  assert.ok(true, "start/stop should not throw in test mode");
});

test("TTL service: renewAllTTLs handles empty DAOs gracefully", async () => {
  await resetDb();
  const { initDb, closeDb } = await import("../src/services/db.js");
  initDb();

  // Should not throw
  const { renewAllTTLs } = await import("../src/services/ttl.js");
  await renewAllTTLs();

  closeDb();
});
