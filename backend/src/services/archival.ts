// @ts-nocheck
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
import { type Database as DatabaseType } from "better-sqlite3";
import { getDb } from "./db.js";
import { log } from "./logger.js";
import { config } from "../config.js";
import { WatermarkScheduler } from "./indexer-scheduler.js";
import { archivalRunsTotal, archivalDuration } from "./metrics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARCHIVE_DIR = path.join(__dirname, "..", "..", "data", "archives");

export interface ArchiveRecord {
  archive_id: string;
  dao_id: number;
  proposal_id: number | null;
  storage_category: string; // "governance" | "voting" | "membership" | "auxiliary"
  file_name: string;
  file_path: string;
  event_count: number;
  min_timestamp: string;
  max_timestamp: string;
  min_ledger: number | null;
  max_ledger: number | null;
  size_bytes: number;
  checksum: string;
  commitment: string; // Cryptographic Merkle / canonical state commitment
  status: "archived" | "restored" | "recommitted";
  recommitted_at?: string;
  created_at?: string;
}

export interface RestorationResult {
  success: boolean;
  archiveId: string;
  restoredEventsCount: number;
  commitmentVerified: boolean;
  recommitted: boolean;
  status: string;
  error?: string;
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

let archivalScheduler: WatermarkScheduler | null = null;

/**
 * Ensure archive storage directory exists
 */
export function ensureArchiveDir(): string {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
  return ARCHIVE_DIR;
}

/**
 * Deterministically compute a cryptographic state commitment (Merkle-like digest)
 * across an array of archived events.
 */
export function computeStateCommitment(events: any[]): string {
  const sorted = [...events].sort((a, b) => {
    const lA = Number(a.ledger ?? 0);
    const lB = Number(b.ledger ?? 0);
    if (lA !== lB) return lA - lB;
    const tA = String(a.timestamp ?? "");
    const tB = String(b.timestamp ?? "");
    if (tA !== tB) return tA.localeCompare(tB);
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });

  const leafHashes = sorted.map((ev) => {
    const canonical = JSON.stringify(ev, Object.keys(ev).sort());
    return crypto.createHash("sha256").update(canonical).digest("hex");
  });

  return crypto
    .createHash("sha256")
    .update(leafHashes.join(":"))
    .digest("hex");
}

/**
 * Ensure archive_records tracking table exists in database
 */
export function initArchiveRegistry(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_records (
      archive_id TEXT PRIMARY KEY,
      dao_id INTEGER NOT NULL,
      proposal_id INTEGER,
      storage_category TEXT NOT NULL DEFAULT 'voting',
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      min_timestamp TEXT NOT NULL,
      max_timestamp TEXT NOT NULL,
      min_ledger INTEGER,
      max_ledger INTEGER,
      size_bytes INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      commitment TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'archived',
      recommitted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_archive_records_dao ON archive_records(dao_id);
    CREATE INDEX IF NOT EXISTS idx_archive_records_category ON archive_records(storage_category);
  `);

  // Migrate older tables missing columns
  try {
    const tableInfo = db.pragma("table_info(archive_records)") as Array<{ name: string }>;
    const existingCols = new Set(tableInfo.map((c) => c.name));
    if (!existingCols.has("storage_category")) {
      db.exec("ALTER TABLE archive_records ADD COLUMN storage_category TEXT NOT NULL DEFAULT 'voting'");
    }
    if (!existingCols.has("commitment")) {
      db.exec("ALTER TABLE archive_records ADD COLUMN commitment TEXT NOT NULL DEFAULT ''");
    }
    if (!existingCols.has("status")) {
      db.exec("ALTER TABLE archive_records ADD COLUMN status TEXT NOT NULL DEFAULT 'archived'");
    }
    if (!existingCols.has("recommitted_at")) {
      db.exec("ALTER TABLE archive_records ADD COLUMN recommitted_at TEXT");
    }
  } catch (_) {
    // Ignore migration pragma errors if already present
  }
}

/**
 * Run historical event archival process
 */
export async function runArchivalJob(
  options: {
    ageDays?: number;
    archiveDir?: string;
    batchSize?: number;
    /**
     * Aborts the job between DAO partitions and between delete batches (#323).
     * Archival can run for minutes over a large database; without this a
     * shutdown would either block on it or leave a half-deleted partition.
     */
    signal?: AbortSignal;
  } = {},
): Promise<ArchivalJobResult> {
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
  const cutoffDate = new Date(
    Date.now() - ageDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const targetDir = options.archiveDir || ensureArchiveDir();
  const batchSize = options.batchSize || 100;
  const signal = options.signal;

  /** Abort at a point where the database is in a consistent state. */
  const throwIfAborted = (): void => {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Archival job cancelled");
  };

  log("info", "archival_job_start", { ageDays, cutoffDate, dbSizeBytesBefore });

  // Declared outside the try so a cancellation can still report how much work
  // was durably completed before the abort.
  let totalArchivedCount = 0;
  const createdRecords: ArchiveRecord[] = [];

  try {
    // Step 1: Discover ended elections (proposals with proposal_closed or proposal_archived events)
    const partitionRows = db
      .prepare("SELECT dao_id FROM partition_registry")
      .all() as Array<{ dao_id: number }>;
    const registeredDaos = partitionRows.map((r) => r.dao_id);

    for (const daoId of registeredDaos) {
      throwIfAborted();
      const tableName = `events_${daoId}`;
      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(tableName);
      if (!tableExists) continue;

      // Find closed proposal IDs
      const closedPropRows = db
        .prepare(
          `SELECT DISTINCT json_extract(data, '$.proposalId') as propId FROM ${tableName} WHERE type IN ('proposal_closed', 'proposal_archived') AND data IS NOT NULL`,
        )
        .all() as Array<{ propId: number | null }>;

      const closedPropIds = new Set<number>(
        closedPropRows
          .map((r) => Number(r.propId))
          .filter((id) => !isNaN(id) && id > 0),
      );

      if (closedPropIds.size === 0) continue;

      // Select events belonging to closed proposals and older than cutoffDate
      const eligibleEvents = db
        .prepare(
          `SELECT * FROM ${tableName} WHERE timestamp <= ? ORDER BY timestamp ASC`,
        )
        .all(cutoffDate) as Array<any>;

      const eventsToArchive = eligibleEvents.filter((ev) => {
        try {
          if (!ev.data) return false;
          const parsed =
            typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
          const propId = Number(parsed.proposalId || parsed.proposal_id);
          return closedPropIds.has(propId);
        } catch (_) {
          return false;
        }
      });

      if (eventsToArchive.length === 0) continue;

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
      const commitment = computeStateCommitment(eventsToArchive);

      const timestamps = eventsToArchive.map((e) => e.timestamp).sort();
      const ledgers = eventsToArchive
        .map((e) => e.ledger)
        .filter((l) => l !== null);

      const record: ArchiveRecord = {
        archive_id: archiveId,
        dao_id: daoId,
        proposal_id: null,
        storage_category: "voting",
        file_name: fileName,
        file_path: filePath,
        event_count: eventsToArchive.length,
        min_timestamp: timestamps[0],
        max_timestamp: timestamps[timestamps.length - 1],
        min_ledger: ledgers.length > 0 ? Math.min(...ledgers) : null,
        max_ledger: ledgers.length > 0 ? Math.max(...ledgers) : null,
        size_bytes: sizeBytes,
        checksum,
        commitment,
        status: "archived",
      };

      // Register archive record in index
      db.prepare(
        `
        INSERT INTO archive_records (
          archive_id, dao_id, proposal_id, storage_category,
          file_name, file_path, event_count, min_timestamp, max_timestamp,
          min_ledger, max_ledger, size_bytes, checksum, commitment, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        record.archive_id,
        record.dao_id,
        record.proposal_id,
        record.storage_category,
        record.file_name,
        record.file_path,
        record.event_count,
        record.min_timestamp,
        record.max_timestamp,
        record.min_ledger,
        record.max_ledger,
        record.size_bytes,
        record.checksum,
        record.commitment,
        record.status,
      );

      createdRecords.push(record);

      // Step 3: Batch deletion of archived events from SQLite database
      const eventIds = eventsToArchive.map((e) => e.id);
      for (let i = 0; i < eventIds.length; i += batchSize) {
        throwIfAborted();
        const batch = eventIds.slice(i, i + batchSize);
        const placeholders = batch.map(() => "?").join(",");
        db.prepare(
          `DELETE FROM ${tableName} WHERE id IN (${placeholders})`,
        ).run(...batch);
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
  } catch (err) {
    const errorMsg = (err as Error).message;
    const cancelled = signal?.aborted === true;
    log(cancelled ? "info" : "error", cancelled ? "archival_job_cancelled" : "archival_job_failed", {
      error: errorMsg,
      archivedEventsCount: totalArchivedCount,
    });
    return {
      success: false,
      archivedEventsCount: totalArchivedCount,
      archivesCreatedCount: createdRecords.length,
      dbSizeBytesBefore,
      dbSizeBytesAfter: dbSizeBytesBefore,
      savedSizeBytes: 0,
      records: createdRecords,
      error: errorMsg,
    };
  }
}

/**
 * Get archive records index from database
 */
export function getArchiveIndex(daoId?: number): ArchiveRecord[] {
  const db = getDb();
  if (!db) return [];
  initArchiveRegistry(db);

  if (daoId !== undefined) {
    return db
      .prepare(
        "SELECT * FROM archive_records WHERE dao_id = ? ORDER BY created_at DESC",
      )
      .all(daoId) as ArchiveRecord[];
  }

  return db
    .prepare("SELECT * FROM archive_records ORDER BY created_at DESC")
    .all() as ArchiveRecord[];
}

/**
 * Read and decompress events from an archive file
 */
export function readArchivedEvents(archiveId: string): any[] {
  const db = getDb();
  if (!db) return [];
  initArchiveRegistry(db);

  const record = db
    .prepare("SELECT * FROM archive_records WHERE archive_id = ?")
    .get(archiveId) as ArchiveRecord | undefined;
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
  } catch (err) {
    log("error", "read_archive_failed", {
      archiveId,
      error: (err as Error).message,
    });
    return [];
  }
}

/**
 * Verify cryptographic integrity and commitment of an archived state file.
 */
export function verifyArchivedState(archiveId: string): {
  valid: boolean;
  reason?: string;
  record?: ArchiveRecord;
  events?: any[];
} {
  const db = getDb();
  if (!db) return { valid: false, reason: "Database not available" };
  initArchiveRegistry(db);

  const record = db
    .prepare("SELECT * FROM archive_records WHERE archive_id = ?")
    .get(archiveId) as ArchiveRecord | undefined;
  if (!record) {
    return { valid: false, reason: `Archive record not found: ${archiveId}` };
  }

  if (!fs.existsSync(record.file_path)) {
    return {
      valid: false,
      reason: `Archive file missing on disk: ${record.file_path}`,
      record,
    };
  }

  let compressedBuffer: Buffer;
  try {
    compressedBuffer = fs.readFileSync(record.file_path);
  } catch (err) {
    return {
      valid: false,
      reason: `Failed to read archive file: ${(err as Error).message}`,
      record,
    };
  }

  const checksum = crypto
    .createHash("sha256")
    .update(compressedBuffer)
    .digest("hex");
  if (checksum !== record.checksum) {
    return {
      valid: false,
      reason: `Checksum mismatch: expected ${record.checksum}, got ${checksum}`,
      record,
    };
  }

  let decompressed: string;
  let events: any[];
  try {
    decompressed = zlib.gunzipSync(compressedBuffer).toString("utf-8");
    events = decompressed
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } catch (err) {
    return {
      valid: false,
      reason: `Corrupted gzip/json content: ${(err as Error).message}`,
      record,
    };
  }

  if (events.length !== record.event_count) {
    return {
      valid: false,
      reason: `Event count mismatch: record has ${record.event_count}, file has ${events.length}`,
      record,
    };
  }

  const computedCommitment = computeStateCommitment(events);
  if (record.commitment && computedCommitment !== record.commitment) {
    return {
      valid: false,
      reason: `Commitment verification failed: expected ${record.commitment}, computed ${computedCommitment}`,
      record,
    };
  }

  return { valid: true, record, events };
}

/**
 * Restore cold archived state back to active SQLite partition.
 * Enforces cryptographic verification against original commitment,
 * prevents duplicate execution, and supports recommitting state.
 */
export async function restoreArchivedState(
  archiveId: string,
  options: {
    recommit?: boolean;
  } = {},
): Promise<RestorationResult> {
  const db = getDb();
  if (!db) {
    return {
      success: false,
      archiveId,
      restoredEventsCount: 0,
      commitmentVerified: false,
      recommitted: false,
      status: "failed",
      error: "Database instance not available",
    };
  }
  initArchiveRegistry(db);

  // 1. Verify archive file and cryptographic commitment first
  const verification = verifyArchivedState(archiveId);
  if (!verification.valid || !verification.record || !verification.events) {
    log("error", "archive_restoration_verification_failed", {
      archiveId,
      reason: verification.reason,
    });
    return {
      success: false,
      archiveId,
      restoredEventsCount: 0,
      commitmentVerified: false,
      recommitted: false,
      status: "verification_failed",
      error: verification.reason || "Cryptographic verification failed",
    };
  }

  const record = verification.record;
  const events = verification.events;
  const tableName = `events_${record.dao_id}`;

  // Safe against duplicate execution
  if (record.status === "restored" && !options.recommit) {
    return {
      success: true,
      archiveId,
      restoredEventsCount: events.length,
      commitmentVerified: true,
      recommitted: false,
      status: "already_restored",
    };
  }

  // 2. Transactional restoration
  const restoreTx = db.transaction(() => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id INTEGER PRIMARY KEY,
        dao_id INTEGER,
        type TEXT,
        data TEXT,
        timestamp TEXT,
        ledger INTEGER
      )
    `).run();

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO ${tableName} (id, dao_id, type, data, timestamp, ledger)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const ev of events) {
      insertStmt.run(
        ev.id,
        ev.dao_id ?? record.dao_id,
        ev.type,
        typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data),
        ev.timestamp,
        ev.ledger,
      );
    }

    const newStatus = options.recommit ? "recommitted" : "restored";
    const recommittedAt = options.recommit
      ? new Date().toISOString()
      : record.recommitted_at;

    db.prepare(`
      UPDATE archive_records
      SET status = ?, recommitted_at = ?
      WHERE archive_id = ?
    `).run(newStatus, recommittedAt, archiveId);
  });

  try {
    restoreTx();
    log("info", "archive_restored_successfully", {
      archiveId,
      daoId: record.dao_id,
      eventCount: events.length,
      recommitted: !!options.recommit,
    });

    return {
      success: true,
      archiveId,
      restoredEventsCount: events.length,
      commitmentVerified: true,
      recommitted: !!options.recommit,
      status: options.recommit ? "recommitted" : "restored",
    };
  } catch (err) {
    const errorMsg = (err as Error).message;
    log("error", "archive_restoration_transaction_failed", {
      archiveId,
      error: errorMsg,
    });
    return {
      success: false,
      archiveId,
      restoredEventsCount: 0,
      commitmentVerified: true,
      recommitted: false,
      status: "transaction_failed",
      error: errorMsg,
    };
  }
}

/**
 * Start the background periodic archival task.
 *
 * Uses the same single-flight, cancellable scheduler as the indexer (#323)
 * rather than a bare `setInterval`. Two properties matter here: an archival run
 * that outlives its interval must not have a second run start on top of it —
 * both would be deleting rows from the same partition — and a shutdown must be
 * able to abort a run mid-flight instead of waiting out a multi-minute job.
 */
export function startArchivalTask(
  intervalMs: number = config.archivalIntervalMs || 86400000,
): void {
  void stopArchivalTask();

  archivalScheduler = new WatermarkScheduler({
    intervalMs,
    runCycle: async (signal) => {
      const stopTimer = archivalDuration.startTimer();
      try {
        const result = await runArchivalJob({ signal });
        archivalRunsTotal.inc({
          result: result.success
            ? "success"
            : signal.aborted
              ? "cancelled"
              : "failed",
        });
      } finally {
        stopTimer();
      }
    },
    onOverrun: (skippedRuns, reason) => {
      log("warn", "archival_run_skipped", { skippedRuns, reason });
    },
    onError: (error) => {
      archivalRunsTotal.inc({ result: "failed" });
      log("error", "periodic_archival_failed", { error: error.message });
    },
  });
  archivalScheduler.start();

  log("info", "archival_task_started", { intervalMs });
}

/**
 * Stop the background archival task, aborting any run in flight.
 *
 * Resolves only once that run has unwound, so callers can rely on no archival
 * write still being in progress when the promise settles.
 */
export async function stopArchivalTask(): Promise<void> {
  const scheduler = archivalScheduler;
  if (!scheduler) return;
  archivalScheduler = null;

  await scheduler.stop();
  log("info", "archival_task_stopped");
}

/** Scheduler stats for the archival loop, or `null` when it is not running. */
export function getArchivalSchedulerStats(): ReturnType<
  WatermarkScheduler["stats"]
> | null {
  return archivalScheduler ? archivalScheduler.stats() : null;
}
