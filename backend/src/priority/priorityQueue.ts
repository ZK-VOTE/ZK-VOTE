import {
  PriorityTier,
  TIER_ORDER,
  TIER_SETTINGS,
  type TierSettings,
} from "./priorityConfig.js";

interface QueueItem<T> {
  task: () => Promise<T>;
  route: string;
  enqueuedAt: number;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export interface QueueDepthSnapshot {
  tier: PriorityTier;
  queued: number;
  inFlight: number;
  concurrency: number;
}

export interface PriorityStarvationEvent {
  tier: PriorityTier;
  route: string;
  waitedMs: number;
}

interface PriorityQueueOptions {
  settings?: Readonly<Record<PriorityTier, TierSettings>>;
  starvationThresholdMs?: number;
  onStarvation?: (event: PriorityStarvationEvent) => void;
  /** Called after each drain pass with the current depth of every tier. */
  onDepthChange?: (snapshot: QueueDepthSnapshot[]) => void;
}

export class RequestTimeoutError extends Error {
  constructor(tier: PriorityTier, waitedMs: number) {
    super(`Request in ${tier} queue timed out after ${waitedMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

/**
 * Separate per-tier worker pools reserve capacity for vote submissions. A
 * burst of comments can fill the LOW pool, but can never consume CRITICAL
 * workers or sit ahead of a vote in the same FIFO queue.
 */
export class PriorityQueue {
  private readonly queues: Record<PriorityTier, QueueItem<unknown>[]> = {
    [PriorityTier.CRITICAL]: [],
    [PriorityTier.HIGH]: [],
    [PriorityTier.NORMAL]: [],
    [PriorityTier.LOW]: [],
  };

  private readonly inFlight: Record<PriorityTier, number> = {
    [PriorityTier.CRITICAL]: 0,
    [PriorityTier.HIGH]: 0,
    [PriorityTier.NORMAL]: 0,
    [PriorityTier.LOW]: 0,
  };

  private readonly settings: Readonly<Record<PriorityTier, TierSettings>>;
  private readonly starvationThresholdMs: number;
  private readonly onStarvation?: (event: PriorityStarvationEvent) => void;
  private readonly onDepthChange?: (snapshot: QueueDepthSnapshot[]) => void;

  constructor(options: PriorityQueueOptions = {}) {
    this.settings = options.settings ?? TIER_SETTINGS;
    this.starvationThresholdMs = options.starvationThresholdMs ?? 1_000;
    this.onStarvation = options.onStarvation;
    this.onDepthChange = options.onDepthChange;
  }

  enqueue<T>(
    tier: PriorityTier,
    task: () => Promise<T>,
    route = "unknown",
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queues[tier].push({
        task,
        route,
        enqueuedAt: Date.now(),
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.drain();
    });
  }

  private drain(): void {
    for (const tier of TIER_ORDER) {
      const queue = this.queues[tier];
      const settings = this.settings[tier];

      while (queue.length > 0 && this.inFlight[tier] < settings.concurrency) {
        const item = queue.shift();
        if (!item) break;

        const waitedMs = Date.now() - item.enqueuedAt;
        if (waitedMs > settings.maxQueueWaitMs) {
          item.reject(new RequestTimeoutError(tier, waitedMs));
          continue;
        }
        if (waitedMs >= this.starvationThresholdMs) {
          this.onStarvation?.({ tier, route: item.route, waitedMs });
        }

        this.inFlight[tier] += 1;
        void item
          .task()
          .then(item.resolve, item.reject)
          .finally(() => {
            this.inFlight[tier] -= 1;
            this.drain();
          });
      }
    }

    this.onDepthChange?.(this.getQueueDepths());
  }

  getQueueDepths(): QueueDepthSnapshot[] {
    return TIER_ORDER.map((tier) => ({
      tier,
      queued: this.queues[tier].length,
      inFlight: this.inFlight[tier],
      concurrency: this.settings[tier].concurrency,
    }));
  }
}
