/**
 * Queue Processor
 *
 * Processes the submission queue by:
 * 1. Watching for network connectivity changes (online/offline events)
 * 2. Submitting pending entries to the /vote endpoint
 * 3. Applying the correct status transitions (submitted / retryable / conflict / failed)
 * 4. Preventing concurrent processing of the same entry
 *
 * This module is framework-agnostic: it operates on the submissionQueue store
 * and relayerFetch directly, with no React dependency. It is started/stopped
 * by the useSubmissionQueue hook.
 */

import { submissionQueue, classifyError } from "../store/submissionQueue";
import type { QueueEntry } from "../store/submissionQueue";
import { relayerFetch, parseApiError, getApiErrorCode } from "./api";

// ============================================================
// Processor state
// ============================================================

let processorStarted = false;
let onlineHandler: (() => void) | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;

// ============================================================
// Single-entry submission
// ============================================================

/**
 * Submit one queue entry.
 *
 * This function is idempotent: if the entry is already in-flight it returns
 * immediately (the concurrency guard in `markSubmitting` handles this).
 */
export async function processEntry(entry: QueueEntry): Promise<void> {
  // Skip entries that should not be retried
  if (
    entry.status === "submitted" ||
    entry.status === "conflict" ||
    entry.status === "failed"
  ) {
    return;
  }

  // Skip entries in backoff period
  if (entry.retryAfter !== null && entry.retryAfter > Date.now()) {
    return;
  }

  // Concurrency guard – returns false if already in-flight
  const acquired = submissionQueue.markSubmitting(entry.id);
  if (!acquired) return;

  try {
    const response = await relayerFetch("/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry.payload),
      // Do NOT retry inside relayerFetch for queue submissions – the queue
      // owns the retry logic.
      maxRetries: 1,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const message = parseApiError(errorData);
      const code = getApiErrorCode(errorData);
      const classification = classifyError(response.status, code, message);

      if (classification.kind === "conflict") {
        submissionQueue.markConflict(entry.id, classification.message);
      } else if (classification.kind === "permanent") {
        submissionQueue.markFailed(entry.id, classification.message);
      } else {
        submissionQueue.markRetryable(entry.id, classification.message);
      }
      return;
    }

    const result = await response.json().catch(() => ({}));
    const txHash: string | null =
      typeof result.txHash === "string" ? result.txHash : null;
    submissionQueue.markSubmitted(entry.id, txHash);
  } catch (err) {
    // Network-level error (no HTTP response)
    const message =
      err instanceof Error ? err.message : "Network error – will retry";

    // Check if the error indicates a conflict (some network stacks surface
    // server rejection messages through the error itself)
    const classification = classifyError(undefined, undefined, message);
    if (classification.kind === "conflict") {
      submissionQueue.markConflict(entry.id, message);
    } else {
      submissionQueue.markRetryable(entry.id, message);
    }
  }
}

// ============================================================
// Batch processing
// ============================================================

/**
 * Process all pending queue entries.
 * Runs each submission in parallel (safe: each entry has its own in-flight lock).
 */
export async function processQueue(): Promise<void> {
  const pending = submissionQueue.getPendingEntries();
  if (pending.length === 0) return;

  await Promise.allSettled(pending.map(processEntry));
}

// ============================================================
// Processor lifecycle
// ============================================================

/**
 * Start the background processor.
 *
 * - Processes the queue immediately.
 * - Attaches an online event listener so the queue is processed when
 *   connectivity returns.
 * - Sets up a periodic sweep (every 15 s) to catch backoff-expired entries.
 *
 * Calling startProcessor when it is already running is safe (no-op).
 */
export function startProcessor(): void {
  if (processorStarted) return;
  processorStarted = true;

  // Immediate pass
  void processQueue();

  // Online recovery
  onlineHandler = () => {
    void processQueue();
  };
  window.addEventListener("online", onlineHandler);

  // Periodic sweep for backoff-expired retries
  intervalId = setInterval(() => {
    void processQueue();
  }, 15_000);
}

/**
 * Stop the background processor.
 * Should be called on app unmount / logout.
 */
export function stopProcessor(): void {
  if (!processorStarted) return;
  processorStarted = false;

  if (onlineHandler) {
    window.removeEventListener("online", onlineHandler);
    onlineHandler = null;
  }

  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * Whether the processor is currently running.
 */
export function isProcessorRunning(): boolean {
  return processorStarted;
}
