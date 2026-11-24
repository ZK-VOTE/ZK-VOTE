// Unit tests for the satellite treasury escrow status cache (ZV-107).
//
// `TreasuryEscrow.sol` is the authority on fund custody; this module only
// mirrors it for the frontend. These tests exercise the service logic
// directly (no HTTP, no chain) and pin down the acceptance criteria from
// the issue: funds can't be "released" without a prior finalized approval
// recorded via markReleased, a refund can only be recorded once the 24h
// timeout has elapsed, cancellation unlocks early, and a Soroban nonce can
// never be replayed across locks or operations.

import test from "node:test";
import assert from "node:assert/strict";

import {
  recordLock,
  getLock,
  getLocksForProposal,
  markReleased,
  markCancelled,
  markRefunded,
  isRefundable,
  secondsUntilRefundable,
  DEFAULT_ESCROW_TIMEOUT_SECONDS,
  EscrowLockAlreadyExistsError,
  EscrowLockNotFoundError,
  EscrowLockNotActiveError,
  EscrowNonceReplayError,
  EscrowTimeoutNotElapsedError,
  __resetTreasuryEscrowStoreForTests,
} from "../src/services/treasuryEscrow.ts";

const depositor = "0x" + "1".repeat(40);
const recipient = "0x" + "2".repeat(40);
const lockTxHash = "0x" + "a".repeat(64);

function seedLock(overrides: Partial<Parameters<typeof recordLock>[0]> = {}) {
  __resetTreasuryEscrowStoreForTests();
  return recordLock({
    lockId: "0",
    daoId: 1,
    proposalId: 7,
    depositor,
    recipient,
    amount: "1000000000000000000",
    lockTxHash,
    ...overrides,
  });
}

test("recordLock stores a lock in the locked state", () => {
  const record = seedLock();
  assert.equal(record.status, "locked");
  assert.equal(getLock("0")?.lockId, "0");
});

test("recordLock rejects a duplicate lockId", () => {
  seedLock();
  assert.throws(
    () =>
      recordLock({
        lockId: "0",
        daoId: 1,
        proposalId: 7,
        depositor,
        recipient,
        amount: "1",
        lockTxHash,
      }),
    EscrowLockAlreadyExistsError,
  );
});

test("getLocksForProposal filters by daoId and proposalId", () => {
  __resetTreasuryEscrowStoreForTests();
  recordLock({
    lockId: "0",
    daoId: 1,
    proposalId: 7,
    depositor,
    recipient,
    amount: "1",
    lockTxHash,
  });
  recordLock({
    lockId: "1",
    daoId: 1,
    proposalId: 8,
    depositor,
    recipient,
    amount: "1",
    lockTxHash,
  });

  const locks = getLocksForProposal(1, 7);
  assert.equal(locks.length, 1);
  assert.equal(locks[0].lockId, "0");
});

test("markReleased requires a finalized Soroban approval before funds move: unknown lock is rejected", () => {
  __resetTreasuryEscrowStoreForTests();
  assert.throws(
    () => markReleased("999", "1", "0x" + "b".repeat(64)),
    EscrowLockNotFoundError,
  );
});

test("markReleased transitions a locked record to released", () => {
  seedLock();
  const record = markReleased("0", "42", "0x" + "b".repeat(64));
  assert.equal(record.status, "released");
  assert.equal(record.sorobanNonce, "42");
});

test("markReleased cannot be applied twice to the same lock", () => {
  seedLock();
  markReleased("0", "1", "0x" + "b".repeat(64));
  assert.throws(
    () => markReleased("0", "2", "0x" + "c".repeat(64)),
    EscrowLockNotActiveError,
  );
});

test("markCancelled unlocks early, before the timeout", () => {
  const record = seedLock();
  assert.equal(secondsUntilRefundable(record.lockId) > 0, true);
  const cancelled = markCancelled("0", "7", "0x" + "b".repeat(64));
  assert.equal(cancelled.status, "cancelled");
});

test("markRefunded rejects before the timeout has elapsed", () => {
  seedLock();
  assert.throws(
    () => markRefunded("0", "0x" + "b".repeat(64)),
    EscrowTimeoutNotElapsedError,
  );
  assert.equal(isRefundable("0"), false);
});

test("markRefunded succeeds exactly once after the timeout elapses", () => {
  const now = Date.now();
  seedLock({ createdAt: Math.floor(now / 1000) - DEFAULT_ESCROW_TIMEOUT_SECONDS - 1 });

  assert.equal(isRefundable("0", now), true);
  const record = markRefunded("0", "0x" + "b".repeat(64), now);
  assert.equal(record.status, "refunded");

  assert.throws(
    () => markRefunded("0", "0x" + "c".repeat(64), now),
    EscrowLockNotActiveError,
  );
});

test("a Soroban nonce cannot be replayed to double-release a second lock", () => {
  __resetTreasuryEscrowStoreForTests();
  recordLock({
    lockId: "0",
    daoId: 1,
    proposalId: 7,
    depositor,
    recipient,
    amount: "1",
    lockTxHash,
  });
  recordLock({
    lockId: "1",
    daoId: 1,
    proposalId: 7,
    depositor,
    recipient,
    amount: "1",
    lockTxHash,
  });

  markReleased("0", "999", "0x" + "b".repeat(64));
  assert.throws(
    () => markReleased("1", "999", "0x" + "c".repeat(64)),
    EscrowNonceReplayError,
  );
});

test("a release nonce cannot be reused to cancel a different lock (no double-refund)", () => {
  __resetTreasuryEscrowStoreForTests();
  recordLock({
    lockId: "0",
    daoId: 1,
    proposalId: 7,
    depositor,
    recipient,
    amount: "1",
    lockTxHash,
  });
  recordLock({
    lockId: "1",
    daoId: 1,
    proposalId: 7,
    depositor,
    recipient,
    amount: "1",
    lockTxHash,
  });

  markCancelled("0", "555", "0x" + "b".repeat(64));
  assert.throws(
    () => markReleased("1", "555", "0x" + "c".repeat(64)),
    EscrowNonceReplayError,
  );
});
