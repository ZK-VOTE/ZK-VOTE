/**
 * Tests for the offline submission queue store.
 *
 * Covers:
 * - Enqueue / deduplication
 * - State lifecycle transitions
 * - Persistence (localStorage)
 * - Corrupt/malformed data recovery
 * - Error classification (retryable / permanent / conflict)
 * - Concurrency guard (markSubmitting)
 * - Backoff calculation
 * - getPendingEntries filtering
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  submissionQueue,
  classifyError,
  type VotePayload,
  type QueueEntry,
} from "./submissionQueue";

// ──────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────

function makePayload(nullifier = "abc123"): VotePayload {
  return {
    daoId: 1,
    proposalId: 42,
    choice: true,
    nullifier,
    root: "deadbeef",
    proof: { a: "aa", b: "bb", c: "cc" },
    timestamp: 1000,
    voterPublicKey: "GDTEST...",
  };
}

// localStorage mock that actually stores values
const localStorageStore: Record<string, string> = {};
const localStorageMock = {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
  length: 0,
  key: () => null,
};

// Replace the global localStorage mock in setup.ts with a functional one
Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
  writable: true,
});

// ──────────────────────────────────────────────────────────────
// Setup / teardown
// ──────────────────────────────────────────────────────────────

beforeEach(() => {
  if (localStorageStore["zkvote_submission_queue_v1"]) {
    delete localStorageStore["zkvote_submission_queue_v1"];
  }
  submissionQueue.clearAll();
});

afterEach(() => {
  submissionQueue.clearAll();
});

// ──────────────────────────────────────────────────────────────
// Enqueue / deduplication
// ──────────────────────────────────────────────────────────────

describe("submissionQueue – enqueue", () => {
  it("adds a new entry in pending state", () => {
    const payload = makePayload("null1");
    submissionQueue.enqueue(payload);

    const entries = submissionQueue.getState().entries;
    expect(entries["null1"]).toBeDefined();
    expect(entries["null1"].status).toBe("pending");
    expect(entries["null1"].attempts).toBe(0);
  });

  it("returns existing entry when enqueuing the same nullifier twice (pending)", () => {
    const payload = makePayload("dup_null");
    const e1 = submissionQueue.enqueue(payload);
    const e2 = submissionQueue.enqueue(payload);

    expect(e1.id).toBe(e2.id);
    const entries = Object.values(submissionQueue.getState().entries);
    expect(entries.length).toBe(1);
  });

  it("does not add a duplicate when status is submitting", () => {
    const payload = makePayload("sub_null");
    submissionQueue.enqueue(payload);
    submissionQueue.markSubmitting("sub_null");

    submissionQueue.enqueue(payload); // should be a no-op

    const entries = Object.values(submissionQueue.getState().entries);
    expect(entries.length).toBe(1);
    expect(entries[0].status).toBe("submitting");
  });

  it("does not replace a submitted entry on re-enqueue", () => {
    const payload = makePayload("done_null");
    submissionQueue.enqueue(payload);
    submissionQueue.markSubmitting("done_null");
    submissionQueue.markSubmitted("done_null", "txhash123");

    submissionQueue.enqueue(payload); // should be a no-op

    const entry = submissionQueue.getState().entries["done_null"];
    expect(entry.status).toBe("submitted");
    expect(entry.txHash).toBe("txhash123");
  });

  it("does not replace a conflict entry on re-enqueue", () => {
    const payload = makePayload("conflict_null");
    submissionQueue.enqueue(payload);
    submissionQueue.markSubmitting("conflict_null");
    submissionQueue.markConflict("conflict_null", "already voted");

    submissionQueue.enqueue(payload);

    const entry = submissionQueue.getState().entries["conflict_null"];
    expect(entry.status).toBe("conflict");
  });

  it("uses the nullifier as the entry id", () => {
    const payload = makePayload("my_nullifier_hex");
    const entry = submissionQueue.enqueue(payload);
    expect(entry.id).toBe("my_nullifier_hex");
  });
});

// ──────────────────────────────────────────────────────────────
// State lifecycle transitions
// ──────────────────────────────────────────────────────────────

describe("submissionQueue – lifecycle transitions", () => {
  it("pending → submitting → submitted", () => {
    const payload = makePayload("tx1");
    submissionQueue.enqueue(payload);

    expect(submissionQueue.getState().entries["tx1"].status).toBe("pending");

    const acquired = submissionQueue.markSubmitting("tx1");
    expect(acquired).toBe(true);
    expect(submissionQueue.getState().entries["tx1"].status).toBe("submitting");
    expect(submissionQueue.getState().entries["tx1"].attempts).toBe(1);

    submissionQueue.markSubmitted("tx1", "txhash_abc");
    const entry = submissionQueue.getState().entries["tx1"];
    expect(entry.status).toBe("submitted");
    expect(entry.txHash).toBe("txhash_abc");
  });

  it("pending → submitting → retryable → pending (backoff)", () => {
    const payload = makePayload("retry1");
    submissionQueue.enqueue(payload);
    submissionQueue.markSubmitting("retry1");
    submissionQueue.markRetryable("retry1", "network error");

    const entry = submissionQueue.getState().entries["retry1"];
    expect(entry.status).toBe("pending");
    expect(entry.lastError).toBe("network error");
    expect(entry.retryAfter).toBeGreaterThan(Date.now());
  });

  it("after MAX_ATTEMPTS retries, markRetryable sets status to failed", () => {
    const payload = makePayload("maxretry");
    submissionQueue.enqueue(payload);

    // Simulate MAX_ATTEMPTS (5) failed attempts
    for (let i = 0; i < 5; i++) {
      submissionQueue.markSubmitting("maxretry");
      submissionQueue.markRetryable("maxretry", "error");
    }

    const entry = submissionQueue.getState().entries["maxretry"];
    expect(entry.status).toBe("failed");
    expect(entry.attempts).toBe(5);
  });

  it("pending → submitting → conflict", () => {
    const payload = makePayload("conflict1");
    submissionQueue.enqueue(payload);
    submissionQueue.markSubmitting("conflict1");
    submissionQueue.markConflict("conflict1", "VOTE_ALREADY_CAST");

    const entry = submissionQueue.getState().entries["conflict1"];
    expect(entry.status).toBe("conflict");
    expect(entry.conflictDetail).toBe("VOTE_ALREADY_CAST");
  });

  it("pending → submitting → failed (permanent)", () => {
    const payload = makePayload("perm_fail");
    submissionQueue.enqueue(payload);
    submissionQueue.markSubmitting("perm_fail");
    submissionQueue.markFailed("perm_fail", "INVALID_PROOF");

    const entry = submissionQueue.getState().entries["perm_fail"];
    expect(entry.status).toBe("failed");
    expect(entry.lastError).toBe("INVALID_PROOF");
    expect(entry.retryAfter).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────
// Concurrency guard
// ──────────────────────────────────────────────────────────────

describe("submissionQueue – concurrency guard", () => {
  it("markSubmitting returns false for a second concurrent call", () => {
    const payload = makePayload("concurrent");
    submissionQueue.enqueue(payload);

    const first = submissionQueue.markSubmitting("concurrent");
    const second = submissionQueue.markSubmitting("concurrent"); // duplicate

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(submissionQueue.getState().entries["concurrent"].attempts).toBe(1);
  });

  it("allows re-submission after first attempt resolves", () => {
    const payload = makePayload("seq_retry");
    submissionQueue.enqueue(payload);

    submissionQueue.markSubmitting("seq_retry");
    submissionQueue.markRetryable("seq_retry", "timeout");
    // Reset retryAfter for test
    (submissionQueue.getState().entries["seq_retry"] as QueueEntry).retryAfter = null;

    const second = submissionQueue.markSubmitting("seq_retry");
    expect(second).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// getPendingEntries
// ──────────────────────────────────────────────────────────────

describe("submissionQueue – getPendingEntries", () => {
  it("returns only pending entries with no retryAfter or expired backoff", () => {
    submissionQueue.enqueue(makePayload("p1")); // pending, no backoff
    submissionQueue.enqueue(makePayload("p2")); // pending with future backoff
    submissionQueue.enqueue(makePayload("p3")); // submitted

    // Set backoff on p2
    const p2 = submissionQueue.getState().entries["p2"] as QueueEntry;
    p2.retryAfter = Date.now() + 60_000;

    // Mark p3 submitted
    submissionQueue.markSubmitting("p3");
    submissionQueue.markSubmitted("p3", null);

    const pending = submissionQueue.getPendingEntries();
    expect(pending.map((e) => e.id)).toContain("p1");
    expect(pending.map((e) => e.id)).not.toContain("p2");
    expect(pending.map((e) => e.id)).not.toContain("p3");
  });

  it("includes entries whose backoff has expired", () => {
    submissionQueue.enqueue(makePayload("expired_backoff"));
    const entry = submissionQueue.getState().entries[
      "expired_backoff"
    ] as QueueEntry;
    entry.retryAfter = Date.now() - 1; // expired

    const pending = submissionQueue.getPendingEntries();
    expect(pending.map((e) => e.id)).toContain("expired_backoff");
  });

  it("excludes in-flight entries", () => {
    submissionQueue.enqueue(makePayload("in_flight"));
    submissionQueue.markSubmitting("in_flight");

    const pending = submissionQueue.getPendingEntries();
    expect(pending.map((e) => e.id)).not.toContain("in_flight");
  });
});

// ──────────────────────────────────────────────────────────────
// Persistence
// ──────────────────────────────────────────────────────────────

describe("submissionQueue – persistence", () => {
  it("persists entries to localStorage on enqueue", () => {
    submissionQueue.enqueue(makePayload("persist1"));
    const stored = localStorageStore["zkvote_submission_queue_v1"];
    expect(stored).toBeTruthy();
    expect(stored.length).toBeGreaterThan(10);
  });

  it("rehydrates entries from localStorage on initialize", () => {
    submissionQueue.enqueue(makePayload("reload1"));
    submissionQueue.enqueue(makePayload("reload2"));

    // Simulate new page load: clear in-memory state but keep localStorage
    // (clearAll would clear localStorage too; instead we just re-initialize)
    submissionQueue.initialize();

    const entries = submissionQueue.getState().entries;
    expect(entries["reload1"]).toBeDefined();
    expect(entries["reload2"]).toBeDefined();
  });

  it("resets 'submitting' entries to 'pending' on reload (interrupted submission)", () => {
    submissionQueue.enqueue(makePayload("interrupted"));
    submissionQueue.markSubmitting("interrupted");
    // State is now "submitting" – simulate reload

    submissionQueue.initialize(); // re-load from localStorage

    const entry = submissionQueue.getState().entries["interrupted"];
    // Should be reset to pending since the submission was never completed
    expect(entry.status).toBe("pending");
  });

  it("gracefully handles corrupted localStorage data", () => {
    localStorageStore["zkvote_submission_queue_v1"] = "not-valid-base64!!!";
    submissionQueue.initialize();
    // Should not throw, should start with empty queue
    expect(Object.keys(submissionQueue.getState().entries).length).toBe(0);
  });

  it("gracefully handles missing required fields in persisted entry", async () => {
    // Persist valid + one invalid entry
    submissionQueue.enqueue(makePayload("valid_entry"));
    const stored = localStorageStore["zkvote_submission_queue_v1"];

    // Manually inject a corrupt entry into the stored object
    const { decryptData, encryptData } = await import("./secureStorage");
    const parsed = decryptData<{ entries: Record<string, unknown> }>(
      stored,
      "zkvote_queue_key",
    );
    if (parsed) {
      parsed.entries["corrupt"] = { badField: true }; // missing required fields
      localStorageStore["zkvote_submission_queue_v1"] = encryptData(
        parsed,
        "zkvote_queue_key",
      );
    }

    submissionQueue.initialize();

    const entries = submissionQueue.getState().entries;
    expect(entries["valid_entry"]).toBeDefined();
    expect(entries["corrupt"]).toBeUndefined(); // corrupt entry was skipped
  });
});

// ──────────────────────────────────────────────────────────────
// dismiss
// ──────────────────────────────────────────────────────────────

describe("submissionQueue – dismiss", () => {
  it("removes submitted entries", () => {
    submissionQueue.enqueue(makePayload("dismiss1"));
    submissionQueue.markSubmitting("dismiss1");
    submissionQueue.markSubmitted("dismiss1", null);

    submissionQueue.dismiss("dismiss1");
    expect(submissionQueue.getState().entries["dismiss1"]).toBeUndefined();
  });

  it("removes conflict entries", () => {
    submissionQueue.enqueue(makePayload("dismiss2"));
    submissionQueue.markSubmitting("dismiss2");
    submissionQueue.markConflict("dismiss2", "conflict");

    submissionQueue.dismiss("dismiss2");
    expect(submissionQueue.getState().entries["dismiss2"]).toBeUndefined();
  });

  it("removes failed entries", () => {
    submissionQueue.enqueue(makePayload("dismiss3"));
    submissionQueue.markSubmitting("dismiss3");
    submissionQueue.markFailed("dismiss3", "error");

    submissionQueue.dismiss("dismiss3");
    expect(submissionQueue.getState().entries["dismiss3"]).toBeUndefined();
  });

  it("does NOT remove pending entries", () => {
    submissionQueue.enqueue(makePayload("dismiss4"));
    submissionQueue.dismiss("dismiss4"); // should no-op

    expect(submissionQueue.getState().entries["dismiss4"]).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────
// clearAll
// ──────────────────────────────────────────────────────────────

describe("submissionQueue – clearAll", () => {
  it("removes all entries from memory and localStorage", () => {
    submissionQueue.enqueue(makePayload("clear1"));
    submissionQueue.enqueue(makePayload("clear2"));

    submissionQueue.clearAll();

    expect(Object.keys(submissionQueue.getState().entries).length).toBe(0);
    expect(localStorageStore["zkvote_submission_queue_v1"]).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────
// Error classification
// ──────────────────────────────────────────────────────────────

describe("classifyError", () => {
  it("classifies VOTE_ALREADY_CAST as conflict", () => {
    expect(
      classifyError(409, "VOTE_ALREADY_CAST", "already voted"),
    ).toMatchObject({ kind: "conflict" });
  });

  it("classifies 'already voted' message as conflict regardless of status", () => {
    expect(classifyError(200, undefined, "already voted on this")).toMatchObject(
      { kind: "conflict" },
    );
  });

  it("classifies nullifier message as conflict", () => {
    expect(
      classifyError(400, undefined, "nullifier already used"),
    ).toMatchObject({ kind: "conflict" });
  });

  it("classifies UnreachableCodeReached as conflict", () => {
    expect(
      classifyError(500, undefined, "UnreachableCodeReached"),
    ).toMatchObject({ kind: "conflict" });
  });

  it("classifies undefined status as retryable", () => {
    expect(classifyError(undefined, undefined, "network fail")).toMatchObject({
      kind: "retryable",
    });
  });

  it("classifies 429 as retryable", () => {
    expect(classifyError(429, "RATE_LIMITED", "rate limited")).toMatchObject({
      kind: "retryable",
    });
  });

  it("classifies 500 as retryable", () => {
    expect(classifyError(500, "INTERNAL_ERROR", "error")).toMatchObject({
      kind: "retryable",
    });
  });

  it("classifies 503 as retryable", () => {
    expect(classifyError(503, undefined, "unavailable")).toMatchObject({
      kind: "retryable",
    });
  });

  it("classifies 400 INVALID_PROOF as permanent", () => {
    expect(classifyError(400, "INVALID_PROOF", "bad proof")).toMatchObject({
      kind: "permanent",
    });
  });

  it("classifies 401 as permanent", () => {
    expect(classifyError(401, "UNAUTHORIZED", "unauthorized")).toMatchObject({
      kind: "permanent",
    });
  });

  it("classifies 404 as permanent", () => {
    expect(classifyError(404, "NOT_FOUND", "not found")).toMatchObject({
      kind: "permanent",
    });
  });

  it("classifies 422 as permanent", () => {
    expect(classifyError(422, "VALIDATION_ERROR", "bad input")).toMatchObject({
      kind: "permanent",
    });
  });

  it("classifies 408 as retryable (timeout)", () => {
    expect(classifyError(408, undefined, "timeout")).toMatchObject({
      kind: "retryable",
    });
  });
});
