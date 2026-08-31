/**
 * Fixed-cadence, single-flight scheduler for the indexer watermark loop.
 *
 * A timer is always scheduled independently of the active poll. When a tick
 * arrives while the previous poll is still running, it is counted as an
 * overrun instead of starting overlapping work. Stopping clears the timer and
 * aborts the active poll before waiting for it to settle.
 */
const systemClock = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer),
};
export class WatermarkScheduler {
    intervalMs;
    runCycle;
    onOverrun;
    onError;
    clock;
    timer = null;
    activeCycle = null;
    activeController = null;
    nextRunAt = 0;
    started = false;
    constructor(options) {
        if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
            throw new Error("Indexer poll interval must be greater than zero");
        }
        this.intervalMs = options.intervalMs;
        this.runCycle = options.runCycle;
        this.onOverrun = options.onOverrun ?? (() => undefined);
        this.onError = options.onError ?? (() => undefined);
        this.clock = options.clock ?? systemClock;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        this.nextRunAt = this.clock.now() + this.intervalMs;
        this.scheduleNext();
    }
    async stop() {
        this.started = false;
        if (this.timer !== null) {
            this.clock.clearTimeout(this.timer);
            this.timer = null;
        }
        this.activeController?.abort(new Error("Indexer scheduler stopped"));
        await this.activeCycle;
    }
    get isCycleActive() {
        return this.activeCycle !== null;
    }
    scheduleNext() {
        if (!this.started)
            return;
        const delayMs = Math.max(0, this.nextRunAt - this.clock.now());
        this.timer = this.clock.setTimeout(() => this.tick(), delayMs);
    }
    tick() {
        if (!this.started)
            return;
        this.timer = null;
        const now = this.clock.now();
        const lateIntervals = Math.max(0, Math.floor((now - this.nextRunAt) / this.intervalMs));
        this.nextRunAt += (lateIntervals + 1) * this.intervalMs;
        this.scheduleNext();
        if (this.activeCycle !== null) {
            this.onOverrun(lateIntervals + 1);
            return;
        }
        if (lateIntervals > 0)
            this.onOverrun(lateIntervals);
        const controller = new AbortController();
        this.activeController = controller;
        this.activeCycle = this.runCycle(controller.signal)
            .catch((error) => {
            if (!controller.signal.aborted) {
                this.onError(error instanceof Error ? error : new Error(String(error)));
            }
        })
            .finally(() => {
            this.activeController = null;
            this.activeCycle = null;
        });
    }
}
//# sourceMappingURL=indexer-scheduler.js.map