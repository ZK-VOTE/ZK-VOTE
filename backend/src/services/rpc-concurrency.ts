/**
 * RPC Concurrency Limiter
 *
 * Provides concurrency control for RPC requests to prevent overwhelming
 * the RPC server and causing resource exhaustion.
 */

import { log } from "./logger.js";
import { config } from "../config.js";
import { Gauge, Counter, Histogram, register } from "prom-client";

// ============================================
// METRICS
// ============================================

const rpcConcurrentRequests = new Gauge({
  name: "zkvote_rpc_concurrent_requests",
  help: "Current number of concurrent RPC requests",
  registers: [register],
});

const rpcQueuedRequests = new Gauge({
  name: "zkvote_rpc_queued_requests",
  help: "Current number of RPC requests waiting for a slot",
  registers: [register],
});

const rpcRejectedRequests = new Counter({
  name: "zkvote_rpc_rejected_requests_total",
  help: "Total number of RPC requests rejected due to queue full",
  registers: [register],
});

const rpcQueueWaitTime = new Histogram({
  name: "zkvote_rpc_queue_wait_time_seconds",
  help: "Time spent waiting for RPC concurrency slot",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// ============================================
// TYPES
// ============================================

interface QueuedRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

// ============================================
// RPC CONCURRENCY LIMITER
// ============================================

export class RpcConcurrencyLimiter {
  private activeRequests = 0;
  private readonly maxConcurrent: number;
  private readonly queue: QueuedRequest[] = [];
  private readonly maxQueueSize: number;

  constructor(maxConcurrent: number, maxQueueSize: number = 1000) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueueSize = maxQueueSize;
  }

  /**
   * Acquire a concurrency slot. Returns a release function that must be
   * called when the RPC request completes.
   */
  async acquire(): Promise<() => void> {
    if (this.activeRequests < this.maxConcurrent) {
      this.activeRequests++;
      rpcConcurrentRequests.set(this.activeRequests);
      return () => this.release();
    }

    // Need to wait in queue
    if (this.queue.length >= this.maxQueueSize) {
      rpcRejectedRequests.inc();
      log("warn", "rpc_concurrency_queue_full", {
        queueSize: this.queue.length,
        maxQueueSize: this.maxQueueSize,
        activeRequests: this.activeRequests,
      });
      throw new Error("RPC_CONCURRENCY_QUEUE_FULL");
    }

    return new Promise<() => void>((resolve, reject) => {
      this.queue.push({
        resolve: () => {
          this.activeRequests++;
          rpcConcurrentRequests.set(this.activeRequests);
          resolve(() => this.release());
        },
        reject,
        enqueuedAt: Date.now(),
      });
      rpcQueuedRequests.set(this.queue.length);
    });
  }

  /**
   * Release a concurrency slot and process next queued request
   */
  private release(): void {
    this.activeRequests--;
    rpcConcurrentRequests.set(this.activeRequests);

    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      rpcQueuedRequests.set(this.queue.length);

      const waitTimeMs = Date.now() - next.enqueuedAt;
      rpcQueueWaitTime.observe(waitTimeMs / 1000);

      next.resolve();
    }
  }

  /**
   * Get current stats
   */
  getStats(): {
    activeRequests: number;
    queuedRequests: number;
    maxConcurrent: number;
  } {
    return {
      activeRequests: this.activeRequests,
      queuedRequests: this.queue.length,
      maxConcurrent: this.maxConcurrent,
    };
  }

  /**
   * Clear all queued requests (for shutdown)
   */
  clearQueue(): void {
    for (const req of this.queue) {
      req.reject(new Error("RPC concurrency limiter shutdown"));
    }
    this.queue.length = 0;
    rpcQueuedRequests.set(0);
  }
}

// ============================================
// GLOBAL INSTANCE
// ============================================

export const rpcConcurrencyLimiter = new RpcConcurrencyLimiter(
  config.rpcMaxConcurrentRequests || 10,
  1000, // Max queue size
);

/**
 * Execute an RPC call with concurrency limiting
 */
export async function withRpcConcurrency<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const release = await rpcConcurrencyLimiter.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
