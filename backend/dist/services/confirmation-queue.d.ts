/**
 * Transaction Confirmation Queue (#172)
 *
 * Replaces the per-request polling loop that `waitForTransaction` used to run.
 * Every confirmation wait is enqueued here and processed by a single dedicated
 * worker, which polls Soroban `getTransaction` with exponential backoff +
 * jitter. Benefits:
 *
 *  - Multiple concurrent waiters for the same hash share one poller (coalescing).
 *  - Poll cadence starts at ~2s (one Stellar ledger close) and backs off on
 *    congestion, so rapid confirmations are caught early without wasting RPC
 *    calls while the network is slow.
 *  - A hard wall-clock deadline (`maxWaitMs`) bounds every wait; transactions
 *    that never confirm are marked EXPIRED ("too late to confirm").
 *  - Resolved outcomes are cached briefly so the status endpoint and repeat
 *    callers see the result without re-polling.
 *  - Confirmation times and attempt counts feed Prometheus metrics, and every
 *    resolution is broadcast to connected frontends over WebSocket.
 *
 * Backward compatibility: `waitForTransaction(hash, maxAttempts)` still works;
 * a numeric second argument is treated as a cap on the number of polls.
 */
import type * as StellarSdk from "@stellar/stellar-sdk";
export type ConfirmationState = "PENDING" | "CONFIRMED" | "FAILED" | "EXPIRED" | "UNKNOWN";
export interface WaitForTransactionOptions {
    /** Hard wall-clock deadline for confirmation, in ms. */
    maxWaitMs?: number;
    /** Cap on the number of getTransaction polls (attempt 0 is the first). */
    maxAttempts?: number;
    /** Delay before the first retry after a NOT_FOUND, in ms. */
    initialDelayMs?: number;
    /** Upper bound on each per-poll backoff delay, in ms. */
    maxDelayMs?: number;
    /** Multiplier applied to the delay after each NOT_FOUND. */
    backoffFactor?: number;
    /** Apply equal jitter to each delay (defaults to config). */
    jitter?: boolean;
    /** Called with each poll result, including intermediate NOT_FOUNDs. */
    onStatus?: (status: ConfirmationStatus) => void;
}
export interface ConfirmationStatus {
    hash: string;
    state: ConfirmationState;
    /** Raw Stellar `getTransaction` status (SUCCESS/FAILED/NOT_FOUND). */
    status?: string;
    attempts: number;
    elapsedMs: number;
    result?: StellarSdk.rpc.Api.GetTransactionResponse;
    error?: string;
    enqueuedAt?: string;
    confirmedAt?: string;
}
/**
 * Thrown when a transaction does not confirm within its wait budget.
 * `state` is always "EXPIRED": a NOT_FOUND that persists past the deadline is
 * treated as too late to confirm (the transaction is no longer in the ledger's
 * inclusion window and will never be found).
 */
export declare class TransactionConfirmationTimeoutError extends Error {
    readonly hash: string;
    readonly waitedMs: number;
    readonly attempts: number;
    readonly state: ConfirmationState;
    constructor(hash: string, waitedMs: number, attempts: number);
}
/**
 * Wait for a transaction to confirm.
 *
 * Enqueues the hash on the shared confirmation queue (coalescing concurrent
 * waiters) and resolves with the first non-NOT_FOUND `getTransaction` result,
 * or rejects with `TransactionConfirmationTimeoutError` if the transaction
 * never confirms within the wait budget.
 *
 * @param hash Stellar transaction hash
 * @param maxAttemptsOrOptions legacy numeric poll cap, or full options
 */
export declare function waitForTransaction(hash: string, maxAttemptsOrOptions?: number | WaitForTransactionOptions): Promise<StellarSdk.rpc.Api.GetTransactionResponse>;
/**
 * Resolve the current confirmation status of a hash without blocking.
 * Used by the `GET /tx/:hash` endpoint as a polling fallback for frontends
 * that cannot (or choose not to) use the WebSocket feed.
 */
export declare function getConfirmationStatus(hash: string): Promise<ConfirmationStatus>;
export declare function getConfirmationQueueStats(): {
    running: boolean;
    pending: number;
    cached: number;
};
/**
 * Start the dedicated confirmation worker. Idempotent. Also started lazily on
 * the first enqueue so tests and early callers don't need explicit setup.
 */
export declare function startConfirmationWorker(): void;
/**
 * Stop the worker and reject any still-pending waiters so callers never hang
 * on shutdown. Idempotent.
 */
export declare function stopConfirmationWorker(): Promise<void>;
//# sourceMappingURL=confirmation-queue.d.ts.map