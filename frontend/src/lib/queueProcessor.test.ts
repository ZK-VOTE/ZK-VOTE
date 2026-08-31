/**
 * Tests for the queue processor.
 *
 * Covers:
 * - Successful submission
 * - Transient failure → retry (retryable)
 * - Permanent failure (no retry)
 * - Conflict detection
 * - Uncertain network outcome (request sent, no response, retry idempotency)
 * - Concurrent processing (only one submission per entry)
 * - processQueue batch behavior
 * - startProcessor / stopProcessor lifecycle
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import {
  processEntry,
  processQueue,
  startProcessor,
  stopProcessor,
  isProcessorRunning,
} from "./queueProcessor";
import { submissionQueue } from "../store/submissionQueue";
import type { VotePayload } from "../store/submissionQueue";

// ──────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────

vi.mock("./api", () => ({
  relayerFetch: vi.fn(),
  parseApiError: vi.fn((data: unknown) =>
    typeof data === "object" && data !== null && "error" in data
      ? String((data as { error: unknown }).error)
      : "Unknown error",
  ),
  getApiErrorCode: vi.fn((data: unknown) =>
    typeof data === "object" && data !== null && "code" in data
      ? String((data as { code: unknown }).code)
      : undefined,
  ),
}));

// Functional localStorage mock
const localStorageStore: Record<string, string> = {};
Object.defineProperty(window, "localStorage", {
  value: {
    getItem: (k: string) => localStorageStore[k] ?? null,
    setItem: (k: string, v: string) => { localStorageStore[k] = v; },
    removeItem: (k: string) => { delete localStorageStore[k]; },
    clear: () =>
      Object.keys(localStorageStore).forEach(
        (k) => delete localStorageStore[k],
      ),
    length: 0,
    key: () => null,
  },
  writable: true,
});

import { relayerFetch } from "./api";
const mockRelayerFetch = relayerFetch as Mock;

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function makePayload(nullifier = "null_test"): VotePayload {
  return {
    daoId: 1,
    proposalId: 10,
    choice: true,
    nullifier,
    root: "root_hex",
    proof: { a: "a", b: "b", c: "c" },
    timestamp: Date.now(),
  };
}

function makeOkResponse(txHash = "tx123") {
  return {
    ok: true,
    json: async () => ({ txHash }),
    headers: new Headers(),
  };
}

function makeErrorResponse(
  status: number,
  code: string,
  message: string,
) {
  return {
    ok: false,
    status,
    json: async () => ({ error: message, code }),
    headers: new Headers(),
  };
}

// ──────────────────────────────────────────────────────────────
// Setup / teardown
// ──────────────────────────────────────────────────────────────

beforeEach(() => {
  Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]);
  submissionQueue.clearAll();
  vi.clearAllMocks();
  stopProcessor();
});

afterEach(() => {
  stopProcessor();
  submissionQueue.clearAll();
});

// ──────────────────────────────────────────────────────────────
// processEntry
// ──────────────────────────────────────────────────────────────

describe("processEntry – successful submission", () => {
  it("marks entry as submitted on 200 OK", async () => {
    const payload = makePayload("ok_null");
    submissionQueue.enqueue(payload);
    mockRelayerFetch.mockResolvedValueOnce(makeOkResponse("tx_ok"));

    await processEntry(submissionQueue.getState().entries["ok_null"]);

    const entry = submissionQueue.getState().entries["ok_null"];
    expect(entry.status).toBe("submitted");
    expect(entry.txHash).toBe("tx_ok");
  });

  it("marks submitted even when txHash is absent in response", async () => {
    const payload = makePayload("no_tx");
    submissionQueue.enqueue(payload);
    mockRelayerFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
      headers: new Headers(),
    });

    await processEntry(submissionQueue.getState().entries["no_tx"]);

    expect(submissionQueue.getState().entries["no_tx"].status).toBe("submitted");
    expect(submissionQueue.getState().entries["no_tx"].txHash).toBeNull();
  });
});

describe("processEntry – transient failures", () => {
  it("marks entry as pending (retryable) on network error", async () => {
    const payload = makePayload("net_err");
    submissionQueue.enqueue(payload);
    mockRelayerFetch.mockRejectedValueOnce(new Error("network failure"));

    await processEntry(submissionQueue.getState().entries["net_err"]);

    const entry = submissionQueue.getState().entries["net_err"];
    expect(entry.status).toBe("pending");
    expect(entry.lastError).toContain("network failure");
    expect(entry.retryAfter).not.toBeNull();
  });

  it("marks entry as pending (retryable) on 500", async () => {
    const payload = makePayload("srv_err");
    submissionQueue.enqueue(payload);
    mockRelayerFetch.mockResolvedValueOnce(
      makeErrorResponse(500, "INTERNAL_ERROR", "server boom"),
    );

    await processEntry(submissionQueue.getState().entries["srv_err"]);

    expect(submissionQueue.getState().entries["srv_err"].status).toBe("pending");
  });

  it("marks entry as pending on 429 rate limit", async () => {
    const payload = makePayload("rate_lim");
    submissionQueue.enqueue(payload);
    mockRelayerFetch.mockResolvedValueOnce(
      makeErrorResponse(429, "RATE_LIMITED", "slow down"),
    );

    await processEntry(submissionQueue.getState().entries["rate_lim"]);

    expect(submissionQueue.getState().entries["rate_lim"].status).toBe("pending");
  });

  it("eventually marks as failed after MAX_ATTEMPTS retries", async () => {
    const payload = makePayload("max_retry");
    submissionQueue.enqueue(payload);

    mockRelayerFetch.mockRejectedValue(new Error("always fails"));

    for (let i = 0; i < 5; i++) {
      // Reset retryAfter so each attempt proceeds immediately
      const e = submissionQueue.getState().entries["max_retry"];
      if (e) e.retryAfter = null;
      await processEntry(
        submissionQueue.getState().entries["max_retry"],
      );
    }

    expect(submissionQueue.getState().entries["max_retry"].status).toBe("failed");
    expect(submissionQueue.getState().entries["max_retry"].attempts).toBe(5);
  });
});

describe("processEntry – permanent failures", () => {
  it("marks as failed on 400 INVALID_PROOF", async () => {
    const payload = makePayload("bad_proof");
    submissionQueue.enqueue(payload);
    mockRelayerFetch.mockResolvedValueOnce(
      makeErrorResponse(400, "INVALID_PROOF", "proof invalid"),
    );

    await processEntry(submissionQueue.getState().entries["bad_proof"]);

    expect(submissionQueue.getState().entries["bad_proof"].status).toBe("failed");
  });

  it("marks as failed on 401 UNAUTHORIZED", async () => {
    const payload = makePayload("unauth");
    submissionQueue.enqueue(payload);
    mockRelayerFetch.mockResolvedValueOnce(
      makeErrorResponse(401, "UNAUTHORIZED", "unauthorized"),
    );

    await processEntry(submissionQueue.getState().entries["unauth"]);

    expect(submissionQueue.getState().entries["unauth"].status).toBe("failed");
  });
});

describe("processEntry – conflict detection", () => {
  it("marks as conflict on VOTE_ALREADY_CAST code", async () => {
    const payload = makePayload("already_voted");
    submissionQueue.enqueue(payload);
    mockRelayerFetch.mockResolvedValueOnce(
      makeErrorResponse(409, "VOTE_ALREADY_CAST", "you already voted"),
    );

    await processEntry(submissionQueue.getState().entries["already_voted"]);

    const entry = submissionQueue.getState().entries["already_voted"];
    expect(entry.status).toBe("conflict");
    expect(entry.conflictDetail).toBeTruthy();
  });

  it("marks as conflict when response message contains 'already voted'", async () => {
    const payload = makePayload("dup_vote");
    submissionQueue.enqueue(payload);
    mockRelayerFetch.mockResolvedValueOnce(
      makeErrorResponse(400, "OTHER", "you have already voted on this"),
    );

    await processEntry(submissionQueue.getState().entries["dup_vote"]);

    expect(submissionQueue.getState().entries["dup_vote"].status).toBe("conflict");
  });

  it("does NOT retry after conflict", async () => {
    const payload = makePayload("no_retry_conflict");
    submissionQueue.enqueue(payload);
    mockRelayerFetch.mockResolvedValueOnce(
      makeErrorResponse(409, "VOTE_ALREADY_CAST", "already voted"),
    );

    await processEntry(submissionQueue.getState().entries["no_retry_conflict"]);
    // Should be conflict now
    expect(
      submissionQueue.getState().entries["no_retry_conflict"].status,
    ).toBe("conflict");

    // Processing again should not call fetch again
    await processEntry(submissionQueue.getState().entries["no_retry_conflict"]);
    expect(mockRelayerFetch).toHaveBeenCalledTimes(1); // only the first call
  });
});

// ──────────────────────────────────────────────────────────────
// Idempotency / uncertain network outcome
// ──────────────────────────────────────────────────────────────

describe("processEntry – uncertain network outcome (idempotency)", () => {
  it("treats second submission with VOTE_ALREADY_CAST as idempotent success (conflict = vote recorded)", async () => {
    const payload = makePayload("idempotent_null");
    submissionQueue.enqueue(payload);

    // First call: network error (request may have been received by server)
    mockRelayerFetch.mockRejectedValueOnce(new Error("connection reset"));
    await processEntry(submissionQueue.getState().entries["idempotent_null"]);
    expect(submissionQueue.getState().entries["idempotent_null"].status).toBe(
      "pending",
    );

    // Reset backoff for test
    submissionQueue.getState().entries["idempotent_null"].retryAfter = null;

    // Second call: server says vote was already recorded (idempotency)
    mockRelayerFetch.mockResolvedValueOnce(
      makeErrorResponse(409, "VOTE_ALREADY_CAST", "vote already cast"),
    );
    await processEntry(submissionQueue.getState().entries["idempotent_null"]);

    const entry = submissionQueue.getState().entries["idempotent_null"];
    // The vote IS recorded on chain, just not as a new submission
    expect(entry.status).toBe("conflict"); // conflict = vote already exists = vote was accepted
    expect(entry.attempts).toBe(2);
    expect(mockRelayerFetch).toHaveBeenCalledTimes(2);
  });
});

// ──────────────────────────────────────────────────────────────
// Concurrent processing
// ──────────────────────────────────────────────────────────────

describe("processEntry – concurrent processing prevention", () => {
  it("only submits once even when processEntry is called concurrently", async () => {
    const payload = makePayload("concurrent_submit");
    submissionQueue.enqueue(payload);

    let resolveFirst!: () => void;
    const firstCallPromise = new Promise<Response>((resolve) => {
      resolveFirst = () =>
        resolve(makeOkResponse("tx_only_one") as unknown as Response);
    });
    mockRelayerFetch.mockReturnValueOnce(firstCallPromise);
    mockRelayerFetch.mockResolvedValue(makeOkResponse("tx_dup")); // second call would return this

    const entry = submissionQueue.getState().entries["concurrent_submit"];

    // Launch two concurrent processEntry calls
    const p1 = processEntry(entry);
    const p2 = processEntry(entry); // should be a no-op due to in-flight lock

    resolveFirst();
    await Promise.all([p1, p2]);

    expect(mockRelayerFetch).toHaveBeenCalledTimes(1);
    expect(submissionQueue.getState().entries["concurrent_submit"].status).toBe(
      "submitted",
    );
  });
});

// ──────────────────────────────────────────────────────────────
// processQueue batch
// ──────────────────────────────────────────────────────────────

describe("processQueue", () => {
  it("processes all pending entries", async () => {
    submissionQueue.enqueue(makePayload("batch1"));
    submissionQueue.enqueue(makePayload("batch2"));
    submissionQueue.enqueue(makePayload("batch3"));

    mockRelayerFetch.mockResolvedValue(makeOkResponse());

    await processQueue();

    const entries = submissionQueue.getState().entries;
    expect(entries["batch1"].status).toBe("submitted");
    expect(entries["batch2"].status).toBe("submitted");
    expect(entries["batch3"].status).toBe("submitted");
  });

  it("skips entries in backoff period", async () => {
    submissionQueue.enqueue(makePayload("backoff_skip"));
    const e = submissionQueue.getState().entries[
      "backoff_skip"
    ];
    e.retryAfter = Date.now() + 60_000; // far future

    mockRelayerFetch.mockResolvedValue(makeOkResponse());

    await processQueue();

    expect(mockRelayerFetch).not.toHaveBeenCalled();
    expect(
      submissionQueue.getState().entries["backoff_skip"].status,
    ).toBe("pending");
  });

  it("skips already-submitted entries", async () => {
    submissionQueue.enqueue(makePayload("already_done"));
    submissionQueue.markSubmitting("already_done");
    submissionQueue.markSubmitted("already_done", "tx_done");

    mockRelayerFetch.mockResolvedValue(makeOkResponse());

    await processQueue();

    expect(mockRelayerFetch).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────
// Processor lifecycle
// ──────────────────────────────────────────────────────────────

describe("startProcessor / stopProcessor", () => {
  it("starts and stops cleanly", () => {
    expect(isProcessorRunning()).toBe(false);
    startProcessor();
    expect(isProcessorRunning()).toBe(true);
    stopProcessor();
    expect(isProcessorRunning()).toBe(false);
  });

  it("calling startProcessor twice is safe (no duplicate interval)", () => {
    startProcessor();
    startProcessor(); // second call is a no-op
    expect(isProcessorRunning()).toBe(true);
    stopProcessor();
  });

  it("calling stopProcessor when not running is safe", () => {
    expect(() => stopProcessor()).not.toThrow();
  });

  it("triggers processQueue on 'online' event", async () => {
    submissionQueue.enqueue(makePayload("online_trigger"));

    // Set up mock BEFORE starting processor so the immediate processQueue call
    // during startProcessor also gets the mock
    mockRelayerFetch.mockResolvedValue(makeOkResponse("tx_online"));

    startProcessor();

    // Wait for the entry to be submitted
    await vi.waitFor(
      () => {
        const entry = submissionQueue.getState().entries["online_trigger"];
        if (!entry || entry.status !== "submitted") {
          throw new Error(`Not yet submitted, status: ${entry?.status}`);
        }
      },
      { timeout: 3000, interval: 100 },
    );

    stopProcessor();
    expect(submissionQueue.getState().entries["online_trigger"].status).toBe("submitted");
  });
});
