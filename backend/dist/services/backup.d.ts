/**
 * Database Backup and Point-in-Time Recovery Service
 *
 * Provides automated SQLite database backups using SQLite's backup API,
 * backup integrity verification, Point-in-Time Recovery (PITR),
 * continuous replication status reporting (Litestream), and external storage integration.
 */
export interface BackupResult {
    success: boolean;
    filePath?: string;
    fileName?: string;
    sizeBytes?: number;
    checksum?: string;
    durationMs?: number;
    uploadedToStorage?: boolean;
    error?: string;
}
export interface RestoreResult {
    success: boolean;
    message: string;
    error?: string;
}
export interface VerificationResult {
    valid: boolean;
    integrityResult?: string;
    error?: string;
}
export interface LitestreamStatus {
    enabled: boolean;
    configured: boolean;
    configPath: string;
    status: "active" | "inactive" | "unconfigured";
}
export interface BackupStatus {
    lastBackupAt: string | null;
    lastBackupStatus: "success" | "failed" | "none";
    lastBackupError: string | null;
    backupCount: number;
    backupDir: string;
    litestream: LitestreamStatus;
    scheduledIntervalMs: number | null;
}
/**
 * Ensure the backup storage directory exists
 */
export declare function ensureBackupDir(): string;
/**
 * Perform an automated backup using better-sqlite3's online backup API
 */
export declare function createBackup(options?: {
    destinationDir?: string;
    backupName?: string;
    maxRetentionCount?: number;
}): Promise<BackupResult>;
/**
 * Verify integrity of a SQLite backup file
 */
export declare function verifyBackup(backupFilePath: string): Promise<VerificationResult>;
/**
 * Restore database from a backup file (Point-in-Time Recovery)
 */
export declare function restoreFromBackup(backupFilePath: string, targetDbPath?: string): Promise<RestoreResult>;
/**
 * Prune old local backup files beyond retention count
 */
export declare function pruneOldBackups(dirPath: string, maxCount: number): void;
/**
 * Check Litestream continuous replication status
 */
export declare function getLitestreamStatus(): LitestreamStatus;
/**
 * Return current backup health status and statistics
 */
export declare function getBackupStatus(): BackupStatus;
/**
 * Start automated scheduled database backups
 */
export declare function startScheduledBackups(intervalMs?: number): void;
/**
 * Stop scheduled database backups
 */
export declare function stopScheduledBackups(): void;
//# sourceMappingURL=backup.d.ts.map