/**
 * Cancellable, back-pressuring scheduler for the indexer watermark loop (#323).
 *
 * Three properties this guarantees, in order of importance:
 *
 *  1. **Single flight.** A timer fires on a fixed cadence independently of the
 *     active poll. A tick that arrives while the previous cycle is still
 *     running is counted as an overrun and dropped — cycles never overlap, so
 *     two pollers can never race the same ledger range.
 *  2. **Clean cancellation.** `stop()` clears the timer, aborts the in-flight
 *     cycle through its `AbortSignal`, and resolves only once that cycle has
 *     settled. No work outlives the call.
 *  3. **Backpressure.** Repeated overruns mean the source is producing faster
 *     than the pipeline drains. Rather than queueing ticks that will only be
 *     dropped, the scheduler widens its own interval, and narrows it again once
 *     cycles finish on time. An optional downstream depth probe sheds ticks
 *     outright while a queue is saturated, which is what keeps RSS bounded on
 *     a long soak.
 */

export interface SchedulerClock {
  now(): number;
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

/**
 * Why a tick did not start a cycle.
 *
 * - `in_flight`  — the previous cycle was still running
 * - `queue_full` — the downstream depth probe was at or over its ceiling
 * - `late`       — the timer fired after one or more whole intervals had passed
 */
export type OverrunReason = "in_flight" | "queue_full" | "late";

/** Observable counters describing how the loop is coping with its load. */
export interface SchedulerStats {
  cyclesStarted: number;
  cyclesCompleted: number;
  cyclesFailed: number;
  /** Ticks dropped because a cycle was still running or a queue was full. */
  skippedPolls: number;
  /** Ticks dropped specifically by the downstream depth probe. */
  shedPolls: number;
  consecutiveOverruns: number;
  /** 0 = nominal; each level multiplies the interval by `backpressureFactor`. */
  backpressureLevel: number;
  currentIntervalMs: number;
}

export interface WatermarkSchedulerOptions {
  intervalMs: number;
  runCycle: (signal: AbortSignal) => Promise<void>;
  onOverrun?: (skippedPolls: number, reason: OverrunReason) => void;
  onError?: (error: Error) => void;
  clock?: SchedulerClock;

  /**
   * Consecutive overruns tolerated before the interval widens. One overrun is
   * usually a slow ledger range, not a trend, so the default waits for two.
   */
  maxConsecutiveOverruns?: number;
  /** Interval multiplier applied per backpressure level. */
  backpressureFactor?: number;
  /** Ceiling on the widened interval. */
  maxIntervalMs?: number;
  /** On-time cycles required to step one backpressure level back down. */
  recoveryCycles?: number;
  /**
   * Depth of the work queue this loop feeds. When it reports at or above
   * `maxQueueDepth` the tick is shed before a cycle starts.
   */
  getQueueDepth?: () => number;
  maxQueueDepth?: number;
  /** Notified whenever the backpressure level changes. */
  onBackpressure?: (stats: SchedulerStats) => void;
}

const systemClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

const DEFAULT_MAX_CONSECUTIVE_OVERRUNS = 2;
const DEFAULT_BACKPRESSURE_FACTOR = 2;
const DEFAULT_RECOVERY_CYCLES = 3;
const DEFAULT_MAX_BACKPRESSURE_LEVEL = 5;

export class WatermarkScheduler {
  private readonly baseIntervalMs: number;
  private readonly runCycle: (signal: AbortSignal) => Promise<void>;
  private readonly onOverrun: (
    skippedPolls: number,
    reason: OverrunReason,
  ) => void;
  private readonly onError: (error: Error) => void;
  private readonly onBackpressure: (stats: SchedulerStats) => void;
  private readonly clock: SchedulerClock;

  private readonly maxConsecutiveOverruns: number;
  private readonly backpressureFactor: number;
  private readonly maxIntervalMs: number;
  private readonly recoveryCycles: number;
  private readonly getQueueDepth: (() => number) | null;
  private readonly maxQueueDepth: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeCycle: Promise<void> | null = null;
  private activeController: AbortController | null = null;
  private nextRunAt = 0;
  private started = false;

  private cyclesStarted = 0;
  private cyclesCompleted = 0;
  private cyclesFailed = 0;
  private skippedPolls = 0;
  private shedPolls = 0;
  private consecutiveOverruns = 0;
  private consecutiveOnTime = 0;
  private backpressureLevel = 0;

  constructor(options: WatermarkSchedulerOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("Indexer poll interval must be greater than zero");
    }

    this.baseIntervalMs = options.intervalMs;
    this.runCycle = options.runCycle;
    this.onOverrun = options.onOverrun ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.onBackpressure = options.onBackpressure ?? (() => undefined);
    this.clock = options.clock ?? systemClock;

    this.maxConsecutiveOverruns =
      options.maxConsecutiveOverruns ?? DEFAULT_MAX_CONSECUTIVE_OVERRUNS;
    this.backpressureFactor =
      options.backpressureFactor ?? DEFAULT_BACKPRESSURE_FACTOR;
    this.maxIntervalMs =
      options.maxIntervalMs ??
      options.intervalMs *
        this.backpressureFactor ** DEFAULT_MAX_BACKPRESSURE_LEVEL;
    this.recoveryCycles = options.recoveryCycles ?? DEFAULT_RECOVERY_CYCLES;
    this.getQueueDepth = options.getQueueDepth ?? null;
    this.maxQueueDepth = options.maxQueueDepth ?? Number.POSITIVE_INFINITY;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.nextRunAt = this.clock.now() + this.currentIntervalMs;
    this.scheduleNext();
  }

  /**
   * Stop the loop and wait for the in-flight cycle to unwind.
   *
   * Idempotent: calling it twice, or after a cycle already settled, resolves
   * without side effects.
   */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }

    this.activeController?.abort(new Error("Indexer scheduler stopped"));
    await this.activeCycle;
  }

  /** Wait for the active cycle without stopping the loop. */
  async drain(): Promise<void> {
    await this.activeCycle;
  }

  get isCycleActive(): boolean {
    return this.activeCycle !== null;
  }

  get isRunning(): boolean {
    return this.started;
  }

  /** Effective interval, widened while under backpressure. */
  get currentIntervalMs(): number {
    return Math.min(
      this.maxIntervalMs,
      this.baseIntervalMs * this.backpressureFactor ** this.backpressureLevel,
    );
  }

  stats(): SchedulerStats {
    return {
      cyclesStarted: this.cyclesStarted,
      cyclesCompleted: this.cyclesCompleted,
      cyclesFailed: this.cyclesFailed,
      skippedPolls: this.skippedPolls,
      shedPolls: this.shedPolls,
      consecutiveOverruns: this.consecutiveOverruns,
      backpressureLevel: this.backpressureLevel,
      currentIntervalMs: this.currentIntervalMs,
    };
  }

  private scheduleNext(): void {
    if (!this.started) return;
    const delayMs = Math.max(0, this.nextRunAt - this.clock.now());
    this.timer = this.clock.setTimeout(() => this.tick(), delayMs);
  }

  /**
   * Widen the interval after sustained overruns.
   *
   * Levels are capped implicitly by `maxIntervalMs`: once the interval is
   * pinned at the ceiling, further overruns stop changing anything, so the
   * level is left alone rather than growing without bound.
   */
  private applyBackpressure(): void {
    if (this.consecutiveOverruns < this.maxConsecutiveOverruns) return;
    if (this.currentIntervalMs >= this.maxIntervalMs) return;

    this.backpressureLevel += 1;
    this.consecutiveOverruns = 0;
    this.onBackpressure(this.stats());
  }

  /** Step the interval back down after enough on-time cycles. */
  private relieveBackpressure(): void {
    this.consecutiveOnTime += 1;
    if (this.backpressureLevel === 0) return;
    if (this.consecutiveOnTime < this.recoveryCycles) return;

    this.backpressureLevel -= 1;
    this.consecutiveOnTime = 0;
    this.onBackpressure(this.stats());
  }

  private noteOverrun(skipped: number, reason: OverrunReason): void {
    this.skippedPolls += skipped;
    this.consecutiveOverruns += skipped;
    this.consecutiveOnTime = 0;
    this.onOverrun(skipped, reason);
    this.applyBackpressure();
  }

  private tick(): void {
    if (!this.started) return;
    this.timer = null;

    const now = this.clock.now();
    const interval = this.currentIntervalMs;
    // A tick can arrive arbitrarily late (event loop starvation, a suspended
    // host). Advance the cadence past every interval already missed instead of
    // firing a burst of catch-up ticks.
    const lateIntervals = Math.max(
      0,
      Math.floor((now - this.nextRunAt) / interval),
    );
    this.nextRunAt += (lateIntervals + 1) * interval;
    this.scheduleNext();

    if (this.activeCycle !== null) {
      this.noteOverrun(lateIntervals + 1, "in_flight");
      return;
    }

    if (lateIntervals > 0) this.noteOverrun(lateIntervals, "late");

    // Shed the tick when the work this loop feeds is already saturated.
    // Dropping here — before any ledger range is fetched — is what stops a
    // slow consumer from turning into unbounded resident memory.
    if (this.getQueueDepth !== null) {
      let depth = 0;
      try {
        depth = this.getQueueDepth();
      } catch {
        depth = 0; // A broken probe must not stall the indexer.
      }
      if (depth >= this.maxQueueDepth) {
        this.shedPolls += 1;
        this.noteOverrun(1, "queue_full");
        return;
      }
    }

    const controller = new AbortController();
    this.activeController = controller;
    this.cyclesStarted += 1;
    this.activeCycle = this.runCycle(controller.signal)
      .then(() => {
        this.cyclesCompleted += 1;
        this.relieveBackpressure();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        this.cyclesFailed += 1;
        this.onError(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.activeController = null;
        this.activeCycle = null;
      });
  }
}
