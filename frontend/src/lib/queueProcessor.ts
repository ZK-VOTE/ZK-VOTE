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
import { APP_NETWORK_PASSPHRASE, networkLabel, walletSession } from "./walletSession";

/** Relayer codes meaning "re-open the vote session and try again" (#750). */
const SESSION_RETRY_CODES = new Set([
  "VOTE_SESSION_STALE",
  "VOTE_SESSION_INVALID",
  "VOTE_SESSION_REQUIRED",
]);

export const CREDENTIAL_COLLISION_MESSAGE =
  "Your voting credentials were already used for this proposal from another session or device. If that wasn't you, someone may have had access to your wallet: lock it, review connected sites, and contact the DAO admins.";

// ============================================================
// Processor state
// ============================================================

let processorStarted = false;
let onlineHandler: (() => void) | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;
let unsubscribeSession: (() => void) | null = null;

// ============================================================
// Single-entry submission
// ============================================================

/**
 * Why a bound entry must wait for the wallet (#750), or null to submit now.
 * A proof is never sent from a session other than the one that built it.
 */
async function sessionHoldReason(entry: QueueEntry): Promise<string | null> {
  if (!entry.binding) return null;
  if (await walletSession.matches(entry.binding)) return null;
  const { status } = walletSession.getState();
  if (status === "network_mismatch") {
    return `Switch your wallet back to ${networkLabel(APP_NETWORK_PASSPHRASE)} to submit this vote.`;
  }
  if (status === "disconnected") {
    return "Reconnect the wallet account that built this vote to submit it.";
  }
  return "This vote was built by a different wallet account. Reconnect that account to submit it.";
}

/** The relayer answers both `{ error, code }` and `{ error: { code } }`. */
function responseCode(data: Record<string, unknown>): string | undefined {
  return typeof data?.code === "string" ? data.code : getApiErrorCode(data);
}

/**
 * Asks the membership tree whether the queued proof's root is still in its
 * history. If the check itself cannot run (offline, RPC down), the entry is
 * treated as valid and the normal retry path decides.
 */
async function isRootStillValid(entry: QueueEntry): Promise<boolean> {
  try {
    const { getZkVoteClient } = await import("./client");
    const tx = await getZkVoteClient(null).membershipTree.root_ok({
      dao_id: BigInt(entry.payload.daoId),
      root: BigInt(`0x${entry.payload.root}`),
    });
    return tx.result !== false;
  } catch {
    return true;
  }
}

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

  // A retry may carry a root that has since been evicted from the tree's
  // history. Check before resubmitting so a dead proof is not replayed (#752).
  if (entry.attempts > 0 && !(await isRootStillValid(entry))) {
    submissionQueue.markFailed(
      entry.id,
      "This vote's Merkle root is no longer accepted. Cast your vote again to generate a fresh proof.",
    );
    return;
  }

  const hold = await sessionHoldReason(entry);
  if (hold) {
    submissionQueue.markHeld(entry.id, hold);
    return;
  }

  // Concurrency guard – returns false if already in-flight
  const acquired = submissionQueue.markSubmitting(entry.id);
  if (!acquired) return;

  try {
    // Bind the request to the live wallet session; legacy unbound entries
    // with no wallet connected go without (accepted only while the relayer
    // does not require sessions).
    const sessionHeaders =
      entry.binding || walletSession.getState().status === "active"
        ? await walletSession.voteHeaders(entry.payload)
        : {};
    const response = await relayerFetch("/vote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `vote_${entry.id}`,
        ...sessionHeaders,
      },
      body: JSON.stringify(entry.payload),
      // Do NOT retry inside relayerFetch for queue submissions – the queue
      // owns the retry logic.
      maxRetries: 1,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const message = parseApiError(errorData);
      const code = responseCode(errorData);

      if (code && SESSION_RETRY_CODES.has(code)) {
        walletSession.dropServerSession();
        submissionQueue.markRetryable(entry.id, message);
        return;
      }
      if (code === "NETWORK_MISMATCH") {
        submissionQueue.markRetryable(entry.id, message);
        return;
      }
      // The relayer's nullifier conflict has no code, only status "CONFLICT".
      if (response.status === 409 && errorData?.status === "CONFLICT") {
        submissionQueue.markConflict(
          entry.id,
          errorData.conflictSource === "other_session"
            ? CREDENTIAL_COLLISION_MESSAGE
            : message,
        );
        return;
      }

      const classification = classifyError(response.status, code as never, message);

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

    // Backend may return 202 with { success: false, status: "PENDING" } while
    // the vote is still in the relay queue — that is not a submitted ballot.
    if (
      response.status === 202 ||
      result?.status === "PENDING" ||
      result?.success === false
    ) {
      submissionQueue.markRetryable(
        entry.id,
        typeof result?.error === "string"
          ? result.error
          : "Vote accepted but still pending confirmation",
      );
      return;
    }

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

  // Resume held votes the moment their account/network reconnects (#750)
  unsubscribeSession = walletSession.subscribe(() => {
    void processQueue();
  });
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
  if (unsubscribeSession) {
    unsubscribeSession();
    unsubscribeSession = null;
  }
}

/**
 * Whether the processor is currently running.
 */
export function isProcessorRunning(): boolean {
  return processorStarted;
}
