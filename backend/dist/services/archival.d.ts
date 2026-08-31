/**
 * Event Data Archival Service
 *
 * Manages archival of historical blockchain events from completed/ended elections:
 * - Identifies eligible historical events (ended elections, age >= 90 days)
 * - Ensures active election events are NEVER archived
 * - Exports archived events to compressed JSONL (.jsonl.gz)
 * - Uploads archives to external object storage
 * - Deletes archived events from SQLite in safe batches
 * - Maintains historical archive index in metadata table
 * - Exposes retrieval functions for historical queries
 * - Monitors database file size before and after archival
 */
import { type Database as DatabaseType } from "better-sqlite3";
export interface ArchiveRecord {
    archive_id: string;
    dao_id: number;
    proposal_id: number | null;
    file_name: string;
    file_path: string;
    event_count: number;
    min_timestamp: string;
    max_timestamp: string;
    min_ledger: number | null;
    max_ledger: number | null;
    size_bytes: number;
    checksum: string;
    created_at?: string;
}
export interface ArchivalJobResult {
    success: boolean;
    archivedEventsCount: number;
    archivesCreatedCount: number;
    dbSizeBytesBefore: number;
    dbSizeBytesAfter: number;
    savedSizeBytes: number;
    records: ArchiveRecord[];
    error?: string;
}
/**
 * Ensure archive storage directory exists
 */
export declare function ensureArchiveDir(): string;
/**
 * Ensure archive_records tracking table exists in database
 */
export declare function initArchiveRegistry(db: DatabaseType): void;
/**
 * Run historical event archival process
 */
export declare function runArchivalJob(options?: {
    ageDays?: number;
    archiveDir?: string;
    batchSize?: number;
}): Promise<ArchivalJobResult>;
/**
 * Get archive records index from database
 */
export declare function getArchiveIndex(daoId?: number): ArchiveRecord[];
/**
 * Read and decompress events from an archive file
 */
export declare function readArchivedEvents(archiveId: string): any[];
/**
 * Start background periodic archival task
 */
export declare function startArchivalTask(intervalMs?: number): void;
/**
 * Stop background archival task
 */
export declare function stopArchivalTask(): void;
//# sourceMappingURL=archival.d.ts.map