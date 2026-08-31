/**
 * Coverage for the on-chain branch of src/services/ttl-checker.ts (issue
 * #367). queryContractInstanceTTL() short-circuits to `null` whenever
 * `config.testMode` is true (the default for the rest of the suite), so its
 * RPC-backed body — decode the contract ID, read the ledger entry, derive
 * remaining ledgers, and the catch-all fallback on a thrown/malformed
 * response — was never actually executed.
 *
 * `server` (src/services/stellar.ts) is bound once at import time to a
 * plain, mutable stub object when RELAYER_TEST_MODE=true, so it is safe to
 * monkey-patch `server.getLedgerEntries` per test; toggling
 * `config.testMode` to false for the duration of a test is enough to reach
 * the real code path without touching the network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as StellarSdk from "@stellar/stellar-sdk";

// Wire refactored services for tests: since #358 services receive their
// dependencies via init*() instead of importing module globals, tests must
// perform the same wiring the production composition root does at boot.
import { buildAppServices } from "../src/composition-root.js";
buildAppServices();

process.env.RELAYER_TEST_MODE = "true";
process.env.VOTING_CONTRACT_ID = "C".padEnd(56, "A");
process.env.TREE_CONTRACT_ID = "C".padEnd(56, "B");
process.env.COMMENTS_CONTRACT_ID = "C".padEnd(56, "D");
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test";

const { config } = await import("../src/config.js");
const { server } = await import("../src/services/stellar.js");
const { queryContractInstanceTTL, queryInstanceTTLWithFallback } =
  await import("../src/services/ttl-checker.js");
const db = await import("../src/services/db.js");

const contractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 7));

function withRealRpc(getLedgerEntries) {
  const originalTestMode = config.testMode;
  const originalMethod = server.getLedgerEntries;
  config.testMode = false;
  buildAppServices();
  server.getLedgerEntries = getLedgerEntries;
  return () => {
    config.testMode = originalTestMode;
    server.getLedgerEntries = originalMethod;
  };
}

test("queryContractInstanceTTL returns remaining ledgers from a live entry", async () => {
  const restore = withRealRpc(async () => ({
    entries: [{ liveUntilLedgerSeq: 1000 }],
    latestLedger: 400,
  }));
  try {
    const result = await queryContractInstanceTTL(contractId);
    assert.deepEqual(result, {
      remainingLedgers: 600,
      liveUntilLedger: 1000,
      latestLedger: 400,
    });
  } finally {
    restore();
  }
});

test("queryContractInstanceTTL clamps remaining ledgers to zero when already expired", async () => {
  const restore = withRealRpc(async () => ({
    entries: [{ liveUntilLedgerSeq: 100 }],
    latestLedger: 400,
  }));
  try {
    const result = await queryContractInstanceTTL(contractId);
    assert.equal(result.remainingLedgers, 0);
  } finally {
    restore();
  }
});

test("queryContractInstanceTTL returns null when the ledger has no entries", async () => {
  const restore = withRealRpc(async () => ({ entries: [], latestLedger: 400 }));
  try {
    assert.equal(await queryContractInstanceTTL(contractId), null);
  } finally {
    restore();
  }
});

test("queryContractInstanceTTL returns null when liveUntilLedgerSeq is missing", async () => {
  const restore = withRealRpc(async () => ({
    entries: [{}],
    latestLedger: 400,
  }));
  try {
    assert.equal(await queryContractInstanceTTL(contractId), null);
  } finally {
    restore();
  }
});

test("queryContractInstanceTTL swallows RPC errors and returns null", async () => {
  const restore = withRealRpc(async () => {
    throw new Error("simulated RPC timeout");
  });
  try {
    assert.equal(await queryContractInstanceTTL(contractId), null);
  } finally {
    restore();
  }
});

test("queryContractInstanceTTL returns null for a malformed contract ID", async () => {
  const restore = withRealRpc(async () => {
    throw new Error("should not be reached");
  });
  try {
    assert.equal(await queryContractInstanceTTL("not-a-contract-id"), null);
  } finally {
    restore();
  }
});

test("queryInstanceTTLWithFallback persists a fresh on-chain reading", async (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "zkvote-ttl-checker-onchain-"),
  );
  const dbPath = path.join(tempDir, "ttl.db");
  db.initDb(dbPath);
  t.after(() => {
    db.closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const restore = withRealRpc(async () => ({
    entries: [{ liveUntilLedgerSeq: 600000 }],
    latestLedger: 100,
  }));
  try {
    const entryId = "onchain_entry";
    const info = await queryInstanceTTLWithFallback(contractId, entryId);

    assert.equal(info.tracked, false);
    assert.equal(info.remainingLedgers, 599900);
    assert.equal(info.urgency, "healthy");

    const persisted = db.getTTLTracking(entryId);
    assert.ok(persisted);
    assert.equal(persisted.contractId, contractId);
    assert.equal(persisted.remainingLedgers, 599900);
  } finally {
    restore();
  }
});
