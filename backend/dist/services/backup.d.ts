/**
 * Database Backup and Point-in-Time Recovery Service
 *
 * Provides automated SQLite database backups using SQLite's backup API,
 * backup integrity verification, Point-in-Time Recovery (PITR),
 * continuous replication status reporting (Litestream), and external storage integration.
 *
 * Since #359 the service also supports ENCRYPTED snapshots: the online backup is
 * wrapped in an AES-256-GCM container (see backupCrypto.ts) using the key
 * managed by backupKeyManager.ts, so at-rest and off-site copies never contain
 * plaintext relay data. Encrypted backups are transparently verified (decrypt +
 * PRAGMA integrity_check) and restored (decrypt → PITR restore).
 */
export interface BackupResult {
    success: boolean;
    filePath?: string;
    fileName?: string;
    sizeBytes?: number;
    checksum?: string;
    durationMs?: number;
    uploadedToStorage?: boolean;
    encrypted?: boolean;
    keyId?: string;
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
    encrypted?: boolean;
    keyId?: string;
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
    lastBackupEncrypted: boolean;
    encryption: {
        enabled: boolean;
        autoInit: boolean;
        currentKeyId: string | null;
        currentSource: string | null;
        keyFile: string | null;
        keyRingDir: string;
        totalKeys: number;
        archivedKeys: number;
        algorithm: string;
        kdf: string;
    };
}
/**
 * Ensure the backup storage directory exists
 */
export declare function ensureBackupDir(): string;
/**
 * Whether a given backup file is an encrypted container.
 */
export declare function isEncryptedBackup(backupFilePath: string): boolean;
/**
 * Perform an automated backup using better-sqlite3's online backup API.
 *
 * When encryption is enabled the plaintext snapshot is produced transiently
 * and immediately wrapped into an encrypted container; the plaintext file is
 * deleted before the function returns.
 */
export declare function createBackup(options?: {
    destinationDir?: string;
    backupName?: string;
    maxRetentionCount?: number;
    encrypted?: boolean;
}): Promise<BackupResult>;
/**
 * Verify integrity of a backup file. Encrypted backups are decrypted to a
 * temporary file first and validated with PRAGMA integrity_check; the temp
 * plaintext is removed before returning.
 */
export declare function verifyBackup(backupFilePath: string): Promise<VerificationResult>;
/**
 * Restore database from a backup file (Point-in-Time Recovery).
 * Encrypted backups are decrypted to a temporary plaintext snapshot, verified,
 * and then restored; the temporary file is deleted afterwards.
 */
export declare function restoreFromBackup(backupFilePath: string, targetDbPath?: string): Promise<RestoreResult>;
/**
 * Dry-run restore verification: restores the backup to a throwaway database and
 * reports whether integrity + content survive the round-trip. No production DB
 * is touched. Used by the backup CLI and disaster-recovery drills.
 */
export declare function verifyRestore(backupFilePath: string): Promise<RestoreResult>;
/**
 * Prune old local backup files beyond retention count.
 * Handles both plaintext (`*.db`) and encrypted (`*.enc.db`) artifacts.
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