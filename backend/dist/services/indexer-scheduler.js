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
const systemClock = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer),
};
const DEFAULT_MAX_CONSECUTIVE_OVERRUNS = 2;
const DEFAULT_BACKPRESSURE_FACTOR = 2;
const DEFAULT_RECOVERY_CYCLES = 3;
const DEFAULT_MAX_BACKPRESSURE_LEVEL = 5;
export class WatermarkScheduler {
    baseIntervalMs;
    runCycle;
    onOverrun;
    onError;
    onBackpressure;
    clock;
    maxConsecutiveOverruns;
    backpressureFactor;
    maxIntervalMs;
    recoveryCycles;
    getQueueDepth;
    maxQueueDepth;
    timer = null;
    activeCycle = null;
    activeController = null;
    nextRunAt = 0;
    started = false;
    cyclesStarted = 0;
    cyclesCompleted = 0;
    cyclesFailed = 0;
    skippedPolls = 0;
    shedPolls = 0;
    consecutiveOverruns = 0;
    consecutiveOnTime = 0;
    backpressureLevel = 0;
    constructor(options) {
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
    start() {
        if (this.started)
            return;
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
    async stop() {
        this.started = false;
        if (this.timer !== null) {
            this.clock.clearTimeout(this.timer);
            this.timer = null;
        }
        this.activeController?.abort(new Error("Indexer scheduler stopped"));
        await this.activeCycle;
    }
    /** Wait for the active cycle without stopping the loop. */
    async drain() {
        await this.activeCycle;
    }
    get isCycleActive() {
        return this.activeCycle !== null;
    }
    get isRunning() {
        return this.started;
    }
    /** Effective interval, widened while under backpressure. */
    get currentIntervalMs() {
        return Math.min(this.maxIntervalMs, this.baseIntervalMs * this.backpressureFactor ** this.backpressureLevel);
    }
    stats() {
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
    scheduleNext() {
        if (!this.started)
            return;
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
    applyBackpressure() {
        if (this.consecutiveOverruns < this.maxConsecutiveOverruns)
            return;
        if (this.currentIntervalMs >= this.maxIntervalMs)
            return;
        this.backpressureLevel += 1;
        this.consecutiveOverruns = 0;
        this.onBackpressure(this.stats());
    }
    /** Step the interval back down after enough on-time cycles. */
    relieveBackpressure() {
        this.consecutiveOnTime += 1;
        if (this.backpressureLevel === 0)
            return;
        if (this.consecutiveOnTime < this.recoveryCycles)
            return;
        this.backpressureLevel -= 1;
        this.consecutiveOnTime = 0;
        this.onBackpressure(this.stats());
    }
    noteOverrun(skipped, reason) {
        this.skippedPolls += skipped;
        this.consecutiveOverruns += skipped;
        this.consecutiveOnTime = 0;
        this.onOverrun(skipped, reason);
        this.applyBackpressure();
    }
    tick() {
        if (!this.started)
            return;
        this.timer = null;
        const now = this.clock.now();
        const interval = this.currentIntervalMs;
        // A tick can arrive arbitrarily late (event loop starvation, a suspended
        // host). Advance the cadence past every interval already missed instead of
        // firing a burst of catch-up ticks.
        const lateIntervals = Math.max(0, Math.floor((now - this.nextRunAt) / interval));
        this.nextRunAt += (lateIntervals + 1) * interval;
        this.scheduleNext();
        if (this.activeCycle !== null) {
            this.noteOverrun(lateIntervals + 1, "in_flight");
            return;
        }
        if (lateIntervals > 0)
            this.noteOverrun(lateIntervals, "late");
        // Shed the tick when the work this loop feeds is already saturated.
        // Dropping here — before any ledger range is fetched — is what stops a
        // slow consumer from turning into unbounded resident memory.
        if (this.getQueueDepth !== null) {
            let depth = 0;
            try {
                depth = this.getQueueDepth();
            }
            catch {
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
            .catch((error) => {
            if (controller.signal.aborted)
                return;
            this.cyclesFailed += 1;
            this.onError(error instanceof Error ? error : new Error(String(error)));
        })
            .finally(() => {
            this.activeController = null;
            this.activeCycle = null;
        });
    }
}
//# sourceMappingURL=indexer-scheduler.js.map