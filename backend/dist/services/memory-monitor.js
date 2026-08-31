/**
 * Memory Monitor
 *
 * Periodically snapshots process memory usage, logs it, and warns when
 * usage crosses a configurable ratio of the container memory limit
 * (fly.toml [[vm]] memory). Optionally triggers a graceful restart when a
 * critical threshold is exceeded, so the process is recycled by the
 * orchestrator before it OOM-kills mid-request.
 */
import { config } from "../config.js";
import { log } from "./logger.js";
import { memoryUsageRatio, memoryThresholdBreachesTotal } from "./metrics.js";
export function getMemorySnapshot() {
    const usage = process.memoryUsage();
    const limitBytes = config.memoryLimitMb * 1024 * 1024;
    return {
        rss: usage.rss,
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        external: usage.external,
        arrayBuffers: usage.arrayBuffers || 0,
        limitMb: config.memoryLimitMb,
        usageRatio: limitBytes > 0 ? usage.rss / limitBytes : 0,
    };
}
let monitorInterval = null;
let restartTriggered = false;
/**
 * Start periodic memory monitoring. `onCritical` is invoked once (not
 * repeatedly) when usage crosses `memoryCriticalRatio`, so the caller can
 * perform a graceful shutdown/restart.
 */
export function startMemoryMonitor(onCritical) {
    if (monitorInterval) {
        clearInterval(monitorInterval);
    }
    restartTriggered = false;
    monitorInterval = setInterval(() => {
        const snapshot = getMemorySnapshot();
        memoryUsageRatio.set(snapshot.usageRatio);
        log("debug", "memory_snapshot", {
            rssMb: Math.round(snapshot.rss / 1024 / 1024),
            heapUsedMb: Math.round(snapshot.heapUsed / 1024 / 1024),
            limitMb: snapshot.limitMb,
            usageRatio: Math.round(snapshot.usageRatio * 100) / 100,
        });
        if (snapshot.usageRatio >= config.memoryCriticalRatio) {
            memoryThresholdBreachesTotal.inc({ level: "critical" });
            log("error", "memory_critical_threshold_exceeded", {
                rssMb: Math.round(snapshot.rss / 1024 / 1024),
                limitMb: snapshot.limitMb,
                usageRatio: snapshot.usageRatio,
                autoRestart: config.memoryAutoRestart,
            });
            if (config.memoryAutoRestart && !restartTriggered) {
                restartTriggered = true;
                onCritical();
            }
        }
        else if (snapshot.usageRatio >= config.memoryWarnRatio) {
            memoryThresholdBreachesTotal.inc({ level: "warn" });
            log("warn", "memory_usage_high", {
                rssMb: Math.round(snapshot.rss / 1024 / 1024),
                limitMb: snapshot.limitMb,
                usageRatio: snapshot.usageRatio,
            });
        }
    }, config.memoryMonitorIntervalMs);
    // Don't keep the process alive solely for this timer
    monitorInterval.unref?.();
    log("info", "memory_monitor_started", {
        intervalMs: config.memoryMonitorIntervalMs,
        limitMb: config.memoryLimitMb,
        warnRatio: config.memoryWarnRatio,
        criticalRatio: config.memoryCriticalRatio,
        autoRestart: config.memoryAutoRestart,
    });
}
export function stopMemoryMonitor() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
        log("info", "memory_monitor_stopped");
    }
}
//# sourceMappingURL=memory-monitor.js.map