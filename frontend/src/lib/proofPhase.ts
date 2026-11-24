/**
 * Honest phase-based progress model for in-browser proof generation (ZV-057 / #903).
 *
 * Replaces the heuristic `progress` string in VoteModal with a typed state
 * machine whose phases map 1-to-1 to actual work boundaries reported by the
 * prover and submission pipeline. No percentage is surfaced unless the prover
 * itself emits a measured boundary (e.g. artifact download progress); all
 * other phases show elapsed time and an indeterminate indicator only.
 *
 * Phase lifecycle:
 *   idle → preparing → proving → packaging → submitting → confirming → complete
 *                                                                     ↘ failed
 *
 * Persistence: a proof that completes the `proving` phase is retained in the
 * submission queue even if the user cancels or the tab goes hidden. Cancel/retry
 * always preserves the failure reason so the UI can explain what went wrong
 * without asking the user to re-prove.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProofPhaseName =
  | "idle"
  | "preparing"
  | "proving"
  | "packaging"
  | "submitting"
  | "confirming"
  | "complete"
  | "failed";

export interface ProofPhaseState {
  phase: ProofPhaseName;
  /** Wall-clock ms when the current phase started. */
  startedAt: number;
  /** Ms elapsed in the current phase (updated every second). */
  elapsedMs: number;
  /**
   * Download progress 0–100 only during `preparing` when artifact fetch
   * emits real byte counts. Never set for other phases.
   */
  downloadPct?: number;
  /** Set when phase === 'failed'. Preserved across cancel so retry can show it. */
  failureReason?: string;
  /** Number of times the user has retried after a failure. */
  retryCount: number;
  /**
   * True once proving finished and the proof was placed into the submission
   * queue. Informs the cancel/retry UI that no re-prove is needed.
   */
  proofRetained: boolean;
}

// ---------------------------------------------------------------------------
// Labels (used by both UI and aria-live announcements)
// ---------------------------------------------------------------------------

const PHASE_LABELS: Record<ProofPhaseName, string> = {
  idle: "Ready",
  preparing: "Preparing",
  proving: "Generating proof",
  packaging: "Packaging",
  submitting: "Submitting",
  confirming: "Confirming",
  complete: "Complete",
  failed: "Failed",
};

const PHASE_DESCRIPTIONS: Record<ProofPhaseName, string> = {
  idle: "",
  preparing: "Loading voting credentials and downloading circuit artifacts.",
  proving:
    "Generating your zero-knowledge proof in a private worker. This can take up to a minute.",
  packaging: "Formatting the proof for on-chain verification.",
  submitting: "Sending your anonymous vote through the relay.",
  confirming: "Waiting for the relay to confirm your vote was accepted.",
  complete: "Your vote has been recorded on-chain.",
  failed: "An error occurred.",
};

export function phaseLabel(phase: ProofPhaseName): string {
  return PHASE_LABELS[phase];
}

export function phaseDescription(phase: ProofPhaseName): string {
  return PHASE_DESCRIPTIONS[phase];
}

/** Phases during which proving work is actively running. */
export const ACTIVE_PHASES: Set<ProofPhaseName> = new Set([
  "preparing",
  "proving",
  "packaging",
  "submitting",
  "confirming",
]);

/** Phases during which cancel is meaningful (before the proof lands on-chain). */
export const CANCELABLE_PHASES: Set<ProofPhaseName> = new Set([
  "preparing",
  "proving",
  "packaging",
]);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const INITIAL_STATE: ProofPhaseState = {
  phase: "idle",
  startedAt: 0,
  elapsedMs: 0,
  retryCount: 0,
  proofRetained: false,
};

export interface UseProofPhaseReturn {
  state: ProofPhaseState;
  /** Advance to the next named phase. Resets elapsedMs and sets startedAt. */
  advance: (phase: ProofPhaseName, opts?: { downloadPct?: number }) => void;
  /** Mark the flow as failed with a reason. Preserves proofRetained. */
  fail: (reason: string) => void;
  /** Mark proving done and proof queued. Sets proofRetained = true. */
  markProofRetained: () => void;
  /** Set download percentage during the preparing phase only. */
  setDownloadPct: (pct: number) => void;
  /** Reset to idle for a fresh attempt (increments retryCount). */
  retry: () => void;
  /** Reset fully back to idle (retryCount = 0). */
  reset: () => void;
  /** Abort signal — cancelled when the user explicitly cancels or component unmounts. */
  cancelSignal: AbortSignal;
}

export function useProofPhase(): UseProofPhaseReturn {
  const [state, setState] = useState<ProofPhaseState>(INITIAL_STATE);
  const abortRef = useRef<AbortController>(new AbortController());
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep a stable ref to startedAt for the interval closure.
  const startedAtRef = useRef<number>(0);

  const clearTick = () => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  };

  // Start or restart the 1-second elapsed-time ticker.
  const startTick = useCallback((startedAt: number) => {
    clearTick();
    startedAtRef.current = startedAt;
    tickRef.current = setInterval(() => {
      setState((prev) => ({
        ...prev,
        elapsedMs: Date.now() - startedAtRef.current,
      }));
    }, 1000);
  }, []);

  const advance = useCallback(
    (phase: ProofPhaseName, opts?: { downloadPct?: number }) => {
      const now = Date.now();
      if (ACTIVE_PHASES.has(phase)) {
        startTick(now);
      } else {
        clearTick();
      }
      setState((prev) => ({
        ...prev,
        phase,
        startedAt: now,
        elapsedMs: 0,
        downloadPct: opts?.downloadPct,
      }));
    },
    [startTick],
  );

  const fail = useCallback((reason: string) => {
    clearTick();
    setState((prev) => ({
      ...prev,
      phase: "failed",
      elapsedMs: Date.now() - prev.startedAt,
      failureReason: reason,
    }));
  }, []);

  const markProofRetained = useCallback(() => {
    setState((prev) => ({ ...prev, proofRetained: true }));
  }, []);

  const setDownloadPct = useCallback((pct: number) => {
    setState((prev) =>
      prev.phase === "preparing" ? { ...prev, downloadPct: pct } : prev,
    );
  }, []);

  const retry = useCallback(() => {
    // Fresh abort controller for the new attempt.
    abortRef.current.abort();
    abortRef.current = new AbortController();
    clearTick();
    setState((prev) => ({
      ...INITIAL_STATE,
      retryCount: prev.retryCount + 1,
      // Preserve failure reason so the UI can show "Previous attempt failed: …"
      failureReason: prev.failureReason,
    }));
  }, []);

  const reset = useCallback(() => {
    abortRef.current.abort();
    abortRef.current = new AbortController();
    clearTick();
    setState(INITIAL_STATE);
  }, []);

  // Cleanup on unmount.
  useEffect(
    () => () => {
      clearTick();
      abortRef.current.abort();
    },
    [],
  );

  return {
    state,
    advance,
    fail,
    markProofRetained,
    setDownloadPct,
    retry,
    reset,
    cancelSignal: abortRef.current.signal,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format elapsed seconds as "1s", "1m 02s" etc. */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
