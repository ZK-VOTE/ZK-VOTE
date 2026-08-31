/**
 * IPFS Pin Manager — Redundancy & Recovery Layer
 *
 * Provides:
 *  - Local file-system backup of all pinned content before upload
 *  - Secondary pinning service (Web3.Storage) for redundancy
 *  - CID availability verification (fetch + byte-check)
 *  - Automatic re-pin of unavailable content from local backup
 *  - Pin cost tracking and metrics
 */
export interface PinRecord {
    cid: string;
    /** "json" | "file" */
    contentType: "json" | "file";
    /** Original filename (for files) or label (for JSON) */
    name: string;
    /** MIME type for files */
    mimeType?: string;
    /** Size in bytes */
    sizeBytes: number;
    /** ISO timestamp of first pin */
    pinnedAt: string;
    /** Which services hold the pin */
    pinnedOn: ("pinata" | "web3storage" | "local")[];
    /** Last successful verification timestamp (ISO) */
    lastVerifiedAt: string | null;
    /** Number of consecutive verification failures */
    consecutiveFailures: number;
    /** Estimated cumulative pin cost in USD (Pinata pricing model) */
    estimatedCostUsd: number;
}
export interface PinVerificationResult {
    cid: string;
    reachable: boolean;
    gateway: string;
    latencyMs: number;
    error?: string;
}
export interface PinManagerStats {
    totalPins: number;
    totalSizeBytes: number;
    estimatedMonthlyCostUsd: number;
    healthyPins: number;
    degradedPins: number;
    failedPins: number;
    lastFullScanAt: string | null;
    lastFullScanDurationMs: number | null;
}
/**
 * Initialize the pin manager.
 * Creates the local backup directory if it doesn't exist.
 *
 * @param localBackupPath  Absolute path for backup storage
 * @param w3sToken         Optional Web3.Storage API token for secondary pinning
 */
export declare function initPinManager(localBackupPath: string, w3sToken?: string): void;
/**
 * Backup JSON content to local disk before pinning.
 * Returns the path where it was saved.
 */
export declare function backupJSON(data: Record<string, unknown>, label: string): string;
/**
 * Backup a file buffer to local disk before pinning.
 * Returns the path where it was saved.
 */
export declare function backupFile(buffer: Buffer, filename: string): string;
/**
 * Persist a CID-to-backup-path mapping so we can restore from backup on re-pin.
 */
export declare function registerPin(cid: string, contentType: "json" | "file", name: string, sizeBytes: number, mimeType?: string, backupPath?: string): void;
/**
 * Pin content to Web3.Storage as a secondary provider.
 * This is a non-blocking best-effort operation.
 */
export declare function pinToSecondary(cid: string, backupPath: string, contentType: "json" | "file"): Promise<boolean>;
/**
 * Verify a single CID is retrievable from at least one public gateway.
 * Performs a HEAD request with a generous timeout.
 */
export declare function verifyCid(cid: string): Promise<PinVerificationResult>;
/**
 * Run a full verification scan across all registered pins.
 * Updates the pin registry with verification results.
 * Returns arrays of healthy, degraded and failed CIDs.
 */
export declare function verifyAllPins(): Promise<{
    healthy: string[];
    failed: string[];
    duration: number;
}>;
/**
 * Re-pin a CID whose content has become unavailable.
 * Reads from the local backup and re-uploads to the primary (Pinata) service.
 *
 * @param cid       The CID to re-pin
 * @param pinFn     A callback that performs the actual Pinata upload and returns the new CID
 * @returns         The new CID (may differ from original) or null on failure
 */
export declare function repinFromBackup(cid: string, pinFn: (backupPath: string, contentType: "json" | "file", name: string, mimeType?: string) => Promise<string>): Promise<string | null>;
/**
 * Get aggregate statistics for all tracked pins.
 */
export declare function getStats(): PinManagerStats;
/**
 * Get all pin records (for diagnostic endpoints).
 */
export declare function getAllPinRecords(): PinRecord[];
/**
 * Get a single pin record by CID.
 */
export declare function getPinRecord(cid: string): PinRecord | undefined;
//# sourceMappingURL=ipfs-pin-manager.d.ts.map