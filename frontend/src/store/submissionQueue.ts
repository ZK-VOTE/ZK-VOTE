/**
 * Offline Submission Queue
 *
 * Provides a durable, persistent queue for vote submissions that:
 * - Survives page reload (localStorage-backed)
 * - Deduplicates by nullifier (same vote is never submitted twice)
 * - Tracks submission state with a clear lifecycle:
 *     pending → submitting → submitted
 *                          ↘ failed
 *                          ↘ conflict
 * - Exposes a pub-sub API consistent with the existing store pattern
 *
 * Security notes:
 * - The ZK proof, public signals, and formatted Soroban proof bytes are persisted
 *   so the same proof can be retried without regenerating it (regeneration would
 *   require the user's private secret, which is NOT stored here).
 * - Private vote secrets (secret, salt, blindingFactor, pathElements) are NOT
 *   stored in the queue.  Only the already-computed proof payload is stored.
 * - Nullifiers are stored so deduplication works across reloads.
 */

import { encryptData, decryptData } from "./secureStorage";
import type { VoteBinding } from "../lib/walletSession";
import { mergeVersioned } from "../lib/safeMerge";

// ============================================================
// Types
// ============================================================

/**
 * A queued vote's submission state.
 *
 * pending     — waiting for network (or first attempt not yet made)
 * submitting  — an attempt is currently in flight
 * submitted   — the backend confirmed acceptance
 * failed      — a permanent non-retryable error occurred
 * conflict    — a conflict was detected (nullifier already used / already voted)
 */
export type SubmissionStatus =
  | "pending"
  | "submitting"
  | "submitted"
  | "failed"
  | "conflict";

/**
 * Payload sent to the /vote endpoint. Stored so retries are idempotent.
 * This is the already-formatted payload – no private cryptographic material.
 */
export interface VotePayload {
  daoId: number;
  proposalId: number;
  /**
   * Ballot choice is a public circuit signal (needed by the voting contract).
   * It must never be paired with a wallet identity in this payload (#644).
   */
  choice: boolean;
  /** Big-endian hex nullifier (public signal, safe to persist) */
  nullifier: string;
  /** Big-endian hex Merkle root (public signal) */
  root: string;
  proof: {
    a: string;
    b: string;
    c: string;
  };
  /** Unix ms timestamp of when the proof was generated */
  timestamp: number;
}

/** A single entry in the queue. */
export interface QueueEntry {
  /** Unique entry ID = nullifier hex. The nullifier IS the idempotency key. */
  id: string;
  /** The formatted vote payload ready to send to the relayer */
  payload: VotePayload;
  status: SubmissionStatus;
  /** Number of submission attempts so far */
  attempts: number;
  /** Unix ms of the first enqueue time */
  enqueuedAt: number;
  /** Unix ms of the last attempt */
  lastAttemptAt: number | null;
  /** Unix ms — do not retry before this time (backoff) */
  retryAfter: number | null;
  /** Error message from the last failed attempt */
  lastError: string | null;
  /** Conflict detail (for VOTE_ALREADY_CAST etc.) */
  conflictDetail: string | null;
  /** Transaction hash if submission succeeded */
  txHash: string | null;
  /**
   * Wallet session the proof was built in (#750): hashed account tag and
   * network. The processor holds the entry, without spending an attempt,
   * while a different account or network is connected. Absent on entries
   * queued before #750; those submit from whatever session is live.
   */
  binding?: VoteBinding;
  /** Why the entry is waiting on the wallet, for the UI. Null when not held. */
  heldReason?: string | null;
  /** Local monotonic sequence used to reject delayed state events. */
  revision?: number;
  updatedAt?: number;
  /** A typed merge conflict requiring user action, never a silent overwrite. */
  resolution?: { kind: "concurrent-edit"; detail: string };
}

/** Public-facing queue state */
export interface SubmissionQueueState {
  entries: Record<string, QueueEntry>;
}

// ============================================================
// Constants
// ============================================================

const STORAGE_KEY = "zkvote_submission_queue_v1";
const MAX_ATTEMPTS = 5;
// Exponential backoff base delay in ms (1 s, 2 s, 4 s, 8 s, 16 s, capped at 60 s)
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

// ============================================================
// In-memory state
// ============================================================

let state: SubmissionQueueState = { entries: {} };

// Track which entry IDs are currently being submitted to prevent concurrent processing
const inFlightIds = new Set<string>();

const listeners = new Set<() => void>();
let lastCommitted: Record<string, QueueEntry> = {};

function notify() {
  listeners.forEach((l) => l());
}

// ============================================================
// Persistence helpers
// ============================================================

function persist(s: SubmissionQueueState): void {
  // Only changed entries advance the monotonic local sequence.
  // This is applied before writing encrypted localStorage.
  for (const [id, entry] of Object.entries(s.entries)) {
    const previous = lastCommitted[id];
    if (entry !== previous) {
      entry.revision = Math.max(entry.revision ?? 0, previous?.revision ?? 0) + 1;
      entry.updatedAt = Date.now();
    }
  }
  lastCommitted = { ...s.entries };
  try {
    if (typeof window !== "undefined") {
      const encrypted = encryptData(s, "zkvote_queue_key");
      localStorage.setItem(STORAGE_KEY, encrypted);
    }
  } catch {
    // ignore persistence errors – the queue still works in-memory
  }
}

function loadPersisted(): SubmissionQueueState {
  try {
    if (typeof window !== "undefined") {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { entries: {} };

      const parsed = decryptData<SubmissionQueueState>(raw, "zkvote_queue_key");
      if (!parsed || typeof parsed !== "object") return { entries: {} };

      // Validate schema: ensure entries is an object
      const entries: Record<string, QueueEntry> = {};
      if (parsed.entries && typeof parsed.entries === "object") {
        for (const [id, raw] of Object.entries(parsed.entries)) {
          if (!isValidEntry(raw)) continue; // skip corrupt entries
          // Reset any "submitting" entries to "pending" – they weren't completed
          const entry = raw as QueueEntry;
          if (entry.status === "submitting") {
            entry.status = "pending";
          }
          entries[id] = entry;
        }
      }

      return { entries };
    }
  } catch {
    // Graceful recovery: ignore corrupt persisted data
  }
  return { entries: {} };
}

function isValidEntry(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    e.id.length > 0 &&
    typeof e.payload === "object" &&
    e.payload !== null &&
    typeof e.status === "string" &&
    typeof e.attempts === "number" &&
    typeof e.enqueuedAt === "number"
  );
}

// ============================================================
// Backoff calculation
// ============================================================

function computeRetryAfter(attempts: number): number {
  const delay = Math.min(
    BACKOFF_BASE_MS * Math.pow(2, attempts - 1),
    BACKOFF_MAX_MS,
  );
  return Date.now() + delay;
}

// ============================================================
// Retryable vs permanent error classification
// ============================================================

/**
 * Classify whether an error is retryable.
 *
 * Non-retryable:
 *   - VOTE_ALREADY_CAST / nullifier already used → conflict
 *   - 400 INVALID_PROOF → permanent (proof is bad)
 *   - 400 NOT_ELIGIBLE → permanent
 *   - 400 VOTING_PERIOD_CLOSED → permanent
 *   - 401 UNAUTHORIZED → permanent
 *   - 404 PROPOSAL_NOT_FOUND / DAO_NOT_FOUND → permanent
 *   - 422 VALIDATION_ERROR → permanent
 *
 * Retryable:
 *   - Network errors (no status)
 *   - 429 RATE_LIMITED
 *   - 500 INTERNAL_ERROR
 *   - 503/504 SERVICE_UNAVAILABLE
 */
export type ErrorClassification =
  | { kind: "retryable"; message: string }
  | { kind: "permanent"; message: string }
  | { kind: "conflict"; message: string };

export function classifyError(
  status: number | undefined,
  errorCode: string | undefined,
  message: string,
): ErrorClassification {
  // Conflict: structured codes only — never string-match error text (#646)
  if (
    errorCode === "VOTE_ALREADY_CAST" ||
    errorCode === "NULLIFIER_ALREADY_USED"
  ) {
    return { kind: "conflict", message };
  }

  if (status === undefined || status === 0) {
    // Network error, no HTTP response
    return { kind: "retryable", message };
  }

  if (status === 429) {
    return { kind: "retryable", message };
  }

  if (status >= 500) {
    return { kind: "retryable", message };
  }

  // 4xx (non-429) are permanent except 408 (timeout)
  if (status === 408) {
    return { kind: "retryable", message };
  }

  if (status >= 400 && status < 500) {
    return { kind: "permanent", message };
  }

  // Fallback: retryable
  return { kind: "retryable", message };
}

// ============================================================
// Store API
// ============================================================

export const submissionQueue = {
  /**
   * Initialize the queue by loading any persisted entries.
   * Should be called once at app startup.
   */
  initialize(): void {
    const loaded = loadPersisted();
    if (Object.keys(state.entries).length === 0) {
      state = loaded;
      lastCommitted = { ...loaded.entries };
      notify();
    } else {
      this.mergeExternal(loaded);
    }
  },

  /** Incorporates storage/refetch updates without regressing terminal state. */
  mergeExternal(incoming: SubmissionQueueState): void {
    const entries = { ...state.entries };
    let changed = false;
    for (const [id, other] of Object.entries(incoming.entries || {})) {
      if (!isValidEntry(other)) continue;
      const local = entries[id];
      if (!local) {
        entries[id] = other;
        changed = true;
        continue;
      }
      // Once a vote is confirmed, stale offline/cache snapshots cannot undo it.
      if (local.status === "submitted" && other.status !== "submitted") continue;
      // Compare meaningful state only; updatedAt/revision are causal
      // metadata, not evidence that a user changed their ballot.
      const merged = mergeVersioned(
        {
          value: { payload: local.payload, status: local.status, txHash: local.txHash },
          sequence: local.revision ?? 0,
          updatedAt: local.updatedAt ?? local.enqueuedAt,
        },
        {
          value: { payload: other.payload, status: other.status, txHash: other.txHash },
          sequence: other.revision ?? 0,
          updatedAt: other.updatedAt ?? other.enqueuedAt,
        },
      );
      if (merged.kind === "conflict") {
        entries[id] = {
          ...local, status: "conflict",
          conflictDetail: "Concurrent offline vote updates differ; review before retrying.",
          resolution: { kind: "concurrent-edit", detail: "Same version with conflicting payload" },
          retryAfter: null,
        };
        changed = true;
      } else if (merged.kind === "accepted") {
        entries[id] = other;
        changed = true;
      }
    }
    if (changed) {
      state = { entries };
      persist(state);
      notify();
    }
  },

  /** Called after the browser receives another tab's localStorage event. */
  syncFromStorage(): void {
    this.mergeExternal(loadPersisted());
  },

  getState(): SubmissionQueueState {
    return state;
  },

  /**
   * Enqueue a vote for submission.
   *
   * Idempotent: if an entry with the same nullifier already exists and has
   * not permanently failed or been resolved, this is a no-op.
   *
   * @returns The queue entry (new or existing)
   */
  enqueue(payload: VotePayload, binding?: VoteBinding | null): QueueEntry {
    const id = payload.nullifier;

    const existing = state.entries[id];
    if (existing) {
      // If already submitted or actively submitting, don't re-queue
      if (
        existing.status === "submitted" ||
        existing.status === "submitting" ||
        existing.status === "pending" ||
        existing.status === "conflict"
      ) {
        return existing;
      }
      // If it permanently failed, allow re-queue by resetting (caller intent is explicit)
      // Leave failed entries but do not add duplicates
      if (existing.status === "failed") {
        return existing;
      }
    }

    const entry: QueueEntry = {
      id,
      payload,
      status: "pending",
      attempts: 0,
      enqueuedAt: Date.now(),
      lastAttemptAt: null,
      retryAfter: null,
      lastError: null,
      conflictDetail: null,
      txHash: null,
      ...(binding ? { binding } : {}),
      heldReason: null,
    };

    state = { ...state, entries: { ...state.entries, [id]: entry } };
    persist(state);
    notify();
    return entry;
  },

  /**
   * Mark an entry as currently being submitted.
   * Returns false if the entry is already in-flight (concurrency guard).
   */
  markSubmitting(id: string): boolean {
    if (inFlightIds.has(id)) return false;
    const entry = state.entries[id];
    if (!entry || entry.status !== "pending") return false;

    inFlightIds.add(id);
    state = {
      ...state,
      entries: {
        ...state.entries,
        [id]: {
          ...entry,
          status: "submitting",
          lastAttemptAt: Date.now(),
          attempts: entry.attempts + 1,
          heldReason: null,
        },
      },
    };
    persist(state);
    notify();
    return true;
  },

  /**
   * Mark an entry as successfully submitted.
   */
  markSubmitted(id: string, txHash: string | null): void {
    const entry = state.entries[id];
    if (!entry || entry.status !== "submitting") return;
    inFlightIds.delete(id);

    state = {
      ...state,
      entries: {
        ...state.entries,
        [id]: {
          ...entry,
          status: "submitted",
          txHash,
          lastError: null,
        },
      },
    };
    persist(state);
    notify();
  },

  /**
   * Mark an entry as failed after a retryable error.
   * Schedules exponential backoff.
   */
  markRetryable(id: string, message: string): void {
    const entry = state.entries[id];
    if (!entry || entry.status !== "submitting") return;
    inFlightIds.delete(id);

    const isPermanentlyFailed = entry.attempts >= MAX_ATTEMPTS;
    const newStatus: SubmissionStatus = isPermanentlyFailed
      ? "failed"
      : "pending";

    state = {
      ...state,
      entries: {
        ...state.entries,
        [id]: {
          ...entry,
          status: newStatus,
          lastError: message,
          retryAfter: isPermanentlyFailed
            ? null
            : computeRetryAfter(entry.attempts),
        },
      },
    };
    persist(state);
    notify();
  },

  /**
   * Mark an entry as permanently failed (non-retryable error).
   */
  markFailed(id: string, message: string): void {
    const entry = state.entries[id];
    if (!entry || (entry.status !== "submitting" && entry.status !== "pending")) return;
    inFlightIds.delete(id);

    state = {
      ...state,
      entries: {
        ...state.entries,
        [id]: {
          ...entry,
          status: "failed",
          lastError: message,
          retryAfter: null,
        },
      },
    };
    persist(state);
    notify();
  },

  /**
   * Mark an entry as a conflict (nullifier already used / vote already recorded).
   * Conflict entries are NOT retried automatically.
   */
  markConflict(id: string, detail: string): void {
    const entry = state.entries[id];
    if (!entry || (entry.status !== "submitting" && entry.status !== "pending")) return;
    inFlightIds.delete(id);

    state = {
      ...state,
      entries: {
        ...state.entries,
        [id]: {
          ...entry,
          status: "conflict",
          conflictDetail: detail,
          lastError: detail,
          retryAfter: null,
        },
      },
    };
    persist(state);
    notify();
  },

  /**
   * Dismiss/remove an entry from the queue UI.
   * Only valid for submitted, failed, or conflict entries.
   */
  dismiss(id: string): void {
    const entry = state.entries[id];
    if (!entry) return;
    if (
      entry.status !== "submitted" &&
      entry.status !== "failed" &&
      entry.status !== "conflict"
    )
      return;

    const updated = { ...state.entries };
    delete updated[id];
    state = { ...state, entries: updated };
    persist(state);
    notify();
  },

  /**
   * Hold a pending entry until its wallet session is back (#750). Does not
   * count as an attempt and sets no backoff: it resumes as soon as the
   * matching account and network reconnect.
   */
  markHeld(id: string, reason: string): void {
    const entry = state.entries[id];
    if (!entry || entry.status !== "pending" || entry.heldReason === reason) return;
    state = {
      ...state,
      entries: { ...state.entries, [id]: { ...entry, heldReason: reason } },
    };
    persist(state);
    notify();
  },

  /**
   * Remove settled entries (submitted / failed / conflict) but keep proofs
   * that have not been sent yet. Used on wallet disconnect: deleting an
   * unsent proof would strand the vote and force a fresh 60 s prove (#750).
   */
  clearSettled(): void {
    const kept: Record<string, QueueEntry> = {};
    for (const [id, entry] of Object.entries(state.entries)) {
      if (entry.status === "pending" || entry.status === "submitting") kept[id] = entry;
    }
    state = { entries: kept };
    if (Object.keys(kept).length === 0) {
      this.clearAll();
      return;
    }
    persist(state);
    notify();
  },

  /**
   * Clear all entries (e.g., on logout).
   */
  clearAll(): void {
    inFlightIds.clear();
    state = { entries: {} };
    lastCommitted = {};
    try {
      if (typeof window !== "undefined") {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // ignore
    }
    notify();
  },

  /**
   * Get all entries eligible for immediate submission:
   * - status is "pending"
   * - retryAfter is null or in the past
   * - not already in-flight
   */
  getPendingEntries(): QueueEntry[] {
    const now = Date.now();
    return Object.values(state.entries).filter(
      (e) =>
        e.status === "pending" &&
        !inFlightIds.has(e.id) &&
        (e.retryAfter === null || e.retryAfter <= now),
    );
  },

  /**
   * Subscribe to queue state changes.
   */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
