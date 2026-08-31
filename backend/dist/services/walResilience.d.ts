import type { Database as DatabaseType } from "better-sqlite3";
export interface WalResilienceConfig {
    busyTimeoutMs: number;
    checkpointIntervalMs: number;
    checkpointTransactionCount: number;
    walWarningThresholdBytes: number;
    backupIntervalMs: number;
    retryCount: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
}
export interface WalHealth {
    available: boolean;
    integrityOk: boolean | null;
    integrityResult: string | null;
    lastIntegrityCheck: string | null;
    walSizeBytes: number | null;
    walSizeThreshold: number;
    walOversized: boolean;
    walFileExists: boolean | null;
    lastCheckpoint: string | null;
    lastBackup: string | null;
    lastBackupStatus: string;
}
export declare function configureWalResilience(overrides: Partial<WalResilienceConfig>): void;
export declare function getWalResilienceConfig(): WalResilienceConfig;
export declare function getWalHealth(db: DatabaseType, dbPath: string): WalHealth;
export declare function initWalResilience(db: DatabaseType, dbPath: string): void;
export declare function incrementTransactionCounter(): void;
export declare function startWalCheckpointing(db: DatabaseType): void;
export declare function stopWalCheckpointing(): void;
export declare function startWalMonitor(db: DatabaseType, dbPath: string): void;
export declare function stopWalMonitor(): void;
export declare function executeWithRetry<T>(db: DatabaseType, fn: (db: DatabaseType) => T, context?: Record<string, unknown>): T;
export declare function startPeriodicBackups(db: DatabaseType, dbPath: string): void;
export declare function stopPeriodicBackups(): void;
export declare function detectAndHandleWalIssue(db: DatabaseType, dbPath: string): void;
export declare function stopWalResilience(): void;
export declare function performInitialCheckpoint(db: DatabaseType): void;
//# sourceMappingURL=walResilience.d.ts.map