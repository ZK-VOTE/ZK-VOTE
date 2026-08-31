/**
 * Transaction Confirmation Queue Tests (#174)
 *
 * Exercises the shared confirmation worker in services/confirmation-queue.ts:
 * - Immediate resolution when the transaction is already confirmed
 * - EXPIRED (never confirms) behavior within the wait budget
 * - Coalescing of concurrent waiters for the same hash onto one poller
 * - The cached-outcome fast path for repeat callers
 * - The non-blocking confirmation status lookup used by GET /tx/:hash
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";

process.env.RELAYER_TEST_MODE = "true";
process.env.SOROBAN_RPC_URL = "http://localhost:8000/soroban/rpc";
process.env.NETWORK_PASSPHRASE =
  "Test SDF Future Network ; October 2022";

const stellar = await import("../src/services/stellar.js");
const {
  waitForTransaction,
  getConfirmationStatus,
  getConfirmationQueueStats,
  startConfirmationWorker,
  stopConfirmationWorker,
  TransactionConfirmationTimeoutError,
} = await import("../src/services/confirmation-queue.js");

/** Stub `server.getTransaction` for the duration of a test. */
function mockGetTransaction(impl) {
  const original = stellar.server.getTransaction;
  stellar.server.getTransaction = impl;
  return () => {
    stellar.server.getTransaction = original;
  };
}

after(async () => {
  await stopConfirmationWorker();
});

test("confirmation queue resolves immediately for an already-confirmed transaction", async () => {
  const restore = mockGetTransaction(async () => ({
    status: "SUCCESS",
    hash: "already-confirmed",
  }));

  try {
    const result = await waitForTransaction("already-confirmed", {
      maxAttempts: 5,
      maxWaitMs: 5000,
    });
    assert.equal(result.status, "SUCCESS");

    const status = await getConfirmationStatus("already-confirmed");
    assert.equal(status.state, "CONFIRMED");
    assert.equal(status.status, "SUCCESS");
    assert.ok(status.attempts >= 1);
  } finally {
    restore();
    await stopConfirmationWorker();
  }
});

test("confirmation queue expires a transaction that never confirms", async () => {
  const restore = mockGetTransaction(async () => ({
    status: "NOT_FOUND",
    hash: "never-confirms",
  }));

  try {
    // Keep the attempt cap below the per-waiter timer so the worker's
    // EXPIRED resolution (which populates the cache) wins the race.
    await assert.rejects(
      waitForTransaction("never-confirms", {
        maxAttempts: 2,
        initialDelayMs: 20,
        maxDelayMs: 40,
        jitter: false,
      }),
      (err) => {
        assert.ok(err instanceof TransactionConfirmationTimeoutError);
        assert.equal(err.state, "EXPIRED");
        assert.equal(err.hash, "never-confirms");
        assert.ok(err.attempts >= 1);
        return true;
      },
    );

    // The expired outcome is cached and surfaces through the status endpoint.
    const status = await getConfirmationStatus("never-confirms");
    assert.equal(status.state, "EXPIRED");
    assert.ok(status.error?.includes("Transaction not found after timeout"));
  } finally {
    restore();
    await stopConfirmationWorker();
  }
});

test("concurrent waiters for the same hash share a single poller", async () => {
  let polls = 0;
  const restore = mockGetTransaction(async (hash) => {
    polls++;
    // First poll misses; the second catches the confirmation.
    return polls >= 2
      ? { status: "SUCCESS", hash }
      : { status: "NOT_FOUND", hash };
  });

  try {
    const [first, second] = await Promise.all([
      waitForTransaction("shared-hash", {
        maxAttempts: 5,
        initialDelayMs: 20,
        maxDelayMs: 40,
        jitter: false,
      }),
      waitForTransaction("shared-hash", {
        maxAttempts: 5,
        initialDelayMs: 20,
        maxDelayMs: 40,
        jitter: false,
      }),
    ]);

    assert.equal(first.status, "SUCCESS");
    assert.equal(second.status, "SUCCESS");
    // Coalesced onto one queue entry: exactly 2 polls for 2 waiters, not 4.
    assert.equal(polls, 2);
  } finally {
    restore();
    await stopConfirmationWorker();
  }
});

test("repeat callers hit the cached outcome instead of polling again", async () => {
  let polls = 0;
  const restore = mockGetTransaction(async (hash) => {
    polls++;
    return { status: "SUCCESS", hash };
  });

  try {
    await waitForTransaction("cached-hash", { maxAttempts: 3 });
    const pollsAfterFirst = polls;
    assert.equal(pollsAfterFirst, 1);

    // Second call resolves from the result cache without another RPC poll.
    const result = await waitForTransaction("cached-hash", { maxAttempts: 3 });
    assert.equal(result.status, "SUCCESS");
    assert.equal(polls, pollsAfterFirst);
  } finally {
    restore();
    await stopConfirmationWorker();
  }
});

test("confirmation status falls back to a single lookup for unknown hashes", async () => {
  let polls = 0;
  const restore = mockGetTransaction(async (hash) => {
    polls++;
    return { status: "NOT_FOUND", hash };
  });

  try {
    const status = await getConfirmationStatus("never-seen-hash");
    assert.equal(status.state, "UNKNOWN");
    assert.equal(status.status, "NOT_FOUND");
    assert.equal(polls, 1);
  } finally {
    restore();
    await stopConfirmationWorker();
  }
});

test("confirmation status reports PENDING while the queue is still polling", async () => {
  let resolveFirstPoll;
  const gate = new Promise((resolve) => {
    resolveFirstPoll = resolve;
  });
  let polls = 0;
  const restore = mockGetTransaction(async () => {
    polls++;
    if (polls === 1) await gate; // hold the first poll open
    return { status: "SUCCESS", hash: "in-flight-hash" };
  });

  try {
    const waiter = waitForTransaction("in-flight-hash", {
      maxAttempts: 5,
      maxWaitMs: 5000,
    });
    // Let the worker pick the entry up and start the first (blocked) poll.
    await new Promise((r) => setTimeout(r, 50));

    const status = await getConfirmationStatus("in-flight-hash");
    assert.equal(status.state, "PENDING");

    resolveFirstPoll();
    await waiter;
  } finally {
    restore();
    await stopConfirmationWorker();
  }
});

test("queue stats expose worker, pending and cache state", async () => {
  const restore = mockGetTransaction(async () => ({
    status: "NOT_FOUND",
    hash: "stats-hash",
  }));

  try {
    startConfirmationWorker();
    const stats = getConfirmationQueueStats();
    assert.equal(typeof stats.running, "boolean");
    assert.equal(typeof stats.pending, "number");
    assert.equal(typeof stats.cached, "number");
  } finally {
    restore();
    await stopConfirmationWorker();
  }
});
