/**
 * priorityQueue.ts
 * -----------------------------------------------------------------------
 * In-process priority queue that guarantees CRITICAL-tier work (vote
 * submissions) is scheduled ahead of and never blocked by lower tiers,
 * while still processing lower tiers concurrently up to their own
 * concurrency caps (so LOW-tier traffic isn't starved indefinitely --
 * it just never preempts CRITICAL capacity).
 *
 * This is the "request queue with priority levels" + "worker allocation
 * by priority" acceptance criteria from issue #188, implemented at the
 * application layer. It complements (does not replace) infra-level
 * separation such as Fly.io process groups routing by path, which is
 * called out as a follow-up in docs/PRIORITY_MODEL.md.
 * -----------------------------------------------------------------------
 */

import { PriorityTier, TIER_ORDER, TIER_SETTINGS } from "./priorityConfig";

interface QueueItem<T> {
  tier: PriorityTier;
  task: () => Promise<T>;
  enqueuedAt: number;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export interface QueueDepthSnapshot {
  tier: PriorityTier;
  queued: number;
  inFlight: number;
  concurrency: number;
}

export class RequestTimeoutError extends Error {
  constructor(tier: PriorityTier, waitedMs: number) {
    super(`Request in ${tier} queue exceeded max wait of ${waitedMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

export class PriorityQueue {
  private queues: Record<PriorityTier, QueueItem<any>[]> = {
    [PriorityTier.CRITICAL]: [],
    [PriorityTier.HIGH]: [],
    [PriorityTier.MEDIUM]: [],
    [PriorityTier.LOW]: [],
  };

  private inFlight: Record<PriorityTier, number> = {
    [PriorityTier.CRITICAL]: 0,
    [PriorityTier.HIGH]: 0,
    [PriorityTier.MEDIUM]: 0,
    [PriorityTier.LOW]: 0,
  };

  /** Enqueue a unit of work for a given tier and return its eventual result. */
  enqueue<T>(tier: PriorityTier, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = { tier, task, enqueuedAt: Date.now(), resolve, reject };
      this.queues[tier].push(item);
      this.drain();
    });
  }

  /** Attempts to start as much queued work as current concurrency caps allow. */
  private drain(): void {
    // Always evaluate tiers in priority order so CRITICAL capacity is
    // claimed first on every drain pass.
    for (const tier of TIER_ORDER) {
      const settings = TIER_SETTINGS[tier];
      const queue = this.queues[tier];

      while (queue.length > 0 && this.inFlight[tier] < settings.concurrency) {
        const item = queue.shift()!;
        const waited = Date.now() - item.enqueuedAt;

        if (waited > settings.maxQueueWaitMs) {
          item.reject(new RequestTimeoutError(tier, waited));
          continue;
        }

        this.inFlight[tier]++;
        item
          .task()
          .then((result) => item.resolve(result))
          .catch((err) => item.reject(err))
          .finally(() => {
            this.inFlight[tier]--;
            this.drain();
          });
      }
    }
  }

  getQueueDepths(): QueueDepthSnapshot[] {
    return TIER_ORDER.map((tier) => ({
      tier,
      queued: this.queues[tier].length,
      inFlight: this.inFlight[tier],
      concurrency: TIER_SETTINGS[tier].concurrency,
    }));
  }
}

/** Singleton shared across the Express app. */
export const globalPriorityQueue = new PriorityQueue();
