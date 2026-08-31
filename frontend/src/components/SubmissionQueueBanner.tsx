/**
 * SubmissionQueueBanner
 *
 * Displays queue status banners:
 * - Offline / pending submission indicator
 * - Conflict notifications (vote already cast / nullifier already used)
 * - Permanent failure notifications
 *
 * Follows the existing UI patterns in the codebase:
 * - ServiceDegradationBanner.tsx styling
 * - Alert component from ui/Alert.tsx
 * - Lucide icons
 */

import { AlertTriangle, CheckCircle, Wifi, WifiOff, XCircle, X } from "lucide-react";
import { useSubmissionQueue } from "../hooks/useSubmissionQueue";
import type { QueueEntry } from "../store/submissionQueue";

// ============================================================
// Individual conflict/failure card
// ============================================================

interface EntryCardProps {
  entry: QueueEntry;
  onDismiss: (id: string) => void;
}

function ConflictCard({ entry, onDismiss }: EntryCardProps) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-start gap-3 rounded-lg border border-yellow-500/30 bg-yellow-50 dark:bg-yellow-900/20 px-4 py-3 text-sm"
    >
      <AlertTriangle
        className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600 dark:text-yellow-400"
        aria-hidden="true"
      />
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-yellow-800 dark:text-yellow-300">
          Vote Already Recorded
        </p>
        <p className="mt-0.5 text-yellow-700 dark:text-yellow-400">
          {entry.conflictDetail
            ? entry.conflictDetail
            : "This vote has already been recorded on the blockchain. Each member can only vote once per proposal."}
        </p>
        <p className="mt-1 text-xs text-yellow-600/70 dark:text-yellow-500/70">
          Proposal #{entry.payload.proposalId} · DAO #{entry.payload.daoId}
        </p>
      </div>
      <button
        onClick={() => onDismiss(entry.id)}
        aria-label="Dismiss conflict notification"
        className="shrink-0 rounded-md p-1 text-yellow-600 hover:bg-yellow-100 dark:text-yellow-400 dark:hover:bg-yellow-800/40 transition-colors"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function FailureCard({ entry, onDismiss }: EntryCardProps) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm"
    >
      <XCircle
        className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400"
        aria-hidden="true"
      />
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-red-800 dark:text-red-300">
          Vote Submission Failed
        </p>
        <p className="mt-0.5 text-red-700 dark:text-red-400">
          {entry.lastError ||
            "The vote could not be submitted. Please try again or contact support."}
        </p>
        <p className="mt-1 text-xs text-red-600/70 dark:text-red-500/70">
          Proposal #{entry.payload.proposalId} · {entry.attempts} attempt
          {entry.attempts !== 1 ? "s" : ""}
        </p>
      </div>
      <button
        onClick={() => onDismiss(entry.id)}
        aria-label="Dismiss failure notification"
        className="shrink-0 rounded-md p-1 text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-800/40 transition-colors"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

// ============================================================
// Main banner
// ============================================================

/**
 * SubmissionQueueBanner renders status banners for the offline queue.
 *
 * Place this near the top of the layout (e.g., below the Navbar) so it
 * is visible across all pages.
 */
export function SubmissionQueueBanner() {
  const {
    isOnline,
    pendingCount,
    conflicts,
    failures,
    dismissEntry,
  } = useSubmissionQueue();

  const hasBanners =
    !isOnline || pendingCount > 0 || conflicts.length > 0 || failures.length > 0;

  if (!hasBanners) return null;

  return (
    <div
      className="w-full space-y-2 px-4 py-2"
      role="region"
      aria-label="Vote submission status"
    >
      {/* Offline / pending indicator */}
      {(!isOnline || pendingCount > 0) && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 rounded-lg border border-blue-500/30 bg-blue-50 dark:bg-blue-900/20 px-4 py-3 text-sm"
        >
          {isOnline ? (
            <Wifi
              className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
              aria-hidden="true"
            />
          ) : (
            <WifiOff
              className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400"
              aria-hidden="true"
            />
          )}
          <div className="flex-1 min-w-0">
            {!isOnline ? (
              <>
                <span className="font-semibold text-blue-800 dark:text-blue-300">
                  You are offline.
                </span>{" "}
                <span className="text-blue-700 dark:text-blue-400">
                  {pendingCount > 0
                    ? `${pendingCount} vote${pendingCount !== 1 ? "s" : ""} will be submitted automatically when you reconnect.`
                    : "Your vote will be queued and submitted when connectivity is restored."}
                </span>
              </>
            ) : pendingCount > 0 ? (
              <>
                <span className="text-blue-700 dark:text-blue-400 flex items-center gap-1">
                  <CheckCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Submitting {pendingCount} queued vote
                  {pendingCount !== 1 ? "s" : ""}…
                </span>
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* Conflict notifications */}
      {conflicts.map((entry) => (
        <ConflictCard key={entry.id} entry={entry} onDismiss={dismissEntry} />
      ))}

      {/* Permanent failure notifications */}
      {failures.map((entry) => (
        <FailureCard key={entry.id} entry={entry} onDismiss={dismissEntry} />
      ))}
    </div>
  );
}

export default SubmissionQueueBanner;
