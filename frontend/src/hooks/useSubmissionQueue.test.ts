/**
 * Tests for the useSubmissionQueue hook.
 *
 * Covers:
 * - Initial state
 * - Enqueue and reactive state update
 * - Online/offline detection
 * - Conflict and failure exposure
 * - dismissEntry
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSubmissionQueue } from "./useSubmissionQueue";
import { submissionQueue } from "../store/submissionQueue";
import type { VotePayload } from "../store/submissionQueue";

// ──────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────

vi.mock("../lib/queueProcessor", () => ({
  startProcessor: vi.fn(),
  stopProcessor: vi.fn(),
  processQueue: vi.fn().mockResolvedValue(undefined),
}));

// Functional localStorage
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

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function makePayload(nullifier = "hook_null"): VotePayload {
  return {
    daoId: 2,
    proposalId: 5,
    choice: false,
    nullifier,
    root: "root",
    proof: { a: "a", b: "b", c: "c" },
    timestamp: Date.now(),
  };
}

// ──────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────

beforeEach(() => {
  Object.keys(localStorageStore).forEach((k) => delete localStorageStore[k]);
  submissionQueue.clearAll();
  vi.clearAllMocks();
});

afterEach(() => {
  submissionQueue.clearAll();
});

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

describe("useSubmissionQueue – initial state", () => {
  it("starts with zero pending / submitted / conflict entries", () => {
    const { result } = renderHook(() => useSubmissionQueue());

    expect(result.current.pendingCount).toBe(0);
    expect(result.current.submittedCount).toBe(0);
    expect(result.current.conflicts.length).toBe(0);
    expect(result.current.failures.length).toBe(0);
    expect(result.current.allEntries.length).toBe(0);
  });

  it("reflects browser online status", () => {
    // jsdom defaults to online
    const { result } = renderHook(() => useSubmissionQueue());
    expect(result.current.isOnline).toBe(true);
  });
});

describe("useSubmissionQueue – enqueueVote", () => {
  it("adds an entry and increments pendingCount", () => {
    const { result } = renderHook(() => useSubmissionQueue());

    act(() => {
      result.current.enqueueVote(makePayload("enq1"));
    });

    expect(result.current.pendingCount).toBe(1);
    expect(result.current.allEntries.length).toBe(1);
    expect(result.current.allEntries[0].status).toBe("pending");
  });

  it("deduplicates entries with the same nullifier", () => {
    const { result } = renderHook(() => useSubmissionQueue());

    act(() => {
      result.current.enqueueVote(makePayload("dup_hook"));
      result.current.enqueueVote(makePayload("dup_hook"));
    });

    expect(result.current.allEntries.length).toBe(1);
  });
});

describe("useSubmissionQueue – reactive updates", () => {
  it("updates when queue store changes", () => {
    const { result } = renderHook(() => useSubmissionQueue());

    act(() => {
      submissionQueue.enqueue(makePayload("reactive1"));
    });

    expect(result.current.pendingCount).toBe(1);

    act(() => {
      submissionQueue.markSubmitting("reactive1");
      submissionQueue.markSubmitted("reactive1", "tx_reactive");
    });

    expect(result.current.pendingCount).toBe(0);
    expect(result.current.submittedCount).toBe(1);
  });

  it("exposes conflict entries when conflict occurs", () => {
    const { result } = renderHook(() => useSubmissionQueue());

    act(() => {
      submissionQueue.enqueue(makePayload("conflict_hook"));
      submissionQueue.markSubmitting("conflict_hook");
      submissionQueue.markConflict("conflict_hook", "You already voted");
    });

    expect(result.current.conflicts.length).toBe(1);
    expect(result.current.conflicts[0].conflictDetail).toBe("You already voted");
    expect(result.current.pendingCount).toBe(0);
  });

  it("exposes failure entries when permanent failure occurs", () => {
    const { result } = renderHook(() => useSubmissionQueue());

    act(() => {
      submissionQueue.enqueue(makePayload("fail_hook"));
      submissionQueue.markSubmitting("fail_hook");
      submissionQueue.markFailed("fail_hook", "INVALID_PROOF");
    });

    expect(result.current.failures.length).toBe(1);
    expect(result.current.failures[0].lastError).toBe("INVALID_PROOF");
  });
});

describe("useSubmissionQueue – dismissEntry", () => {
  it("removes a submitted entry", () => {
    const { result } = renderHook(() => useSubmissionQueue());

    act(() => {
      submissionQueue.enqueue(makePayload("dismiss_hook"));
      submissionQueue.markSubmitting("dismiss_hook");
      submissionQueue.markSubmitted("dismiss_hook", null);
    });

    expect(result.current.submittedCount).toBe(1);

    act(() => {
      result.current.dismissEntry("dismiss_hook");
    });

    expect(result.current.submittedCount).toBe(0);
    expect(result.current.allEntries.length).toBe(0);
  });

  it("removes a conflict entry", () => {
    const { result } = renderHook(() => useSubmissionQueue());

    act(() => {
      submissionQueue.enqueue(makePayload("dismiss_conflict"));
      submissionQueue.markSubmitting("dismiss_conflict");
      submissionQueue.markConflict("dismiss_conflict", "already voted");
    });

    expect(result.current.conflicts.length).toBe(1);

    act(() => {
      result.current.dismissEntry("dismiss_conflict");
    });

    expect(result.current.conflicts.length).toBe(0);
  });
});

describe("useSubmissionQueue – online/offline events", () => {
  it("updates isOnline when offline event fires", () => {
    const { result } = renderHook(() => useSubmissionQueue());

    expect(result.current.isOnline).toBe(true);

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });

    expect(result.current.isOnline).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect(result.current.isOnline).toBe(true);
  });
});
