/**
 * useSubmissionQueue – React hook for the offline submission queue.
 *
 * Provides:
 * - Reactive access to queue state (pending, submitted, conflict entries)
 * - Helper to enqueue a vote (deduplication built-in)
 * - Online/offline status (combined browser signal + relayer reachability)
 * - Conflict summary for displaying in the UI
 *
 * Usage:
 *   const { isOnline, pendingCount, conflicts, enqueueVote } = useSubmissionQueue();
 */

import { useState, useEffect, useCallback } from "react";
import {
  submissionQueue,
  type QueueEntry,
  type VotePayload,
} from "../store/submissionQueue";
import {
  startProcessor,
  stopProcessor,
  processQueue,
} from "../lib/queueProcessor";

export interface SubmissionQueueHookResult {
  /** Browser reports being online */
  isOnline: boolean;
  /** Number of entries still pending / retrying */
  pendingCount: number;
  /** Number of entries that successfully submitted */
  submittedCount: number;
  /** Entries that encountered a conflict */
  conflicts: QueueEntry[];
  /** Entries that permanently failed */
  failures: QueueEntry[];
  /** All entries in the queue (useful for debugging / admin views) */
  allEntries: QueueEntry[];
  /**
   * Enqueue a vote payload.
   * Returns the queue entry (possibly pre-existing if the nullifier was
   * already queued).
   */
  enqueueVote(payload: VotePayload): QueueEntry;
  /**
   * Manually trigger queue processing (e.g., after detecting connectivity).
   */
  triggerProcess(): void;
  /**
   * Dismiss a resolved entry (submitted / failed / conflict).
   */
  dismissEntry(id: string): void;
}

export function useSubmissionQueue(): SubmissionQueueHookResult {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [queueState, setQueueState] = useState(() =>
    submissionQueue.getState(),
  );

  // Subscribe to queue state
  useEffect(() => {
    const unsubscribe = submissionQueue.subscribe(() => {
      setQueueState(submissionQueue.getState());
    });
    return unsubscribe;
  }, []);

  // Track browser online/offline events
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      // Trigger queue processing when we come back online
      void processQueue();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Start/stop the background processor
  useEffect(() => {
    // Initialize queue from localStorage on first mount
    submissionQueue.initialize();
    startProcessor();

    return () => {
      stopProcessor();
    };
  }, []);

  const entries = Object.values(queueState.entries);

  const pendingCount = entries.filter(
    (e) => e.status === "pending" || e.status === "submitting",
  ).length;

  const submittedCount = entries.filter(
    (e) => e.status === "submitted",
  ).length;

  const conflicts = entries.filter((e) => e.status === "conflict");

  const failures = entries.filter((e) => e.status === "failed");

  const enqueueVote = useCallback((payload: VotePayload): QueueEntry => {
    return submissionQueue.enqueue(payload);
  }, []);

  const triggerProcess = useCallback(() => {
    void processQueue();
  }, []);

  const dismissEntry = useCallback((id: string) => {
    submissionQueue.dismiss(id);
  }, []);

  return {
    isOnline,
    pendingCount,
    submittedCount,
    conflicts,
    failures,
    allEntries: entries,
    enqueueVote,
    triggerProcess,
    dismissEntry,
  };
}
