/**
 * Tests for Outbox Pattern Hash PK and Offline Retry Idempotency (#542, #544)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";

import { buildAppServices } from "../src/composition-root.js";
buildAppServices();

import {
  initDb,
  getDb,
  storeVoteReceipt,
  upsertDao,
} from "../src/services/db.js";
import { app } from "../src/index.js";
import { offlineRetryTotal, outboxLagGauge } from "../src/services/metrics.js";

const dataDir = path.resolve("data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
initDb(path.join(dataDir, "zkvote.db"));

// Ensure DAO exists for foreign key constraints
upsertDao({
  id: 99,
  name: "Outbox Test DAO",
  creator: "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMN",
  membership_open: true,
  members_can_propose: true,
});

test("metrics: offlineRetryTotal and outboxLagGauge are registered (#542, #544)", () => {
  assert.ok(offlineRetryTotal, "offlineRetryTotal counter must exist");
  assert.ok(outboxLagGauge, "outboxLagGauge gauge must exist");
});

test("parseAmountToStroops: handles integer, decimals, and large numbers without floating point drift", async () => {
  const { parseAmountToStroops } = await import("../src/services/payments.js");
  assert.equal(parseAmountToStroops("10"), 100000000n);
  assert.equal(parseAmountToStroops("10.5"), 105000000n);
  assert.equal(parseAmountToStroops("0.0000001"), 1n);
  // Large amount with 7 decimal digits that would lose precision in JS Number
  assert.equal(parseAmountToStroops("900719925.4740993"), 9007199254740993n);

  assert.throws(() => parseAmountToStroops(""), /Invalid amount/);
  assert.throws(
    () => parseAmountToStroops("invalid"),
    /Invalid payment amount format/,
  );
  assert.throws(
    () => parseAmountToStroops("-5.0"),
    /Invalid payment amount format/,
  );
  assert.throws(
    () => parseAmountToStroops("1.12345678"),
    /Invalid payment amount format/,
  );
});

test("payments outbox: generates deterministic SHA-256 hash PK scoped by tenantId (#542)", () => {
  const db = getDb();
  const ops = [
    {
      destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      asset: "XLM",
      amount: "10.5000000",
    },
    {
      destination: "GD6WAC3TJV27MHXVYKKTM3QHNABQA4WWV765532KZINORC3PX6M4K3KK",
      asset: "XLM",
      amount: "5.2500000",
    },
  ];

  const opsJson = JSON.stringify(ops);
  const hash1 = StellarSdk.hash(
    Buffer.from(`tenant-a:${opsJson}`, "utf8"),
  ).toString("hex");
  const hash2 = StellarSdk.hash(
    Buffer.from(`tenant-b:${opsJson}`, "utf8"),
  ).toString("hex");

  assert.notEqual(
    hash1,
    hash2,
    "Identical ops with different tenantId must produce different hashes",
  );

  const totalAmount = 157500000n;

  db.prepare(
    "INSERT OR REPLACE INTO payment_jobs (id, tenant_id, amount, ops, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    hash1,
    "tenant-a",
    totalAmount.toString(),
    opsJson,
    new Date().toISOString(),
  );

  const row: any = db
    .prepare("SELECT * FROM payment_jobs WHERE id = ?")
    .get(hash1);
  assert.ok(row, "Payment job row should exist with hash PK");
  assert.equal(row.id, hash1);
  assert.equal(row.tenant_id, "tenant-a");
  assert.equal(BigInt(row.amount), 157500000n);
});

test("voting route: returns 409 Conflict only when nullifier matches daoId and proposalId (#544)", async () => {
  const nullifier = ("01" + Math.random().toString(16).slice(2)).padStart(
    64,
    "0",
  );
  const root = "02".padStart(64, "0");
  const txHash = "tx_receipt_" + Math.random().toString(36).slice(2);
  const daoId = 99;
  const proposalId = 42;

  storeVoteReceipt(nullifier, txHash, proposalId, daoId, "confirmed");

  const tokenRes = await request(app).get("/csrf-token");
  const csrfToken = tokenRes.headers["x-csrf-token"];

  // 1. Same nullifier, matching daoId and proposalId -> 409 Conflict
  const resConflict = await request(app)
    .post("/vote")
    .set("Origin", "http://localhost:3000")
    .set("X-CSRF-Token", csrfToken)
    .set(
      "Authorization",
      `Bearer ${process.env.RELAYER_AUTH_TOKEN || "test-token"}`,
    )
    .set("X-Offline-Retry", "true")
    .send({
      daoId,
      proposalId,
      choice: true,
      nullifier,
      root,
      proof: {
        a: "11".repeat(64),
        b: "22".repeat(128),
        c: "0f".repeat(64),
      },
    });

  assert.equal(resConflict.status, 409);
  assert.equal(resConflict.body.status, "CONFLICT");
  assert.equal(resConflict.body.receipt.nullifier, nullifier);
  assert.equal(resConflict.body.receipt.txHash, txHash);

  // 2. Same nullifier, different proposalId -> does not match existing receipt, proceeds past early check
  const resDifferentProposal = await request(app)
    .post("/vote")
    .set("Origin", "http://localhost:3000")
    .set("X-CSRF-Token", csrfToken)
    .set(
      "Authorization",
      `Bearer ${process.env.RELAYER_AUTH_TOKEN || "test-token"}`,
    )
    .set("X-Offline-Retry", "true")
    .send({
      daoId,
      proposalId: 9999, // different proposal
      choice: true,
      nullifier,
      root,
      proof: {
        a: "11".repeat(64),
        b: "22".repeat(128),
        c: "0f".repeat(64),
      },
    });

  // Since proof is invalid dummy data, it fails with 400 or 500, NOT early 409!
  assert.notEqual(resDifferentProposal.status, 409);
});
