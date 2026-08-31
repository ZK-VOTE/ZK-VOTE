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

import { log } from "./logger.js";
import { config } from "../config.js";
import {
  Gauge,
  Counter,
  Histogram,
  register,
} from "prom-client";

// ============================================
// METRICS
// ============================================

const submitQueueDepth = new Gauge({
  name: "zkvote_submit_queue_depth",
  help: "Current number of submissions waiting in queue",
  registers: [register],
});

const submitQueueRejections = new Counter({
  name: "zkvote_submit_queue_rejections_total",
  help: "Total number of submissions rejected due to queue full",
  registers: [register],
});

const submitQueueTimeouts = new Counter({
  name: "zkvote_submit_queue_timeouts_total",
  help: "Total number of submissions that timed out in queue",
  registers: [register],
});

const submitQueueWaitTime = new Histogram({
  name: "zkvote_submit_queue_wait_time_seconds",
  help: "Time spent waiting in queue before execution",
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

const submitQueueProcessingTime = new Histogram({
  name: "zkvote_submit_queue_processing_time_seconds",
  help: "Time spent processing submission (includes transaction)",
  buckets: [1, 2, 5, 10, 30, 60, 120],
  registers: [register],
});

// ============================================
// TYPES
// ============================================

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

// ============================================
// BOUNDED SUBMIT QUEUE
// ============================================

export class BoundedSubmitQueue {
  private queue: Array<QueuedSubmission<any>> = [];
  private processing = false;
  private readonly maxDepth: number;
  private readonly itemTimeoutMs: number;
  private totalProcessed = 0;
  private totalRejected = 0;
  private totalTimedOut = 0;
  private shutdownRequested = false;

  constructor(config: SubmitQueueConfig) {
    this.maxDepth = config.maxDepth;
    this.itemTimeoutMs = config.itemTimeoutMs;
  }

  /**
   * Enqueue a submission task. Returns a promise that resolves when
   * the task completes or rejects if queue is full, timed out, or cancelled.
   */
  async enqueue<T>(
    execute: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    if (this.shutdownRequested) {
      throw new Error("Submit queue is shutting down");
    }

    // Check queue depth - apply backpressure
    if (this.queue.length >= this.maxDepth) {
      this.totalRejected++;
      submitQueueRejections.inc();
      log("warn", "submit_queue_full", {
        depth: this.queue.length,
        maxDepth: this.maxDepth,
      });
      throw new Error("SUBMIT_QUEUE_FULL");
    }

    return new Promise<T>((resolve, reject) => {
      const id = `sq_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const abortController = new AbortController();

      const submission: QueuedSubmission<T> = {
        id,
        execute,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        timeoutMs: timeoutMs ?? this.itemTimeoutMs,
        abortController,
      };

      this.queue.push(submission);
      submitQueueDepth.set(this.queue.length);

      log("debug", "submit_queued", {
        id,
        depth: this.queue.length,
        maxDepth: this.maxDepth,
      });

      // Start processing if not already running
      if (!this.processing) {
        void this.processQueue();
      }
    });
  }

  /**
   * Process queued submissions sequentially
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0 && !this.shutdownRequested) {
        const submission = this.queue.shift()!;
        submitQueueDepth.set(this.queue.length);

        const waitTimeMs = Date.now() - submission.enqueuedAt;
        submitQueueWaitTime.observe(waitTimeMs / 1000);

        // Check if already timed out while waiting
        if (waitTimeMs > submission.timeoutMs) {
          this.totalTimedOut++;
          submitQueueTimeouts.inc();
          log("warn", "submit_queue_timeout", {
            id: submission.id,
            waitTimeMs,
            timeoutMs: submission.timeoutMs,
          });
          submission.reject(new Error("SUBMIT_QUEUE_TIMEOUT"));
          continue;
        }

        // Execute with timeout
        const processStart = Date.now();
        try {
          const remainingTimeoutMs = submission.timeoutMs - waitTimeMs;
          const result = await this.executeWithTimeout(
            submission.execute,
            remainingTimeoutMs,
            submission.abortController.signal,
          );
          
          const processingTimeMs = Date.now() - processStart;
          submitQueueProcessingTime.observe(processingTimeMs / 1000);
          
          this.totalProcessed++;
          submission.resolve(result);
          
          log("debug", "submit_processed", {
            id: submission.id,
            waitTimeMs,
            processingTimeMs,
          });
        } catch (err) {
          const processingTimeMs = Date.now() - processStart;
          submitQueueProcessingTime.observe(processingTimeMs / 1000);
          
          log("error", "submit_processing_error", {
            id: submission.id,
            error: (err as Error).message,
            processingTimeMs,
          });
          submission.reject(err as Error);
        }
      }
    } finally {
      this.processing = false;
      
      // If more items were added while we were finishing, restart
      if (this.queue.length > 0 && !this.shutdownRequested) {
        void this.processQueue();
      }
    }
  }

  /**
   * Execute a function with timeout and abort signal support
   */
  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Submission timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new Error("Submission cancelled"));
      }
      signal.addEventListener("abort", () => {
        reject(new Error("Submission cancelled"));
      });
    });

    try {
      return await Promise.race([fn(), timeout, abortPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Get current queue statistics
   */
  getStats(): SubmitQueueStats {
    return {
      depth: this.queue.length,
      maxDepth: this.maxDepth,
      totalProcessed: this.totalProcessed,
      totalRejected: this.totalRejected,
      totalTimedOut: this.totalTimedOut,
      isProcessing: this.processing,
    };
  }

  /**
   * Initiate graceful shutdown - reject new submissions and wait for
   * current queue to drain or timeout
   */
  async shutdown(timeoutMs: number = 30000): Promise<boolean> {
    this.shutdownRequested = true;
    log("info", "submit_queue_shutdown_requested", {
      depth: this.queue.length,
      timeoutMs,
    });

    const deadline = Date.now() + timeoutMs;
    while (this.queue.length > 0 || this.processing) {
      if (Date.now() >= deadline) {
        log("warn", "submit_queue_shutdown_timeout", {
          remainingDepth: this.queue.length,
          stillProcessing: this.processing,
        });
        
        // Cancel remaining items
        for (const item of this.queue) {
          item.abortController.abort();
          item.reject(new Error("Shutdown timeout"));
        }
        this.queue = [];
        submitQueueDepth.set(0);
        
        return false;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    log("info", "submit_queue_shutdown_complete", {
      totalProcessed: this.totalProcessed,
      totalRejected: this.totalRejected,
      totalTimedOut: this.totalTimedOut,
    });

    return true;
  }

  /**
   * Check if queue has capacity for new submissions
   */
  hasCapacity(): boolean {
    return this.queue.length < this.maxDepth && !this.shutdownRequested;
  }

  /**
   * Get current queue depth
   */
  getDepth(): number {
    return this.queue.length;
  }
}

// ============================================
// GLOBAL INSTANCE
// ============================================

export const submitQueue = new BoundedSubmitQueue({
  maxDepth: config.submitQueueMaxDepth || 100,
  itemTimeoutMs: config.submitQueueItemTimeoutMs || 120000, // 2 minutes
});
