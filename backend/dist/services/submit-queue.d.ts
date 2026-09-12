/**
 * Bounded Submission Queue with Backpressure
 *
 * Provides a bounded queue for transaction submissions with:
 * - Maximum queue depth to prevent unbounded memory growth
 * - Cancellable operations for graceful shutdown
 * - Backpressure signals when queue is full
 * - Per-item timeouts to prevent deadlocks
 * - Metrics for monitoring queue health
 */
export interface QueuedSubmission<T> {
    id: string;
    execute: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    enqueuedAt: number;
    timeoutMs: number;
    abortController: AbortController;
}
export interface SubmitQueueConfig {
    maxDepth: number;
    itemTimeoutMs: number;
}
export interface SubmitQueueStats {
    depth: number;
    maxDepth: number;
    totalProcessed: number;
    totalRejected: number;
    totalTimedOut: number;
    isProcessing: boolean;
}
export declare class BoundedSubmitQueue {
    private queue;
    private processing;
    private readonly maxDepth;
    private readonly itemTimeoutMs;
    private totalProcessed;
    private totalRejected;
    private totalTimedOut;
    private shutdownRequested;
    constructor(config: SubmitQueueConfig);
    /**
     * Enqueue a submission task. Returns a promise that resolves when
     * the task completes or rejects if queue is full, timed out, or cancelled.
     */
    enqueue<T>(execute: () => Promise<T>, timeoutMs?: number): Promise<T>;
    /**
     * Process queued submissions sequentially
     */
    private processQueue;
    /**
     * Execute a function with timeout and abort signal support
     */
    private executeWithTimeout;
    /**
     * Get current queue statistics
     */
    getStats(): SubmitQueueStats;
    /**
     * Initiate graceful shutdown - reject new submissions and wait for
     * current queue to drain or timeout
     */
    shutdown(timeoutMs?: number): Promise<boolean>;
    /**
     * Check if queue has capacity for new submissions
     */
    hasCapacity(): boolean;
    /**
     * Get current queue depth
     */
    getDepth(): number;
}
export declare const submitQueue: BoundedSubmitQueue;
//# sourceMappingURL=submit-queue.d.ts.map