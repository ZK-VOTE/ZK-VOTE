import fs from "fs";
import path from "path";
import { createLogger } from "./logger.js";
import { dbWalSizeBytes } from "./metrics.js";
const logger = createLogger("wal-resilience");
const DEFAULT_CONFIG = {
    busyTimeoutMs: 5000,
    checkpointIntervalMs: 60000,
    checkpointTransactionCount: 1000,
    walWarningThresholdBytes: 100 * 1024 * 1024,
    backupIntervalMs: 3600000,
    retryCount: 5,
    retryBaseDelayMs: 50,
    retryMaxDelayMs: 2000,
};
let activeConfig = { ...DEFAULT_CONFIG };
let checkpointTimer = null;
let walMonitorTimer = null;
let backupTimer = null;
let transactionCountSinceCheckpoint = 0;
let lastCheckpointTime = null;
let lastBackupTime = null;
let lastBackupResult = "none";
let lastIntegrityCheckTime = null;
let dbAvailable = false;
let latestIntegrityStatus = null;
export function configureWalResilience(overrides) {
    activeConfig = { ...activeConfig, ...overrides };
}
export function getWalResilienceConfig() {
    return { ...activeConfig };
}
export function getWalHealth(db, dbPath) {
    const walPath = `${dbPath}-wal`;
    let walSizeBytes = null;
    let walFileExists;
    try {
        walFileExists = fs.existsSync(walPath);
        if (walFileExists) {
            walSizeBytes = fs.statSync(walPath).size;
        }
    }
    catch {
        walFileExists = null;
    }
    return {
        available: dbAvailable,
        integrityOk: latestIntegrityStatus === "ok"
            ? true
            : latestIntegrityStatus !== null
                ? false
                : null,
        integrityResult: latestIntegrityStatus,
        lastIntegrityCheck: lastIntegrityCheckTime,
        walSizeBytes,
        walSizeThreshold: activeConfig.walWarningThresholdBytes,
        walOversized: walSizeBytes !== null &&
            walSizeBytes > activeConfig.walWarningThresholdBytes,
        walFileExists,
        lastCheckpoint: lastCheckpointTime,
        lastBackup: lastBackupTime,
        lastBackupStatus: lastBackupResult,
    };
}
export function initWalResilience(db, dbPath) {
    const cfg = activeConfig;
    db.pragma(`journal_mode = WAL`);
    logger.info("wal_mode_set", { dbPath });
    db.pragma(`busy_timeout = ${cfg.busyTimeoutMs}`);
    logger.info("busy_timeout_set", { timeoutMs: cfg.busyTimeoutMs });
    const integrityRow = db.prepare("PRAGMA integrity_check").get();
    const integrityResult = integrityRow
        ? String(Object.values(integrityRow)[0])
        : "failed";
    latestIntegrityStatus = integrityResult;
    lastIntegrityCheckTime = new Date().toISOString();
    if (integrityResult !== "ok") {
        logger.error("integrity_check_failed", {
            result: integrityResult,
            dbPath,
        });
        throw new Error(`Database integrity check failed: ${integrityResult}`);
    }
    logger.info("integrity_check_passed", { dbPath });
    dbAvailable = true;
}
export function incrementTransactionCounter() {
    transactionCountSinceCheckpoint++;
}
export function startWalCheckpointing(db) {
    if (checkpointTimer)
        return;
    const doCheckpoint = (mode) => {
        try {
            const start = performance.now();
            db.pragma(`wal_checkpoint(${mode})`);
            const duration = performance.now() - start;
            lastCheckpointTime = new Date().toISOString();
            transactionCountSinceCheckpoint = 0;
            logger.debug("wal_checkpoint_completed", {
                mode,
                durationMs: Math.round(duration),
            });
        }
        catch (err) {
            logger.error("wal_checkpoint_failed", {
                mode,
                error: err.message,
            });
        }
    };
    checkpointTimer = setInterval(() => {
        doCheckpoint("PASSIVE");
    }, activeConfig.checkpointIntervalMs);
    logger.info("wal_checkpointing_started", {
        intervalMs: activeConfig.checkpointIntervalMs,
    });
}
export function stopWalCheckpointing() {
    if (checkpointTimer) {
        clearInterval(checkpointTimer);
        checkpointTimer = null;
        logger.info("wal_checkpointing_stopped");
    }
}
export function startWalMonitor(db, dbPath) {
    if (walMonitorTimer)
        return;
    walMonitorTimer = setInterval(() => {
        const walPath = `${dbPath}-wal`;
        try {
            if (fs.existsSync(walPath)) {
                const sizeBytes = fs.statSync(walPath).size;
                dbWalSizeBytes.set(sizeBytes);
                if (sizeBytes > activeConfig.walWarningThresholdBytes) {
                    logger.warn("wal_size_exceeded_threshold", {
                        currentSizeBytes: sizeBytes,
                        thresholdBytes: activeConfig.walWarningThresholdBytes,
                        dbPath,
                    });
                }
            }
            else {
                logger.warn("wal_file_missing", {
                    walPath,
                    dbPath,
                });
            }
        }
        catch (err) {
            logger.error("wal_monitor_error", {
                error: err.message,
                dbPath,
            });
        }
    }, activeConfig.checkpointIntervalMs);
    logger.info("wal_monitor_started", {
        intervalMs: activeConfig.checkpointIntervalMs,
        thresholdBytes: activeConfig.walWarningThresholdBytes,
    });
}
export function stopWalMonitor() {
    if (walMonitorTimer) {
        clearInterval(walMonitorTimer);
        walMonitorTimer = null;
        logger.info("wal_monitor_stopped");
    }
}
export function executeWithRetry(db, fn, context) {
    let lastError = null;
    let attempt = 0;
    while (attempt <= activeConfig.retryCount) {
        try {
            return fn(db);
        }
        catch (err) {
            const sqliteErr = err;
            if (sqliteErr.code !== "SQLITE_BUSY" &&
                !sqliteErr.message?.includes("SQLITE_BUSY") &&
                !sqliteErr.message?.toLowerCase().includes("database is locked")) {
                throw err;
            }
            lastError = err;
            if (attempt < activeConfig.retryCount) {
                const delayMs = Math.min(activeConfig.retryBaseDelayMs * Math.pow(2, attempt), activeConfig.retryMaxDelayMs);
                logger.debug("sqlite_busy_retry", {
                    attempt: attempt + 1,
                    maxRetries: activeConfig.retryCount,
                    delayMs,
                    ...context,
                });
                const deadline = Date.now() + delayMs;
                while (Date.now() < deadline) {
                    /* busy-wait */
                }
            }
            attempt++;
        }
    }
    logger.error("sqlite_busy_retries_exhausted", {
        attempts: activeConfig.retryCount + 1,
        lastError: lastError?.message,
        ...context,
    });
    throw lastError ?? new Error("SQLITE_BUSY retries exhausted");
}
export function startPeriodicBackups(db, dbPath) {
    if (backupTimer)
        return;
    const backupDir = path.join(path.dirname(dbPath), "backups");
    const performBackup = () => {
        try {
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const backupDbPath = path.join(backupDir, `zkvote-wal-backup-${timestamp}.db`);
            const start = performance.now();
            db.backup(backupDbPath);
            const walPath = `${dbPath}-wal`;
            const shmPath = `${dbPath}-shm`;
            const backupWalPath = `${backupDbPath}-wal`;
            const backupShmPath = `${backupDbPath}-shm`;
            if (fs.existsSync(walPath)) {
                fs.copyFileSync(walPath, backupWalPath);
            }
            if (fs.existsSync(shmPath)) {
                fs.copyFileSync(shmPath, backupShmPath);
            }
            const stats = fs.statSync(backupDbPath);
            const duration = performance.now() - start;
            lastBackupTime = new Date().toISOString();
            lastBackupResult = "success";
            logger.info("wal_backup_completed", {
                path: backupDbPath,
                sizeBytes: stats.size,
                durationMs: Math.round(duration),
            });
        }
        catch (err) {
            lastBackupResult = "failed";
            logger.error("wal_backup_failed", {
                error: err.message,
            });
        }
    };
    backupTimer = setInterval(performBackup, activeConfig.backupIntervalMs);
    logger.info("periodic_backups_started", {
        intervalMs: activeConfig.backupIntervalMs,
        backupDir,
    });
}
export function stopPeriodicBackups() {
    if (backupTimer) {
        clearInterval(backupTimer);
        backupTimer = null;
        logger.info("periodic_backups_stopped");
    }
}
export function detectAndHandleWalIssue(db, dbPath) {
    const walPath = `${dbPath}-wal`;
    try {
        const integrityRow = db.prepare("PRAGMA integrity_check").get();
        latestIntegrityStatus = integrityRow
            ? String(Object.values(integrityRow)[0])
            : "failed";
        if (latestIntegrityStatus !== "ok") {
            logger.error("wal_corruption_detected", {
                integrityResult: latestIntegrityStatus,
                dbPath,
            });
            return;
        }
        if (fs.existsSync(walPath)) {
            try {
                const walStat = fs.statSync(walPath);
                if (walStat.size === 0) {
                    logger.warn("wal_file_empty", { dbPath, walPath });
                }
            }
            catch (statErr) {
                logger.error("wal_file_unreadable", {
                    error: statErr.message,
                    dbPath,
                    walPath,
                });
            }
        }
        logger.info("wal_recovery_check_passed", { dbPath });
    }
    catch (err) {
        logger.error("wal_recovery_check_failed", {
            error: err.message,
            dbPath,
        });
    }
}
export function stopWalResilience() {
    stopWalCheckpointing();
    stopWalMonitor();
    stopPeriodicBackups();
    logger.info("wal_resilience_stopped");
}
export function performInitialCheckpoint(db) {
    try {
        db.pragma("wal_checkpoint(TRUNCATE)");
        lastCheckpointTime = new Date().toISOString();
        logger.info("initial_wal_checkpoint_completed", { mode: "TRUNCATE" });
    }
    catch (err) {
        logger.warn("initial_wal_checkpoint_failed", {
            error: err.message,
        });
    }
}
//# sourceMappingURL=walResilience.js.map