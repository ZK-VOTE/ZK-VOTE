/**
 * Memory Monitor
 *
 * Periodically snapshots process memory usage, logs it, and warns when
 * usage crosses a configurable ratio of the container memory limit
 * (fly.toml [[vm]] memory). Optionally triggers a graceful restart when a
 * critical threshold is exceeded, so the process is recycled by the
 * orchestrator before it OOM-kills mid-request.
 */
export interface MemorySnapshot {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
    limitMb: number;
    usageRatio: number;
}
export declare function getMemorySnapshot(): MemorySnapshot;
/**
 * Start periodic memory monitoring. `onCritical` is invoked once (not
 * repeatedly) when usage crosses `memoryCriticalRatio`, so the caller can
 * perform a graceful shutdown/restart.
 */
export declare function startMemoryMonitor(onCritical: () => void): void;
export declare function stopMemoryMonitor(): void;
//# sourceMappingURL=memory-monitor.d.ts.map