/**
 * Fixed-cadence, single-flight scheduler for the indexer watermark loop.
 *
 * A timer is always scheduled independently of the active poll. When a tick
 * arrives while the previous poll is still running, it is counted as an
 * overrun instead of starting overlapping work. Stopping clears the timer and
 * aborts the active poll before waiting for it to settle.
 */
export interface SchedulerClock {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export interface WatermarkSchedulerOptions {
    intervalMs: number;
    runCycle: (signal: AbortSignal) => Promise<void>;
    onOverrun?: (skippedPolls: number) => void;
    onError?: (error: Error) => void;
    clock?: SchedulerClock;
}
export declare class WatermarkScheduler {
    private readonly intervalMs;
    private readonly runCycle;
    private readonly onOverrun;
    private readonly onError;
    private readonly clock;
    private timer;
    private activeCycle;
    private activeController;
    private nextRunAt;
    private started;
    constructor(options: WatermarkSchedulerOptions);
    start(): void;
    stop(): Promise<void>;
    get isCycleActive(): boolean;
    private scheduleNext;
    private tick;
}
//# sourceMappingURL=indexer-scheduler.d.ts.map