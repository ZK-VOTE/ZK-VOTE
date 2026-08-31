import test from "node:test";
import assert from "node:assert/strict";
import {
  storeVoteReceipt,
  getVoteReceipt,
  getVoteReceiptsByDao,
  upsertDao,
} from "../src/services/db.js";

// vote_receipts.dao_id references daos(id); seed the DAOs these tests insert
// against so the FK constraint holds regardless of shared database state.
for (const id of [1, 2, 42, 43]) {
  upsertDao({
    id,
    name: `test-dao-${id}`,
    creator: "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMN",
    membership_open: true,
    members_can_propose: true,
  });
}

test("vote-receipt: stores and retrieves vote receipt", () => {
  const testNullifier = `test-nullifier-${Date.now()}`;
  const testTxHash = "hash-" + Math.random().toString(36);
  const proposalId = 123;
  const daoId = 1;

  ensureDao(daoId);
  storeVoteReceipt(testNullifier, testTxHash, proposalId, daoId, "confirmed");

  const receipt = getVoteReceipt(testNullifier);

  assert.ok(receipt, "Receipt should be stored and retrievable");
  assert.equal(receipt.nullifier, testNullifier);
  assert.equal(receipt.tx_hash, testTxHash);
  assert.equal(receipt.proposal_id, proposalId);
  assert.equal(receipt.dao_id, daoId);
  assert.equal(receipt.status, "confirmed");
  assert.ok(receipt.created_at, "Should have created_at timestamp");
});

test("vote-receipt: returns null for non-existent receipt", () => {
  const receipt = getVoteReceipt("non-existent-" + Date.now());
  assert.equal(receipt, null);
});

test("vote-receipt: handles duplicate nullifier idempotently", () => {
  const testNullifier = `dup-nullifier-${Date.now()}`;
  const testTxHash1 = "hash-" + Math.random().toString(36);
  const testTxHash2 = "hash-" + Math.random().toString(36);

  ensureDao(1);
  ensureDao(2);
  storeVoteReceipt(testNullifier, testTxHash1, 123, 1, "confirmed");
  storeVoteReceipt(testNullifier, testTxHash2, 456, 2, "confirmed");

  const receipt = getVoteReceipt(testNullifier);

  assert.ok(receipt, "First receipt should be stored");
  assert.equal(
    receipt.tx_hash,
    testTxHash1,
    "Should keep original tx_hash on duplicate",
  );
});

test("vote-receipt: stores receipt with pending status", () => {
  const testNullifier = `pending-${Date.now()}`;
  const testTxHash = "hash-" + Math.random().toString(36);

  ensureDao(1);
  storeVoteReceipt(testNullifier, testTxHash, 789, 1, "pending");

  const receipt = getVoteReceipt(testNullifier);

  assert.ok(receipt);
  assert.equal(receipt.status, "pending");
});

test("vote-receipt: stores receipt with failed status", () => {
  const testNullifier = `failed-${Date.now()}`;
  const testTxHash = "hash-" + Math.random().toString(36);

  ensureDao(1);
  storeVoteReceipt(testNullifier, testTxHash, 999, 1, "failed");

  const receipt = getVoteReceipt(testNullifier);

  assert.ok(receipt);
  assert.equal(receipt.status, "failed");
});

test("vote-receipt: retrieves receipts by DAO", () => {
  const daoId = 42;
  const nullifier1 = `dao-receipt-1-${Date.now()}`;
  const nullifier2 = `dao-receipt-2-${Date.now()}`;

  ensureDao(daoId);
  storeVoteReceipt(nullifier1, "hash-1", 100, daoId, "confirmed");
  storeVoteReceipt(nullifier2, "hash-2", 101, daoId, "confirmed");

  const receipts = getVoteReceiptsByDao(daoId, 100, 0);

  assert.equal(
    receipts.length >= 2,
    true,
    "Should retrieve at least the two receipts stored",
  );
  assert.ok(
    receipts.some((r) => r.nullifier === nullifier1),
    "Should include first receipt",
  );
  assert.ok(
    receipts.some((r) => r.nullifier === nullifier2),
    "Should include second receipt",
  );
});

test("vote-receipt: respects limit and offset", () => {
  const daoId = 43;
  const nullifiers = Array.from({ length: 5 }, (_, i) =>
    `offset-test-${i}-${Date.now()}`.slice(0, 50),
  );

  ensureDao(daoId);
  nullifiers.forEach((n, i) => {
    storeVoteReceipt(n, `hash-${i}`, 200 + i, daoId, "confirmed");
  });

  const page1 = getVoteReceiptsByDao(daoId, 2, 0);
  const page2 = getVoteReceiptsByDao(daoId, 2, 2);

  assert.equal(page1.length <= 2, true, "First page should respect limit");
  assert.equal(page2.length <= 2, true, "Second page should respect limit");
});
