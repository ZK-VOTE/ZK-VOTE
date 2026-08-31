/**
 * IPFS Pin Monitor — Periodic Verification & Alerting
 *
 * Runs a configurable interval loop that:
 *  1. Verifies all pinned CIDs are still retrievable
 *  2. Attempts re-pin for any content that has become unavailable
 *  3. Logs alerts for persistent failures
 *  4. Exposes status for the /ipfs/health endpoint
 */
import * as pinManager from "./ipfs-pin-manager.js";
export interface MonitorConfig {
    /** Interval between full verification scans (ms). Default: 1 hour */
    scanIntervalMs: number;
    /** Number of consecutive failures before triggering an alert. Default: 3 */
    alertThreshold: number;
    /** Whether to auto-repin failed CIDs from local backup. Default: true */
    autoRepin: boolean;
    /** Callback for re-pinning from backup */
    repinFn?: (backupPath: string, contentType: "json" | "file", name: string, mimeType?: string) => Promise<string>;
}
export interface MonitorStatus {
    running: boolean;
    scanIntervalMs: number;
    lastScanAt: string | null;
    lastScanDurationMs: number | null;
    nextScanAt: string | null;
    stats: pinManager.PinManagerStats;
    alerts: PinAlert[];
}
export interface PinAlert {
    cid: string;
    severity: "warning" | "critical";
    message: string;
    timestamp: string;
    consecutiveFailures: number;
}
/**
 * Start the periodic pin verification monitor.
 */
export declare function startMonitor(config: MonitorConfig): void;
/**
 * Stop the pin verification monitor.
 */
export declare function stopMonitor(): void;
/**
 * Manually trigger a verification scan (e.g. from admin endpoint).
 */
export declare function triggerScan(): Promise<void>;
/**
 * Get the current monitor status for the health endpoint.
 */
export declare function getMonitorStatus(): MonitorStatus;
/**
 * Get all active alerts.
 */
export declare function getAlerts(): PinAlert[];
//# sourceMappingURL=ipfs-monitor.d.ts.map