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
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
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
export declare class WatermarkScheduler {
    private readonly baseIntervalMs;
    private readonly runCycle;
    private readonly onOverrun;
    private readonly onError;
    private readonly onBackpressure;
    private readonly clock;
    private readonly maxConsecutiveOverruns;
    private readonly backpressureFactor;
    private readonly maxIntervalMs;
    private readonly recoveryCycles;
    private readonly getQueueDepth;
    private readonly maxQueueDepth;
    private timer;
    private activeCycle;
    private activeController;
    private nextRunAt;
    private started;
    private cyclesStarted;
    private cyclesCompleted;
    private cyclesFailed;
    private skippedPolls;
    private shedPolls;
    private consecutiveOverruns;
    private consecutiveOnTime;
    private backpressureLevel;
    constructor(options: WatermarkSchedulerOptions);
    start(): void;
    /**
     * Stop the loop and wait for the in-flight cycle to unwind.
     *
     * Idempotent: calling it twice, or after a cycle already settled, resolves
     * without side effects.
     */
    stop(): Promise<void>;
    /** Wait for the active cycle without stopping the loop. */
    drain(): Promise<void>;
    get isCycleActive(): boolean;
    get isRunning(): boolean;
    /** Effective interval, widened while under backpressure. */
    get currentIntervalMs(): number;
    stats(): SchedulerStats;
    private scheduleNext;
    /**
     * Widen the interval after sustained overruns.
     *
     * Levels are capped implicitly by `maxIntervalMs`: once the interval is
     * pinned at the ceiling, further overruns stop changing anything, so the
     * level is left alone rather than growing without bound.
     */
    private applyBackpressure;
    /** Step the interval back down after enough on-time cycles. */
    private relieveBackpressure;
    private noteOverrun;
    private tick;
}
//# sourceMappingURL=indexer-scheduler.d.ts.map