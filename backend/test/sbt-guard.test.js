/**
 * Coverage for services/sbt-guard.ts (issue #357): membership-SBT
 * transfer-attempt detection + admin alerting.
 *
 * The membership-sbt contract always panics on transfer/transfer_from/
 * approve, and Soroban rolls back every storage write *and* every event
 * published in a panicking invocation — so detection can't watch for a
 * committed on-chain event. Instead it inspects the *attempted* invocation
 * recorded in the transaction envelope, which is present regardless of
 * success/failure.
 *
 * The XDR-decoding half of this (extractInvokedFunctionNames/extractDaoId)
 * is fully testable offline: StellarSdk.TransactionBuilder can build a real,
 * unsigned transaction invoking any contract method and hand back its
 * envelope, with no network involved — so these tests build real envelopes
 * rather than hand-rolled fake XDR shapes.
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
process.env.SOROBAN_RPC_URL = "http://localhost";
process.env.NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

const { config } = await import("../src/config.js");
const {
  SBT_GUARDED_FUNCTIONS,
  extractInvokedFunctionNames,
  extractDaoId,
  isTransferAttempt,
  alertAdmin,
  recordTransferAttempt,
  processTransactionForTransferAttempts,
  checkForTransferAttempts,
  resetSbtWatchCursor,
} = await import("../src/services/sbt-guard.js");
const { getServiceHealth, resetServiceHealth } =
  await import("../src/services/service-health.js");
const db = await import("../src/services/db.js");

const sbtContractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 9));
const otherContractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 3));

/**
 * Build a real, unsigned transaction envelope invoking `method` on
 * `contractId` with the given native args. No network or signing required —
 * TransactionBuilder produces a fully-formed envelope offline.
 */
function buildEnvelope(contractId, method, nativeArgs = []) {
  const kp = StellarSdk.Keypair.random();
  const account = new StellarSdk.Account(kp.publicKey(), "0");
  const contract = new StellarSdk.Contract(contractId);
  const scArgs = nativeArgs.map(({ value, type }) =>
    StellarSdk.nativeToScVal(value, type ? { type } : undefined),
  );
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call(method, ...scArgs))
    .setTimeout(30)
    .build();
  return tx.toEnvelope();
}

test("SBT_GUARDED_FUNCTIONS matches the contract's soulbound stubs", () => {
  assert.deepEqual(
    [...SBT_GUARDED_FUNCTIONS].sort(),
    ["approve", "transfer", "transfer_from"].sort(),
  );
});

test("extractInvokedFunctionNames finds a guarded call on the SBT contract", () => {
  const envelope = buildEnvelope(sbtContractId, "transfer", [
    { value: 1, type: "u64" },
  ]);

  assert.deepEqual(extractInvokedFunctionNames(envelope, sbtContractId), [
    "transfer",
  ]);
});

test("extractInvokedFunctionNames ignores calls to a different contract", () => {
  const envelope = buildEnvelope(otherContractId, "transfer", [
    { value: 1, type: "u64" },
  ]);

  assert.deepEqual(extractInvokedFunctionNames(envelope, sbtContractId), []);
});

test("extractInvokedFunctionNames returns a non-guarded function name too", () => {
  const envelope = buildEnvelope(sbtContractId, "mint", [
    { value: 1, type: "u64" },
  ]);

  assert.deepEqual(extractInvokedFunctionNames(envelope, sbtContractId), [
    "mint",
  ]);
});

test("extractInvokedFunctionNames never throws on a malformed envelope", () => {
  const fakeEnvelope = {
    switch: () => ({ name: "envelopeTypeTxV0" }),
  };

  assert.deepEqual(
    extractInvokedFunctionNames(fakeEnvelope, sbtContractId),
    [],
  );
});

test("isTransferAttempt flags any guarded function name, ignores others", () => {
  assert.equal(isTransferAttempt(["transfer"]), true);
  assert.equal(isTransferAttempt(["transfer_from"]), true);
  assert.equal(isTransferAttempt(["approve"]), true);
  assert.equal(isTransferAttempt(["mint", "has", "version"]), false);
  assert.equal(isTransferAttempt([]), false);
});

test("extractDaoId reads dao_id from the first argument of a guarded call", () => {
  const envelope = buildEnvelope(sbtContractId, "transfer", [
    { value: 42, type: "u64" },
    { value: StellarSdk.Keypair.random().publicKey(), type: "address" },
    { value: StellarSdk.Keypair.random().publicKey(), type: "address" },
    { value: 1n, type: "i128" },
  ]);

  assert.equal(extractDaoId(envelope, sbtContractId), 42);
});

test("extractDaoId returns null for a non-guarded call", () => {
  const envelope = buildEnvelope(sbtContractId, "mint", [
    { value: 42, type: "u64" },
  ]);

  assert.equal(extractDaoId(envelope, sbtContractId), null);
});

test("extractDaoId returns null when args are empty", () => {
  const envelope = buildEnvelope(sbtContractId, "transfer", []);

  assert.equal(extractDaoId(envelope, sbtContractId), null);
});

// ── alertAdmin ───────────────────────────────────────────────────────────

test("alertAdmin logs only when no webhook is configured", async (t) => {
  const original = config.adminAlertWebhookUrl;
  config.adminAlertWebhookUrl = undefined;
  t.after(() => {
    config.adminAlertWebhookUrl = original;
  });

  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    return { ok: true };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await alertAdmin({ contractId: sbtContractId, functionNames: ["transfer"] });

  assert.equal(called, false);
});

test("alertAdmin posts to the configured webhook and marks the service healthy", async (t) => {
  const original = config.adminAlertWebhookUrl;
  config.adminAlertWebhookUrl = "https://example.test/alert";
  buildAppServices();
  t.after(() => {
    config.adminAlertWebhookUrl = original;
    resetServiceHealth();
  });

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await alertAdmin({ contractId: sbtContractId, functionNames: ["approve"] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/alert");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.event, "sbt_transfer_attempt");
  assert.equal(body.contractId, sbtContractId);
  assert.equal(getServiceHealth("sbt_transfer_watch").state, "healthy");
});

test("alertAdmin marks the service degraded when the webhook fails, and never throws", async (t) => {
  const original = config.adminAlertWebhookUrl;
  config.adminAlertWebhookUrl = "https://example.test/alert";
  buildAppServices();
  t.after(() => {
    config.adminAlertWebhookUrl = original;
    resetServiceHealth();
  });

  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("network unreachable");
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.doesNotReject(
    alertAdmin({ contractId: sbtContractId, functionNames: ["transfer"] }),
  );

  const entry = getServiceHealth("sbt_transfer_watch");
  assert.equal(entry.state, "degraded");
  assert.match(entry.lastError, /network unreachable/);
});

test("alertAdmin marks the service degraded on a non-2xx webhook response", async (t) => {
  const original = config.adminAlertWebhookUrl;
  config.adminAlertWebhookUrl = "https://example.test/alert";
  buildAppServices();
  t.after(() => {
    config.adminAlertWebhookUrl = original;
    resetServiceHealth();
  });

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500 });
  t.after(() => {
    global.fetch = originalFetch;
  });

  await alertAdmin({ contractId: sbtContractId, functionNames: ["transfer"] });

  assert.equal(getServiceHealth("sbt_transfer_watch").state, "degraded");
});

// ── recordTransferAttempt / processTransactionForTransferAttempts ────────

test("db-backed sbt-guard behavior", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zkvote-sbt-guard-"));
  const dbPath = path.join(tempDir, "sbt.db");
  db.initDb(dbPath);
  t.after(() => {
    db.closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
    resetServiceHealth();
  });

  await t.test("recordTransferAttempt persists a known-DAO attempt", () => {
    const stored = recordTransferAttempt(
      { functionNames: ["transfer"], daoId: 1 },
      "tx_known_dao",
      100,
      false,
    );

    assert.equal(stored, true);
    const { events } = db.getEventsForDao(1, {
      types: ["sbt_transfer_attempt"],
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].tx_hash, "tx_known_dao");
    assert.deepEqual(events[0].data.functionNames, ["transfer"]);
    assert.equal(events[0].data.successful, false);
  });

  await t.test(
    "recordTransferAttempt skips persistence when the DAO is unknown",
    () => {
      const stored = recordTransferAttempt(
        { functionNames: ["approve"], daoId: null },
        "tx_unknown_dao",
        101,
        false,
      );
      assert.equal(stored, false);
    },
  );

  await t.test(
    "recordTransferAttempt never throws on an out-of-range dao_id",
    () => {
      assert.doesNotThrow(() =>
        recordTransferAttempt(
          { functionNames: ["transfer"], daoId: 999999999 },
          "tx_bad_dao",
          102,
          false,
        ),
      );
    },
  );

  await t.test(
    "processTransactionForTransferAttempts flags, records, and alerts on a guarded call",
    async () => {
      const originalFetch = global.fetch;
      const alerts = [];
      global.fetch = async (_url, init) => {
        alerts.push(JSON.parse(init.body));
        return { ok: true };
      };
      config.adminAlertWebhookUrl = "https://example.test/alert";

      try {
        const envelope = buildEnvelope(sbtContractId, "transfer", [
          { value: 7, type: "u64" },
        ]);

        const flagged = await processTransactionForTransferAttempts(
          {
            envelopeXdr: envelope,
            txHash: "tx_flagged",
            ledger: 200,
            status: "FAILED",
          },
          sbtContractId,
        );

        assert.equal(flagged, true);
        assert.equal(alerts.length, 1);
        assert.equal(alerts[0].daoId, 7);
        assert.equal(alerts[0].successful, false);

        const { events } = db.getEventsForDao(7, {
          types: ["sbt_transfer_attempt"],
        });
        assert.equal(events.length, 1);
        assert.equal(events[0].tx_hash, "tx_flagged");
      } finally {
        global.fetch = originalFetch;
        config.adminAlertWebhookUrl = undefined;
      }
    },
  );

  await t.test(
    "processTransactionForTransferAttempts ignores an unrelated call and never alerts",
    async () => {
      const originalFetch = global.fetch;
      let called = false;
      global.fetch = async () => {
        called = true;
        return { ok: true };
      };
      config.adminAlertWebhookUrl = "https://example.test/alert";

      try {
        const envelope = buildEnvelope(sbtContractId, "mint", [
          { value: 7, type: "u64" },
        ]);

        const flagged = await processTransactionForTransferAttempts(
          {
            envelopeXdr: envelope,
            txHash: "tx_not_flagged",
            ledger: 201,
            status: "SUCCESS",
          },
          sbtContractId,
        );

        assert.equal(flagged, false);
        assert.equal(called, false);
      } finally {
        global.fetch = originalFetch;
        config.adminAlertWebhookUrl = undefined;
      }
    },
  );
});

// ── checkForTransferAttempts (poll loop) ──────────────────────────────────

test("checkForTransferAttempts is a no-op in test mode", async () => {
  resetSbtWatchCursor();
  const result = await checkForTransferAttempts();
  assert.deepEqual(result, { checked: 0, flagged: 0 });
});

test("checkForTransferAttempts is a no-op without a configured SBT contract", async (t) => {
  const original = config.membershipSbtContractId;
  const originalTestMode = config.testMode;
  config.membershipSbtContractId = undefined;
  config.testMode = false;
  t.after(() => {
    config.membershipSbtContractId = original;
    config.testMode = originalTestMode;
  });

  resetSbtWatchCursor();
  const result = await checkForTransferAttempts();
  assert.deepEqual(result, { checked: 0, flagged: 0 });
});
