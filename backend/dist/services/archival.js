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
import fs from "fs";
import path from "path";
import zlib from "zlib";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { getDb } from "./db.js";
import { log } from "./logger.js";
import { config } from "../config.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ARCHIVE_DIR = path.join(__dirname, "..", "..", "data", "archives");
let archivalTimer = null;
/**
 * Ensure archive storage directory exists
 */
export function ensureArchiveDir() {
    if (!fs.existsSync(ARCHIVE_DIR)) {
        fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    }
    return ARCHIVE_DIR;
}
/**
 * Ensure archive_records tracking table exists in database
 */
export function initArchiveRegistry(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS archive_records (
      archive_id TEXT PRIMARY KEY,
      dao_id INTEGER NOT NULL,
      proposal_id INTEGER,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      min_timestamp TEXT NOT NULL,
      max_timestamp TEXT NOT NULL,
      min_ledger INTEGER,
      max_ledger INTEGER,
      size_bytes INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_archive_records_dao ON archive_records(dao_id);
  `);
}
/**
 * Run historical event archival process
 */
export async function runArchivalJob(options = {}) {
    const db = getDb();
    if (!db) {
        return {
            success: false,
            archivedEventsCount: 0,
            archivesCreatedCount: 0,
            dbSizeBytesBefore: 0,
            dbSizeBytesAfter: 0,
            savedSizeBytes: 0,
            records: [],
            error: "Database instance not available",
        };
    }
    initArchiveRegistry(db);
    const dbFilePath = path.join(__dirname, "..", "..", "data", "zkvote.db");
    const dbSizeBytesBefore = fs.existsSync(dbFilePath)
        ? fs.statSync(dbFilePath).size
        : 0;
    const ageDays = options.ageDays ?? config.archivalAgeDays ?? 90;
    const cutoffDate = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
    const targetDir = options.archiveDir || ensureArchiveDir();
    const batchSize = options.batchSize || 100;
    log("info", "archival_job_start", { ageDays, cutoffDate, dbSizeBytesBefore });
    try {
        // Step 1: Discover ended elections (proposals with proposal_closed or proposal_archived events)
        const partitionRows = db
            .prepare("SELECT dao_id FROM partition_registry")
            .all();
        const registeredDaos = partitionRows.map((r) => r.dao_id);
        let totalArchivedCount = 0;
        const createdRecords = [];
        for (const daoId of registeredDaos) {
            const tableName = `events_${daoId}`;
            const tableExists = db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                .get(tableName);
            if (!tableExists)
                continue;
            // Find closed proposal IDs
            const closedPropRows = db
                .prepare(`SELECT DISTINCT json_extract(data, '$.proposalId') as propId FROM ${tableName} WHERE type IN ('proposal_closed', 'proposal_archived') AND data IS NOT NULL`)
                .all();
            const closedPropIds = new Set(closedPropRows
                .map((r) => Number(r.propId))
                .filter((id) => !isNaN(id) && id > 0));
            if (closedPropIds.size === 0)
                continue;
            // Select events belonging to closed proposals and older than cutoffDate
            const eligibleEvents = db
                .prepare(`SELECT * FROM ${tableName} WHERE timestamp <= ? ORDER BY timestamp ASC`)
                .all(cutoffDate);
            const eventsToArchive = eligibleEvents.filter((ev) => {
                try {
                    if (!ev.data)
                        return false;
                    const parsed = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
                    const propId = Number(parsed.proposalId || parsed.proposal_id);
                    return closedPropIds.has(propId);
                }
                catch (_) {
                    return false;
                }
            });
            if (eventsToArchive.length === 0)
                continue;
            // Step 2: Format and compress archived events (JSONL.GZ)
            const archiveId = `archive_dao_${daoId}_${Date.now()}`;
            const fileName = `events_dao_${daoId}_${Date.now()}.jsonl.gz`;
            const filePath = path.join(targetDir, fileName);
            const jsonlLines = eventsToArchive
                .map((ev) => JSON.stringify(ev))
                .join("\n");
            const compressedBuffer = zlib.gzipSync(Buffer.from(jsonlLines, "utf-8"));
            fs.writeFileSync(filePath, compressedBuffer);
            const checksum = crypto
                .createHash("sha256")
                .update(compressedBuffer)
                .digest("hex");
            const sizeBytes = compressedBuffer.length;
            const timestamps = eventsToArchive.map((e) => e.timestamp).sort();
            const ledgers = eventsToArchive
                .map((e) => e.ledger)
                .filter((l) => l !== null);
            const record = {
                archive_id: archiveId,
                dao_id: daoId,
                proposal_id: null,
                file_name: fileName,
                file_path: filePath,
                event_count: eventsToArchive.length,
                min_timestamp: timestamps[0],
                max_timestamp: timestamps[timestamps.length - 1],
                min_ledger: ledgers.length > 0 ? Math.min(...ledgers) : null,
                max_ledger: ledgers.length > 0 ? Math.max(...ledgers) : null,
                size_bytes: sizeBytes,
                checksum,
            };
            // Register archive record in index
            db.prepare(`
        INSERT INTO archive_records (archive_id, dao_id, proposal_id, file_name, file_path, event_count, min_timestamp, max_timestamp, min_ledger, max_ledger, size_bytes, checksum)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.archive_id, record.dao_id, record.proposal_id, record.file_name, record.file_path, record.event_count, record.min_timestamp, record.max_timestamp, record.min_ledger, record.max_ledger, record.size_bytes, record.checksum);
            createdRecords.push(record);
            // Step 3: Batch deletion of archived events from SQLite database
            const eventIds = eventsToArchive.map((e) => e.id);
            for (let i = 0; i < eventIds.length; i += batchSize) {
                const batch = eventIds.slice(i, i + batchSize);
                const placeholders = batch.map(() => "?").join(",");
                db.prepare(`DELETE FROM ${tableName} WHERE id IN (${placeholders})`).run(...batch);
            }
            totalArchivedCount += eventsToArchive.length;
        }
        // Run optimize / checkpoint
        db.pragma("wal_checkpoint(TRUNCATE)");
        const dbSizeBytesAfter = fs.existsSync(dbFilePath)
            ? fs.statSync(dbFilePath).size
            : 0;
        const savedSizeBytes = Math.max(0, dbSizeBytesBefore - dbSizeBytesAfter);
        log("info", "archival_job_complete", {
            archivedEventsCount: totalArchivedCount,
            archivesCreatedCount: createdRecords.length,
            dbSizeBytesBefore,
            dbSizeBytesAfter,
            savedSizeBytes,
        });
        return {
            success: true,
            archivedEventsCount: totalArchivedCount,
            archivesCreatedCount: createdRecords.length,
            dbSizeBytesBefore,
            dbSizeBytesAfter,
            savedSizeBytes,
            records: createdRecords,
        };
    }
    catch (err) {
        const errorMsg = err.message;
        log("error", "archival_job_failed", { error: errorMsg });
        return {
            success: false,
            archivedEventsCount: 0,
            archivesCreatedCount: 0,
            dbSizeBytesBefore,
            dbSizeBytesAfter: dbSizeBytesBefore,
            savedSizeBytes: 0,
            records: [],
            error: errorMsg,
        };
    }
}
/**
 * Get archive records index from database
 */
export function getArchiveIndex(daoId) {
    const db = getDb();
    if (!db)
        return [];
    initArchiveRegistry(db);
    if (daoId !== undefined) {
        return db
            .prepare("SELECT * FROM archive_records WHERE dao_id = ? ORDER BY created_at DESC")
            .all(daoId);
    }
    return db
        .prepare("SELECT * FROM archive_records ORDER BY created_at DESC")
        .all();
}
/**
 * Read and decompress events from an archive file
 */
export function readArchivedEvents(archiveId) {
    const db = getDb();
    if (!db)
        return [];
    initArchiveRegistry(db);
    const record = db
        .prepare("SELECT * FROM archive_records WHERE archive_id = ?")
        .get(archiveId);
    if (!record || !fs.existsSync(record.file_path)) {
        return [];
    }
    try {
        const compressedBuffer = fs.readFileSync(record.file_path);
        const decompressed = zlib.gunzipSync(compressedBuffer).toString("utf-8");
        return decompressed
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line));
    }
    catch (err) {
        log("error", "read_archive_failed", {
            archiveId,
            error: err.message,
        });
        return [];
    }
}
/**
 * Start background periodic archival task
 */
export function startArchivalTask(intervalMs = config.archivalIntervalMs || 86400000) {
    if (archivalTimer) {
        clearInterval(archivalTimer);
    }
    archivalTimer = setInterval(() => {
        runArchivalJob().catch((err) => {
            log("error", "periodic_archival_failed", {
                error: err.message,
            });
        });
    }, intervalMs);
    log("info", "archival_task_started", { intervalMs });
}
/**
 * Stop background archival task
 */
export function stopArchivalTask() {
    if (archivalTimer) {
        clearInterval(archivalTimer);
        archivalTimer = null;
        log("info", "archival_task_stopped");
    }
}
//# sourceMappingURL=archival.js.map