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
import { WatermarkScheduler } from "./indexer-scheduler.js";
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
    /**
     * Aborts the job between DAO partitions and between delete batches (#323).
     * Archival can run for minutes over a large database; without this a
     * shutdown would either block on it or leave a half-deleted partition.
     */
    signal?: AbortSignal;
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
 * Start the background periodic archival task.
 *
 * Uses the same single-flight, cancellable scheduler as the indexer (#323)
 * rather than a bare `setInterval`. Two properties matter here: an archival run
 * that outlives its interval must not have a second run start on top of it —
 * both would be deleting rows from the same partition — and a shutdown must be
 * able to abort a run mid-flight instead of waiting out a multi-minute job.
 */
export declare function startArchivalTask(intervalMs?: number): void;
/**
 * Stop the background archival task, aborting any run in flight.
 *
 * Resolves only once that run has unwound, so callers can rely on no archival
 * write still being in progress when the promise settles.
 */
export declare function stopArchivalTask(): Promise<void>;
/** Scheduler stats for the archival loop, or `null` when it is not running. */
export declare function getArchivalSchedulerStats(): ReturnType<WatermarkScheduler["stats"]> | null;
//# sourceMappingURL=archival.d.ts.map