/**
 * SQLite Database for ZKVote Event Storage
 *
 * Provides persistent storage for events with efficient querying.
 * Supports frontend notifications with on-chain verification.
 *
 * Partitioning Strategy (2026-07-27):
 * Events are stored in per-DAO tables (events_{daoId}) to avoid a single
 * monolithic events table becoming a bottleneck as the platform scales.
 * Cross-DAO queries use UNION ALL across all known partitions.
 */
import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { timeQuery, invalidateCachePrefix, getDbStats as getMonitorDbStats, profileEventQueries, } from "./dbMonitor.js";
import { migrateUp } from "./migrate.js";
import { kysely } from "./kysely.js";
import { sql } from "kysely";
import { initWalResilience, configureWalResilience, incrementTransactionCounter, } from "./walResilience.js";
import { config } from "../config.js";
/** Object holder avoids TDZ if metrics wires during circular ESM init. */
const metricsState = { sink: null };
export function setDbMetricsSink(sink) {
    metricsState.sink = sink;
}
function metricsSink() {
    return metricsState.sink;
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DB_FILE = path.join(DATA_DIR, "zkvote.db");
// ============================================
// SCHEMA VERSIONING
// ============================================
const CURRENT_SCHEMA_VERSION = 2;
const EXPECTED_SCHEMA = {
    events: {
        columns: [
            { name: "id", type: "INTEGER", notNull: true, primaryKey: true },
            { name: "dao_id", type: "INTEGER", notNull: true, primaryKey: false },
            { name: "type", type: "TEXT", notNull: true, primaryKey: false },
            { name: "data", type: "TEXT", notNull: false, primaryKey: false },
            { name: "ledger", type: "INTEGER", notNull: false, primaryKey: false },
            { name: "tx_hash", type: "TEXT", notNull: false, primaryKey: false },
            { name: "timestamp", type: "TEXT", notNull: true, primaryKey: false },
            { name: "verified", type: "INTEGER", notNull: false, primaryKey: false },
            { name: "created_at", type: "TEXT", notNull: false, primaryKey: false },
        ],
        indexes: [
            { name: "idx_events_dao_id", columns: ["dao_id"] },
            { name: "idx_events_type", columns: ["type"] },
            { name: "idx_events_timestamp", columns: ["timestamp"] },
            { name: "idx_events_ledger", columns: ["ledger"] },
            { name: "idx_events_dao_type", columns: ["dao_id", "type"] },
        ],
    },
    metadata: {
        columns: [
            { name: "key", type: "TEXT", notNull: true, primaryKey: true },
            { name: "value", type: "TEXT", notNull: false, primaryKey: false },
        ],
        indexes: [],
    },
    daos: {
        columns: [
            { name: "id", type: "INTEGER", notNull: true, primaryKey: true },
            { name: "name", type: "TEXT", notNull: true, primaryKey: false },
            { name: "creator", type: "TEXT", notNull: true, primaryKey: false },
            {
                name: "membership_open",
                type: "INTEGER",
                notNull: false,
                primaryKey: false,
            },
            {
                name: "members_can_propose",
                type: "INTEGER",
                notNull: false,
                primaryKey: false,
            },
            { name: "metadata_cid", type: "TEXT", notNull: false, primaryKey: false },
            {
                name: "member_count",
                type: "INTEGER",
                notNull: false,
                primaryKey: false,
            },
            { name: "updated_at", type: "TEXT", notNull: false, primaryKey: false },
        ],
        indexes: [],
    },
    comment_submissions: {
        columns: [
            { name: "commitment", type: "TEXT", notNull: true, primaryKey: true },
            { name: "dao_id", type: "INTEGER", notNull: true, primaryKey: true },
            { name: "proposal_id", type: "INTEGER", notNull: true, primaryKey: true },
            {
                name: "window_start",
                type: "INTEGER",
                notNull: true,
                primaryKey: true,
            },
            { name: "count", type: "INTEGER", notNull: false, primaryKey: false },
        ],
        indexes: [],
    },
    comment_flags: {
        columns: [
            { name: "id", type: "INTEGER", notNull: false, primaryKey: false },
            { name: "comment_id", type: "INTEGER", notNull: true, primaryKey: false },
            { name: "dao_id", type: "INTEGER", notNull: true, primaryKey: false },
            {
                name: "proposal_id",
                type: "INTEGER",
                notNull: true,
                primaryKey: false,
            },
            {
                name: "flagger_commitment",
                type: "TEXT",
                notNull: true,
                primaryKey: false,
            },
            {
                name: "flagger_nullifier",
                type: "TEXT",
                notNull: true,
                primaryKey: false,
            },
            { name: "created_at", type: "TEXT", notNull: false, primaryKey: false },
        ],
        indexes: [],
    },
    hidden_comments: {
        columns: [
            { name: "comment_id", type: "INTEGER", notNull: true, primaryKey: true },
            { name: "dao_id", type: "INTEGER", notNull: true, primaryKey: true },
            { name: "proposal_id", type: "INTEGER", notNull: true, primaryKey: true },
            {
                name: "flag_count",
                type: "INTEGER",
                notNull: false,
                primaryKey: false,
            },
            { name: "hidden_at", type: "TEXT", notNull: false, primaryKey: false },
        ],
        indexes: [],
    },
    ttl_tracking: {
        columns: [
            { name: "entry_id", type: "TEXT", notNull: true, primaryKey: true },
            { name: "contract_id", type: "TEXT", notNull: true, primaryKey: false },
            { name: "dao_id", type: "INTEGER", notNull: false, primaryKey: false },
            { name: "method", type: "TEXT", notNull: false, primaryKey: false },
            {
                name: "last_renewed_at",
                type: "TEXT",
                notNull: false,
                primaryKey: false,
            },
            {
                name: "remaining_ledgers",
                type: "INTEGER",
                notNull: false,
                primaryKey: false,
            },
            { name: "urgency", type: "TEXT", notNull: false, primaryKey: false },
        ],
        indexes: [
            { name: "idx_ttl_tracking_urgency", columns: ["urgency"] },
            { name: "idx_ttl_tracking_contract", columns: ["contract_id"] },
        ],
    },
    ttl_cost_log: {
        columns: [
            { name: "id", type: "INTEGER", notNull: true, primaryKey: true },
            { name: "cycle_id", type: "TEXT", notNull: true, primaryKey: false },
            { name: "cycle_start", type: "TEXT", notNull: false, primaryKey: false },
            { name: "cycle_end", type: "TEXT", notNull: false, primaryKey: false },
            {
                name: "entries_renewed",
                type: "INTEGER",
                notNull: false,
                primaryKey: false,
            },
            {
                name: "entries_skipped",
                type: "INTEGER",
                notNull: false,
                primaryKey: false,
            },
            { name: "tx_count", type: "INTEGER", notNull: false, primaryKey: false },
            {
                name: "total_fee_xlm",
                type: "REAL",
                notNull: false,
                primaryKey: false,
            },
            { name: "status", type: "TEXT", notNull: false, primaryKey: false },
        ],
        indexes: [{ name: "idx_ttl_cost_cycle", columns: ["cycle_id"] }],
    },
    auth_tokens: {
        columns: [
            { name: "id", type: "TEXT", notNull: true, primaryKey: true },
            { name: "token_hash", type: "TEXT", notNull: true, primaryKey: false },
            { name: "client_id", type: "TEXT", notNull: true, primaryKey: false },
            { name: "description", type: "TEXT", notNull: false, primaryKey: false },
            { name: "status", type: "TEXT", notNull: true, primaryKey: false },
            { name: "created_at", type: "TEXT", notNull: true, primaryKey: false },
            { name: "expires_at", type: "TEXT", notNull: false, primaryKey: false },
            { name: "revoked_at", type: "TEXT", notNull: false, primaryKey: false },
            { name: "last_used_at", type: "TEXT", notNull: false, primaryKey: false },
            { name: "use_count", type: "INTEGER", notNull: true, primaryKey: false },
            {
                name: "rotation_group_id",
                type: "TEXT",
                notNull: false,
                primaryKey: false,
            },
            { name: "is_legacy", type: "INTEGER", notNull: true, primaryKey: false },
        ],
        indexes: [
            { name: "idx_auth_tokens_token_hash", columns: ["token_hash"] },
            { name: "idx_auth_tokens_client_id", columns: ["client_id"] },
            { name: "idx_auth_tokens_status", columns: ["status"] },
            { name: "idx_auth_tokens_expires_at", columns: ["expires_at"] },
            {
                name: "idx_auth_tokens_rotation_group",
                columns: ["rotation_group_id"],
            },
        ],
    },
    auth_token_audit: {
        columns: [
            { name: "id", type: "INTEGER", notNull: true, primaryKey: true },
            { name: "token_id", type: "TEXT", notNull: false, primaryKey: false },
            { name: "client_id", type: "TEXT", notNull: false, primaryKey: false },
            { name: "action", type: "TEXT", notNull: true, primaryKey: false },
            { name: "path", type: "TEXT", notNull: false, primaryKey: false },
            { name: "method", type: "TEXT", notNull: false, primaryKey: false },
            { name: "ip_hash", type: "TEXT", notNull: false, primaryKey: false },
            { name: "success", type: "INTEGER", notNull: true, primaryKey: false },
            {
                name: "error_message",
                type: "TEXT",
                notNull: false,
                primaryKey: false,
            },
            { name: "created_at", type: "TEXT", notNull: true, primaryKey: false },
        ],
        indexes: [
            { name: "idx_auth_audit_token_id", columns: ["token_id"] },
            { name: "idx_auth_audit_client_id", columns: ["client_id"] },
            { name: "idx_auth_audit_action", columns: ["action"] },
            { name: "idx_auth_audit_created_at", columns: ["created_at"] },
        ],
    },
    vote_submissions: {
        columns: [
            { name: "id", type: "INTEGER", notNull: true, primaryKey: true },
            {
                name: "nullifier_hash",
                type: "TEXT",
                notNull: true,
                primaryKey: false,
            },
            { name: "status", type: "TEXT", notNull: true, primaryKey: false },
            { name: "tx_hash", type: "TEXT", notNull: false, primaryKey: false },
            { name: "created_at", type: "INTEGER", notNull: true, primaryKey: false },
            { name: "updated_at", type: "INTEGER", notNull: true, primaryKey: false },
        ],
        indexes: [
            { name: "idx_vote_submissions_nullifier", columns: ["nullifier_hash"] },
        ],
    },
    proof_commitments: {
        columns: [
            {
                name: "commitment_hash",
                type: "TEXT",
                notNull: true,
                primaryKey: true,
            },
            { name: "nullifier", type: "TEXT", notNull: true, primaryKey: false },
            { name: "dao_id", type: "INTEGER", notNull: true, primaryKey: false },
            {
                name: "proposal_id",
                type: "INTEGER",
                notNull: true,
                primaryKey: false,
            },
            {
                name: "wallet_address",
                type: "TEXT",
                notNull: false,
                primaryKey: false,
            },
            { name: "timestamp", type: "INTEGER", notNull: true, primaryKey: false },
            { name: "status", type: "TEXT", notNull: true, primaryKey: false },
            { name: "created_at", type: "TEXT", notNull: true, primaryKey: false },
        ],
        indexes: [
            { name: "idx_commitments_nullifier", columns: ["nullifier"] },
            { name: "idx_commitments_wallet", columns: ["wallet_address"] },
        ],
    },
};
function normalizeType(t) {
    const u = t.toUpperCase().trim();
    if (["INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT"].includes(u))
        return "INTEGER";
    if (["TEXT", "VARCHAR", "NVARCHAR", "CHAR", "CLOB"].includes(u))
        return "TEXT";
    if (["REAL", "FLOAT", "DOUBLE"].includes(u))
        return "REAL";
    if (["NUMERIC", "DECIMAL"].includes(u))
        return "NUMERIC";
    if (u === "BLOB")
        return "BLOB";
    return u;
}
// ============================================
// SECURITY: ALLOWLISTS FOR INJECTION PREVENTION
// ============================================
/** Allowlisted event types for dynamic filtering */
const ALLOWED_EVENT_TYPES = new Set([
    "dao_create",
    "admin_transfer",
    "member_added",
    "member_revoked",
    "member_left",
    "tree_init",
    "voter_registered",
    "voter_removed",
    "voter_reinstated",
    "vk_updated",
    "proposal_created",
    "proposal_closed",
    "proposal_archived",
    "vote_cast",
    "sbt_transfer_attempt",
]);
/** Allowlisted column names for dynamic ORDER BY clauses */
const ALLOWED_ORDER_COLUMNS = new Set([
    "id",
    "timestamp",
    "ledger",
    "type",
    "verified",
    "created_at",
]);
/** Allowlisted sort directions */
const ALLOWED_SORT_DIRECTIONS = new Set(["ASC", "DESC"]);
/**
 * Validate and sanitize DAO ID to prevent table name injection
 */
function validateDaoId(daoId) {
    if (!Number.isInteger(daoId) || daoId < 1 || daoId > 999999) {
        throw new Error(`Invalid DAO ID: ${daoId}. Must be positive integer ≤ 999999`);
    }
    return daoId;
}
/**
 * Validate event types against allowlist
 */
function validateEventTypes(types) {
    const invalid = types.filter((type) => !ALLOWED_EVENT_TYPES.has(type));
    if (invalid.length > 0) {
        throw new Error(`Invalid event types: ${invalid.join(", ")}`);
    }
    return types;
}
/**
 * Decode a base64-encoded cursor back into its components.
 */
function decodeCursor(cursor, cursorField) {
    try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
        return decoded;
    }
    catch {
        return {};
    }
}
/**
 * Validate and sanitize ORDER BY parameters
 */
function validateOrderBy(column, direction = "DESC") {
    if (!ALLOWED_ORDER_COLUMNS.has(column)) {
        throw new Error(`Invalid order column: ${column}. Allowed: ${Array.from(ALLOWED_ORDER_COLUMNS).join(", ")}`);
    }
    const normalizedDirection = direction.toUpperCase();
    if (!ALLOWED_SORT_DIRECTIONS.has(normalizedDirection)) {
        throw new Error(`Invalid sort direction: ${direction}. Allowed: ASC, DESC`);
    }
    return { column, direction: normalizedDirection };
}
// ============================================
// LOGGER WITH QUERY LOGGING
// ============================================
import { createLogger } from "./logger.js";
const dbLogger = createLogger("db");
const log = (level, event, meta = {}) => {
    dbLogger[level](event, meta);
};
/**
 * Log SQL queries with parameter redaction for security
 */
function logQuery(query, params = [], operation) {
    // Redact sensitive parameters (keep first 4 chars for debugging)
    const redactedParams = params.map((param, index) => {
        if (typeof param === "string" && param.length > 8) {
            return `${param.slice(0, 4)}****[REDACTED]`;
        }
        return param;
    });
    log("debug", "sql_query_executed", {
        operation,
        query: query.replace(/\s+/g, " ").trim(),
        paramCount: params.length,
        redactedParams: redactedParams.slice(0, 5), // Limit to first 5 params
    });
}
// ============================================
// DATABASE INSTANCES (write + readonly read)
// ============================================
/** Write connection — indexer, sync, migrations, mutating API. */
let writeDb = null;
/** Readonly connection — API query path (same file, WAL concurrent readers). */
let readDb = null;
let activeDbFile = DB_FILE;
let writeHealthy = true;
let writeFailureReason = null;
let lastWriteAtMs = 0;
/** Cache of known partition tables (events_{daoId}) to avoid redundant DDL */
const knownPartitions = new Set();
export class WriteConnectionUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = "WriteConnectionUnavailableError";
    }
}
function countActiveConnections() {
    return (writeDb ? 1 : 0) + (readDb ? 1 : 0);
}
function updateConnectionGauges() {
    const sink = metricsSink();
    if (!sink)
        return;
    try {
        sink.setConnectionsActive(countActiveConnections());
        sink.setWriteHealthy(writeHealthy && Boolean(writeDb));
        sink.setWalSizeBytes(getWalSizeBytes(activeDbFile));
    }
    catch {
        // Metrics sink may throw if registry is torn down in tests
    }
}
export function getWalSizeBytes(dbFile = activeDbFile) {
    const walPath = `${dbFile}-wal`;
    try {
        if (fs.existsSync(walPath))
            return fs.statSync(walPath).size;
    }
    catch {
        /* ignore */
    }
    return 0;
}
function readDataVersion(database) {
    const ver = database.pragma("data_version", { simple: true });
    return typeof ver === "number" ? ver : Number(ver) || 0;
}
/**
 * Estimate how far the read connection lags the writer.
 * Same-file WAL readers typically see lag ≈ 0 once the write commits;
 * a version mismatch reports time since the last successful write.
 */
export function getReadReplicaLagMs() {
    if (!writeDb || !readDb)
        return 0;
    try {
        const writeVer = readDataVersion(writeDb);
        const readVer = readDataVersion(readDb);
        if (writeVer === readVer) {
            try {
                metricsSink()?.setReadLagMs(0);
            }
            catch {
                /* ignore */
            }
            return 0;
        }
        const lag = lastWriteAtMs > 0 ? Math.max(0, Date.now() - lastWriteAtMs) : 0;
        try {
            metricsSink()?.setReadLagMs(lag);
        }
        catch {
            /* ignore */
        }
        return lag;
    }
    catch {
        return 0;
    }
}
function markWriteSuccess() {
    writeHealthy = true;
    writeFailureReason = null;
    lastWriteAtMs = Date.now();
    updateConnectionGauges();
    getReadReplicaLagMs();
}
function markWriteFailure(err) {
    writeHealthy = false;
    writeFailureReason = err instanceof Error ? err.message : String(err);
    log("error", "db_write_connection_failed", { error: writeFailureReason });
    updateConnectionGauges();
}
function isConnectionError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err?.code ?? "";
    return (code === "SQLITE_BUSY" ||
        code === "SQLITE_LOCKED" ||
        code === "SQLITE_IOERR" ||
        code === "SQLITE_CANTOPEN" ||
        code === "SQLITE_NOTADB" ||
        /SQLITE_(BUSY|LOCKED|IOERR|CANTOPEN|CORRUPT)/i.test(msg) ||
        /database is (locked|closed|not open)/i.test(msg));
}
function openWriteConnection(dbFile) {
    const database = new Database(dbFile);
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    try {
        database.pragma("strict = ON");
        log("info", "sqlite_strict_mode_enabled");
    }
    catch (err) {
        log("warn", "sqlite_strict_mode_unavailable", {
            error: err.message,
        });
    }
    return database;
}
function openReadConnection(dbFile) {
    const database = new Database(dbFile, {
        readonly: true,
        fileMustExist: true,
    });
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    try {
        database.pragma("query_only = ON");
    }
    catch {
        // query_only may be unavailable on older SQLite builds
    }
    return database;
}
/**
 * Attempt to reopen the write connection after failure.
 * Read connection is left open so API queries can continue in degraded mode.
 */
export function reconnectWriteDb() {
    if (!activeDbFile)
        return false;
    try {
        if (writeDb) {
            try {
                writeDb.close();
            }
            catch {
                /* already closed */
            }
            writeDb = null;
        }
        writeDb = openWriteConnection(activeDbFile);
        writeDb.prepare("SELECT 1").get();
        markWriteSuccess();
        try {
            metricsSink()?.incWriteFailover("success");
        }
        catch {
            /* ignore */
        }
        log("info", "db_write_reconnect_success", { path: activeDbFile });
        return true;
    }
    catch (err) {
        markWriteFailure(err);
        try {
            metricsSink()?.incWriteFailover("failure");
        }
        catch {
            /* ignore */
        }
        log("error", "db_write_reconnect_failed", {
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    }
}
/** Reopen the readonly connection (e.g. after restore / WAL truncate). */
export function reopenReadDb() {
    if (!activeDbFile || !fs.existsSync(activeDbFile))
        return;
    if (readDb) {
        try {
            readDb.close();
        }
        catch {
            /* ignore */
        }
        readDb = null;
    }
    try {
        readDb = openReadConnection(activeDbFile);
        updateConnectionGauges();
        log("info", "db_read_reopened", { path: activeDbFile });
    }
    catch (err) {
        log("warn", "db_read_reopen_failed", {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
export function isWriteConnectionHealthy() {
    return Boolean(writeHealthy && writeDb);
}
export function getWriteFailureReason() {
    return writeFailureReason;
}
/**
 * Return the write connection (initializing if needed).
 * On connection-level failure, attempts one reconnect (failover).
 * Does not switch away from an already-open custom dbPath.
 */
export function getWriteDb() {
    if (writeDb) {
        try {
            writeDb.prepare("SELECT 1").get();
            if (!writeHealthy) {
                if (!reconnectWriteDb() || !writeDb) {
                    throw new WriteConnectionUnavailableError(writeFailureReason ?? "write database unavailable");
                }
            }
            return writeDb;
        }
        catch (err) {
            if (isConnectionError(err)) {
                markWriteFailure(err);
                if (reconnectWriteDb() && writeDb)
                    return writeDb;
            }
            throw err instanceof Error
                ? err
                : new WriteConnectionUnavailableError(String(err));
        }
    }
    initDb();
    if (!writeDb) {
        throw new WriteConnectionUnavailableError(writeFailureReason ?? "write database is not initialized");
    }
    return writeDb;
}
/**
 * Return the readonly connection for API queries.
 * Falls back to the write connection if the read handle is unavailable
 * (degraded mode) so GET endpoints keep serving.
 */
export function getReadDb() {
    if (readDb) {
        try {
            readDb.prepare("SELECT 1").get();
            return readDb;
        }
        catch {
            reopenReadDb();
            if (readDb)
                return readDb;
        }
    }
    if (writeDb) {
        reopenReadDb();
        if (readDb)
            return readDb;
        log("warn", "db_read_fallback_to_write");
        return writeDb;
    }
    initDb();
    if (readDb)
        return readDb;
    if (writeDb) {
        log("warn", "db_read_fallback_to_write");
        return writeDb;
    }
    throw new Error("database is not initialized");
}
/**
 * Return the partition table name for a given DAO ID.
 * SECURITY: Validates DAO ID to prevent table name injection.
 */
function partitionTableName(daoId) {
    const validatedDaoId = validateDaoId(daoId);
    return `events_${validatedDaoId}`;
}
/** True if the DAO partition table exists (no DDL). Safe for readonly connections. */
function partitionTableExists(database, daoId) {
    if (knownPartitions.has(daoId))
        return true;
    const tableName = partitionTableName(daoId);
    const row = database
        .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?`)
        .get(tableName);
    if (row) {
        knownPartitions.add(daoId);
        return true;
    }
    return false;
}
/**
 * Ensure a partition table exists for the given DAO ID.
 * Idempotent — safe to call on every write. Always uses the write connection.
 * SECURITY: Uses validated table names and allowlisted event types.
 */
function ensurePartitionTable(daoId) {
    if (knownPartitions.has(daoId))
        return;
    const database = getWriteDb();
    const tableName = partitionTableName(daoId); // This validates daoId
    // SECURITY: Use allowlisted event types in CHECK constraint
    const allowedEventTypesString = Array.from(ALLOWED_EVENT_TYPES)
        .map((type) => `'${type}'`)
        .join(",");
    const createTableSQL = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN (${allowedEventTypesString})),
      data TEXT, -- JSON
      ledger INTEGER,
      tx_hash TEXT,
      timestamp TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0, 1)),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(ledger, tx_hash, type)
    );
    CREATE INDEX IF NOT EXISTS idx_${tableName}_type ON ${tableName}(type);
    CREATE INDEX IF NOT EXISTS idx_${tableName}_timestamp ON ${tableName}(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_${tableName}_ledger ON ${tableName}(ledger DESC);
    CREATE INDEX IF NOT EXISTS idx_${tableName}_verified ON ${tableName}(verified);
  `;
    logQuery(createTableSQL, [], "ensure_partition_table");
    database.exec(createTableSQL);
    knownPartitions.add(daoId);
    // Record this partition in metadata for cross-DAO queries
    recordPartitionDaoId(database, daoId);
    markWriteSuccess();
}
/**
 * Record a DAO ID in the partition registry so cross-DAO queries
 * can discover all existing partitions.
 */
function recordPartitionDaoId(database, daoId) {
    database
        .prepare("INSERT OR IGNORE INTO partition_registry (dao_id) VALUES (?)")
        .run(daoId);
}
/**
 * Get all registered DAO IDs from the partition registry.
 */
function getAllPartitionDaoIds(database) {
    const rows = database
        .prepare("SELECT dao_id FROM partition_registry ORDER BY dao_id ASC")
        .all();
    return rows.map((r) => r.dao_id);
}
// ============================================
// INITIALIZATION
// ============================================
/**
 * Initialize the database and migrate from the monolithic schema.
 * Opens a write connection plus a readonly read connection on the same
 * WAL-mode file for query isolation (issue #205).
 * SECURITY: Enables SQLite strict mode and WAL journaling.
 * @returns The write connection (backward compatible with prior callers).
 */
export function initDb(dbPath) {
    const dbFile = dbPath ?? DB_FILE;
    // Reuse open handles for the same file
    if (writeDb && activeDbFile === dbFile) {
        try {
            writeDb.prepare("SELECT 1").get();
            return writeDb;
        }
        catch {
            try {
                writeDb.close();
            }
            catch {
                /* ignore */
            }
            writeDb = null;
            try {
                readDb?.close();
            }
            catch {
                /* ignore */
            }
            readDb = null;
        }
    }
    // Switching files (or reopening after close): drop prior handles
    if (writeDb || readDb) {
        try {
            readDb?.close();
        }
        catch {
            /* ignore */
        }
        try {
            writeDb?.close();
        }
        catch {
            /* ignore */
        }
        writeDb = null;
        readDb = null;
        knownPartitions.clear();
    }
    if (!dbPath) {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
    }
    else {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
    activeDbFile = dbFile;
    let database = new Database(dbFile);
    // SECURITY: Enable WAL mode and foreign key constraints
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    // WAL Resilience: configure and initialize
    configureWalResilience({
        busyTimeoutMs: config.dbBusyTimeoutMs,
        checkpointIntervalMs: config.dbCheckpointIntervalMs,
        checkpointTransactionCount: config.dbCheckpointTransactionCount,
        walWarningThresholdBytes: config.dbWalWarningThresholdBytes,
        backupIntervalMs: config.dbBackupIntervalMs,
        retryCount: config.dbRetryCount,
        retryBaseDelayMs: config.dbRetryBaseDelayMs,
        retryMaxDelayMs: config.dbRetryMaxDelayMs,
    });
    initWalResilience(database, dbFile);
    // SECURITY: Enable strict mode if available (better-sqlite3 v8+)
    try {
        database = openWriteConnection(dbFile);
    }
    catch (err) {
        markWriteFailure(err);
        throw err;
    }
    // Create system tables (daos, metadata, partition_registry)
    database.exec(`
    -- Partition registry tracks which DAOs have their own event tables
    CREATE TABLE IF NOT EXISTS partition_registry (
      dao_id INTEGER PRIMARY KEY,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Metadata table for tracking state (feat: events partitioning, db monitoring, migration framework, and data integrity constraints)
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS daos (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      creator TEXT NOT NULL,
      membership_open INTEGER DEFAULT 1,
      members_can_propose INTEGER DEFAULT 0,
      metadata_cid TEXT,
      member_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS comment_submissions (
      commitment TEXT NOT NULL,
      dao_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (commitment, dao_id, proposal_id, window_start)
    );

    CREATE TABLE IF NOT EXISTS comment_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL,
      dao_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      flagger_commitment TEXT NOT NULL,
      flagger_nullifier TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(comment_id, dao_id, proposal_id, flagger_nullifier)
    );

    CREATE TABLE IF NOT EXISTS hidden_comments (
      comment_id INTEGER NOT NULL,
      dao_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      flag_count INTEGER DEFAULT 0,
      hidden_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (comment_id, dao_id, proposal_id)
    );

    CREATE TABLE IF NOT EXISTS ttl_tracking (
      entry_id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL,
      dao_id INTEGER,
      method TEXT,
      last_renewed_at TEXT,
      remaining_ledgers INTEGER,
      urgency TEXT DEFAULT 'unknown'
    );

    CREATE INDEX IF NOT EXISTS idx_ttl_tracking_urgency ON ttl_tracking(urgency);
    CREATE INDEX IF NOT EXISTS idx_ttl_tracking_contract ON ttl_tracking(contract_id);

    CREATE TABLE IF NOT EXISTS ttl_cost_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id TEXT NOT NULL,
      cycle_start TEXT,
      cycle_end TEXT,
      entries_renewed INTEGER DEFAULT 0,
      entries_skipped INTEGER DEFAULT 0,
      tx_count INTEGER DEFAULT 0,
      total_fee_xlm REAL DEFAULT 0.0,
      status TEXT DEFAULT 'pending'
    );

    CREATE INDEX IF NOT EXISTS idx_ttl_cost_cycle ON ttl_cost_log(cycle_id);

    CREATE TABLE IF NOT EXISTS transaction_log (
      nullifier_hash TEXT PRIMARY KEY,
      tx_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vote_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nullifier_hash TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'failed')),
      tx_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vote_submissions_nullifier ON vote_submissions(nullifier_hash);

    -- Auth tokens table: stores hashed authentication tokens with expiration and metadata
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      client_id TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT,
      revoked_at TEXT,
      last_used_at TEXT,
      use_count INTEGER NOT NULL DEFAULT 0,
      rotation_group_id TEXT,
      is_legacy INTEGER NOT NULL DEFAULT 0,
      CHECK(status IN ('active', 'expired', 'revoked', 'rotating'))
    );
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_token_hash ON auth_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_client_id ON auth_tokens(client_id);
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_status ON auth_tokens(status);
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires_at ON auth_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_rotation_group ON auth_tokens(rotation_group_id);

    -- Auth token audit log: records all token operations and usage
    CREATE TABLE IF NOT EXISTS auth_token_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT,
      client_id TEXT,
      action TEXT NOT NULL,
      path TEXT,
      method TEXT,
      ip_hash TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_auth_audit_token_id ON auth_token_audit(token_id);
    CREATE INDEX IF NOT EXISTS idx_auth_audit_client_id ON auth_token_audit(client_id);
    CREATE INDEX IF NOT EXISTS idx_auth_audit_action ON auth_token_audit(action);
    CREATE INDEX IF NOT EXISTS idx_auth_audit_created_at ON auth_token_audit(created_at);
    CREATE TABLE IF NOT EXISTS proof_commitments (
      commitment_hash TEXT PRIMARY KEY,
      nullifier TEXT NOT NULL,
      dao_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      wallet_address TEXT,
      timestamp INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_commitments_nullifier ON proof_commitments(nullifier);
    CREATE INDEX IF NOT EXISTS idx_commitments_wallet ON proof_commitments(wallet_address);
    -- Append-only, tamper-evident audit trail for privileged/administrative
    -- actions. Each row's hash covers its own fields plus the previous row's
    -- hash (hash chain), so any edit or reordering breaks verifyAuditChain().
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      action TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      auth_token_id TEXT,
      ip_hash TEXT,
      request_id TEXT,
      params TEXT,
      status_code INTEGER,
      prev_hash TEXT,
      hash TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_log_archived ON audit_log(archived_at);

    -- Core fields are immutable once written; only archived_at (set by the
    -- rotation job after export) may be updated.
    CREATE TRIGGER IF NOT EXISTS audit_log_immutable_core
    BEFORE UPDATE ON audit_log
    WHEN NEW.id IS NOT OLD.id
      OR NEW.timestamp IS NOT OLD.timestamp
      OR NEW.action IS NOT OLD.action
      OR NEW.endpoint IS NOT OLD.endpoint
      OR NEW.auth_token_id IS NOT OLD.auth_token_id
      OR NEW.ip_hash IS NOT OLD.ip_hash
      OR NEW.request_id IS NOT OLD.request_id
      OR NEW.params IS NOT OLD.params
      OR NEW.status_code IS NOT OLD.status_code
      OR NEW.prev_hash IS NOT OLD.prev_hash
      OR NEW.hash IS NOT OLD.hash
    BEGIN
      SELECT RAISE(ABORT, 'audit_log: core fields are immutable');
    END;

    -- Rows may only be deleted after being archived (exported to cold storage).
    CREATE TRIGGER IF NOT EXISTS audit_log_no_unarchived_delete
    BEFORE DELETE ON audit_log
    WHEN OLD.archived_at IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'audit_log: entry must be archived before deletion');
    END;

    -- Keep the old events table temporarily during migration,
    -- then drop it once migration completes.
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dao_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT,
      ledger INTEGER,
      tx_hash TEXT,
      timestamp TEXT NOT NULL,
      verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(dao_id, ledger, tx_hash, type)
    );
  `);
    const versionRow = database
        .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
        .get();
    const storedVersion = versionRow
        ? JSON.parse(versionRow.value)
        : null;
    if (!storedVersion) {
        database
            .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)")
            .run(JSON.stringify(CURRENT_SCHEMA_VERSION));
    }
    const { valid, errors, warnings, migrations } = validateSchema(database);
    if (migrations.length > 0) {
        applyMigrations(database, migrations);
        log("info", "schema_migrations_applied", { count: migrations.length });
    }
    for (const warning of warnings) {
        log("warn", "schema_mismatch", { message: warning });
    }
    if (!valid) {
        log("error", "schema_validation_failed", { errors });
        throw new Error(`Database schema validation failed: ${errors.join("; ")}`);
    }
    if (storedVersion && storedVersion < CURRENT_SCHEMA_VERSION) {
        database
            .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)")
            .run(JSON.stringify(CURRENT_SCHEMA_VERSION));
        log("info", "schema_version_upgraded", {
            from: storedVersion,
            to: CURRENT_SCHEMA_VERSION,
        });
    }
    // Populate knownPartitions from the active database registry.
    knownPartitions.clear();
    const rows = database
        .prepare("SELECT dao_id FROM partition_registry")
        .all();
    for (const row of rows) {
        knownPartitions.add(row.dao_id);
    }
    // Run pending migrations using the migration framework
    // Migrations are idempotent and tracked in the _migrations table
    try {
        const migrationResults = migrateUp(database);
        if (migrationResults.length > 0) {
            log("info", "migrations_applied", {
                count: migrationResults.length,
                results: migrationResults.map((r) => ({
                    id: r.id,
                    direction: r.direction,
                    success: r.success,
                    durationMs: Math.round(r.durationMs),
                })),
            });
        }
    }
    catch (err) {
        // Migration lock contention is not fatal — another process may have
        // already applied the migrations. Log and continue.
        const error = err;
        if (error.message.includes("Migration lock")) {
            log("warn", "migration_skipped_locked", {
                error: error.message,
            });
        }
        else {
            log("error", "migration_failed", {
                error: error.message,
            });
            throw err;
        }
    }
    writeDb = database;
    markWriteSuccess();
    // Open readonly companion for API query isolation
    // (prior handles already closed/nulled above when switching files)
    try {
        readDb = openReadConnection(dbFile);
    }
    catch (err) {
        log("warn", "db_read_connection_failed", {
            error: err instanceof Error ? err.message : String(err),
        });
        readDb = null;
    }
    updateConnectionGauges();
    log("info", "db_initialized", {
        path: dbFile,
        partitions: knownPartitions.size,
        readConnection: Boolean(readDb),
    });
    // feat: events partitioning, db monitoring, migration framework, and data integrity constraints
    return database;
}
/**
 * Return the initialized write database instance (initializing it if needed).
 * Return the initialized database instance, initializing it if needed.
 * Get active database instance or initialize default.
 * Return the initialized database instance (initializing it if needed).
 * archival.ts and backup.ts import this; it was missing from this module's
 * exports, which broke every route that transitively imports either of them
 * (e.g. GET /health -> services/backup.ts) at startup. Unrelated to
 * #193/#195/#194/#201, but fixed here since it otherwise blocks the backend
 * from booting at all, including for verifying the changes in this PR.
 */
export function getDb() {
    return getWriteDb();
}
/**
 * Close write and read database connections.
 */
export function closeDb() {
    if (readDb) {
        try {
            readDb.close();
        }
        catch {
            /* ignore */
        }
        readDb = null;
    }
    if (writeDb) {
        try {
            writeDb.close();
        }
        catch {
            /* ignore */
        }
        writeDb = null;
        knownPartitions.clear();
        writeHealthy = true;
        writeFailureReason = null;
        log("info", "db_closed");
    }
    updateConnectionGauges();
}
function validateSchema(database) {
    const errors = [];
    const warnings = [];
    const migrations = [];
    for (const [tableName, expected] of Object.entries(EXPECTED_SCHEMA)) {
        const tableExists = database
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
            .get(tableName);
        if (!tableExists) {
            errors.push(`Missing required table: ${tableName}`);
            continue;
        }
        const actualColumns = database.pragma(`table_info(${tableName})`);
        for (const expectedCol of expected.columns) {
            const actualCol = actualColumns.find((c) => c.name === expectedCol.name);
            if (!actualCol) {
                migrations.push(`Missing column ${tableName}.${expectedCol.name} (${expectedCol.type})`);
                continue;
            }
            const actualType = normalizeType(actualCol.type);
            const expectedType = normalizeType(expectedCol.type);
            if (actualType !== expectedType) {
                errors.push(`Column ${tableName}.${expectedCol.name} type mismatch: expected ${expectedCol.type}, got ${actualCol.type}`);
            }
            if (expectedCol.notNull &&
                !actualCol.notnull &&
                !expectedCol.primaryKey) {
                warnings.push(`Column ${tableName}.${expectedCol.name} missing NOT NULL constraint`);
            }
            if (expectedCol.primaryKey && !actualCol.pk) {
                errors.push(`Column ${tableName}.${expectedCol.name} missing PRIMARY KEY`);
            }
        }
        for (const actualCol of actualColumns) {
            const match = expected.columns.find((c) => c.name === actualCol.name);
            if (!match) {
                warnings.push(`Extra column ${tableName}.${actualCol.name}`);
            }
        }
        const actualIndexes = database.pragma(`index_list(${tableName})`);
        for (const expectedIdx of expected.indexes) {
            const actualIdx = actualIndexes.find((i) => i.name === expectedIdx.name);
            if (!actualIdx) {
                warnings.push(`Missing index ${expectedIdx.name} on ${tableName}`);
                continue;
            }
            const indexCols = database.pragma(`index_info(${expectedIdx.name})`);
            const actualColNames = indexCols.map((c) => c.name);
            if (actualColNames.join(",") !== expectedIdx.columns.join(",")) {
                warnings.push(`Index ${expectedIdx.name} columns mismatch: expected [${expectedIdx.columns}], got [${actualColNames}]`);
            }
        }
        for (const actualIdx of actualIndexes) {
            if (actualIdx.origin === "pk" || actualIdx.origin === "u")
                continue;
            const match = expected.indexes.find((i) => i.name === actualIdx.name);
            if (!match) {
                warnings.push(`Extra index ${actualIdx.name} on ${tableName}`);
            }
        }
    }
    return { valid: errors.length === 0, errors, warnings, migrations };
}
function applyMigrations(database, migrations) {
    for (const migration of migrations) {
        const match = migration.match(/Missing column (\w+)\.(\w+) \(([^)]+)\)/);
        if (!match)
            continue;
        const tableName = match[1];
        const columnName = match[2];
        const table = EXPECTED_SCHEMA[tableName];
        if (!table)
            continue;
        const colDef = table.columns.find((c) => c.name === columnName);
        if (!colDef)
            continue;
        let sql = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${colDef.type}`;
        if (colDef.notNull) {
            const def = normalizeType(colDef.type) === "INTEGER" ? "0" : "";
            sql += ` DEFAULT ${def} NOT NULL`;
        }
        database.exec(sql);
        log("info", "schema_migration_applied", {
            table: tableName,
            column: columnName,
        });
    }
}
/**
 * Get metadata value by key
 */
export function getMetadata(key) {
    const database = getReadDb();
    const row = timeQuery("getMetadata", () => database.prepare("SELECT value FROM metadata WHERE key = ?").get(key), { key });
    return row ? JSON.parse(row.value) : null;
}
/**
 * Set metadata value
 */
export function setMetadata(key, value) {
    const database = getWriteDb();
    const compiled = kysely
        .insertInto("metadata")
        .values({ key, value: JSON.stringify(value) })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify(value) }))
        .compile();
    timeQuery("setMetadata", () => database.prepare(compiled.sql).run(...compiled.parameters), { key });
    // Invalidate any cached queries that depend on metadata
    invalidateCachePrefix("metadata");
    markWriteSuccess();
    incrementTransactionCounter();
}
/**
 * Convert a raw EventRow (with numeric verified) to an Event object.
 */
function rowToEvent(row) {
    return {
        id: row.id,
        dao_id: row.dao_id,
        type: row.type,
        data: row.data ? JSON.parse(row.data) : null,
        ledger: row.ledger,
        tx_hash: row.tx_hash,
        timestamp: row.timestamp,
        verified: !!row.verified,
        created_at: row.created_at,
    };
}
/**
 * Add an event to the database.
 * Writes to the partition table for the DAO.
 * Returns true if added, false if duplicate.
 * SECURITY: Validates event type and uses parameterized queries.
 */
export function addEvent(event) {
    const database = getWriteDb();
    const tableName = partitionTableName(event.daoId); // Validates daoId
    ensurePartitionTable(event.daoId);
    // SECURITY: Validate event type against allowlist
    if (!ALLOWED_EVENT_TYPES.has(event.type)) {
        throw new Error(`Invalid event type: ${event.type}`);
    }
    // NOTE (pre-existing bug, found while adding sbt_transfer_attempt events
    // for #357): kysely@0.29's insertInto() calls `from.includes(...)`
    // internally, so it requires a plain string table identifier — passing a
    // `sql\`...\`.as(...)` raw expression throws "from.includes is not a
    // function" and every addEvent() call fails. `tableName` is already a
    // safe, validated identifier (partitionTableName() derives it from a
    // range-checked numeric DAO ID), so a plain string is correct here anyway.
    const queryObj = kysely.insertInto(tableName).values({
        type: event.type,
        data: JSON.stringify(event.data),
        ledger: event.ledger ?? null,
        tx_hash: event.txHash ?? null,
        timestamp: event.timestamp ?? new Date().toISOString(),
        verified: event.verified ? 1 : 0,
    });
    const compiled = queryObj.compile();
    const result = timeQuery("addEvent", () => {
        try {
            logQuery(compiled.sql, compiled.parameters, "add_event");
            database.prepare(compiled.sql).run(...compiled.parameters);
            markWriteSuccess();
            return true;
        }
        catch (err) {
            const error = err;
            if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
                return false; // Duplicate
            }
            if (isConnectionError(err)) {
                markWriteFailure(err);
                if (reconnectWriteDb()) {
                    ensurePartitionTable(event.daoId);
                    getWriteDb()
                        .prepare(compiled.sql)
                        .run(...compiled.parameters);
                    markWriteSuccess();
                    return true;
                }
            }
            throw err;
        }
    }, { daoId: event.daoId, type: event.type });
    // Invalidate cached DAO event counts
    if (result) {
        invalidateCachePrefix(`indexedDaos`);
        invalidateCachePrefix(`dbStatus`);
        incrementTransactionCounter();
    }
    return result;
}
/**
 * Add a pending (unverified) event from frontend notification.
 */
export function addPendingEvent(daoId, type, data, txHash) {
    return addEvent({
        daoId,
        type,
        data,
        ledger: null,
        txHash,
        timestamp: new Date().toISOString(),
        verified: false,
    });
}
/**
 * Mark an event as verified.
 * Searches across the DAO's partition table.
 * SECURITY: Uses parameterized queries and validates inputs.
 */
export function verifyEvent(txHash, ledger) {
    if (typeof txHash !== "string" ||
        txHash.length === 0 ||
        txHash.length > 128 ||
        !/^[A-Za-z0-9_-]+$/.test(txHash)) {
        throw new Error("Invalid transaction hash");
    }
    // SECURITY: Basic input validation
    if (typeof txHash !== "string" ||
        txHash.length === 0 ||
        txHash.length > 128) {
        throw new Error(`Invalid txHash: ${txHash}`);
    }
    if (!Number.isInteger(ledger) || ledger < 0) {
        throw new Error(`Invalid ledger: ${ledger}`);
    }
    const database = getWriteDb();
    // Search in all partitions for the matching tx_hash
    const daoIds = getAllPartitionDaoIds(database);
    for (const daoId of daoIds) {
        const tableName = partitionTableName(daoId); // Validates daoId
        const query = `UPDATE ${tableName} SET verified = 1, ledger = ? WHERE tx_hash = ? AND verified = 0`;
        const params = [ledger, txHash];
        logQuery(query, params, "verify_event");
        const result = database.prepare(query).run(...params);
        if (result.changes > 0)
            return; // Done
    }
}
/**
 * Get events for a DAO (from its partition).
 * Supports both cursor-based and offset-based pagination.
 * SECURITY: Uses parameterized queries and validates all inputs.
 */
export function getEventsForDao(daoId, options = {}) {
    const database = getReadDb();
    const tableName = partitionTableName(daoId); // Validates daoId
    // Reads must not run DDL — missing partitions return empty results.
    if (!partitionTableExists(database, daoId)) {
        return { events: [], total: 0, daoId };
    }
    const { limit = 100, offset = 0, types = null, verifiedOnly = false, orderBy = "timestamp", orderDirection = "DESC", cursor, cursorField = "id", } = options;
    // SECURITY: Validate limit and offset
    const validLimit = Math.max(1, Math.min(limit, 1000));
    const validOffset = Math.max(0, offset);
    // SECURITY: Validate ORDER BY parameters
    const { column: orderColumn, direction } = validateOrderBy(orderBy, orderDirection);
    let query = kysely
        .selectFrom(sql `${sql.raw(tableName)}`.as("events"))
        .selectAll();
    if (types && types.length > 0) {
        const validatedTypes = validateEventTypes(types);
        query = query.where("type", "in", validatedTypes);
    }
    if (verifiedOnly) {
        query = query.where("verified", "=", 1);
    }
    // Cursor-based pagination: filter for records after the cursor position
    if (cursor) {
        const decoded = decodeCursor(cursor, cursorField);
        if (cursorField === "id") {
            query = query.where("id", ">", decoded.i);
        }
        else if (cursorField === "ledger") {
            query = query.where("ledger", ">", decoded.l);
        }
        else if (cursorField === "timestamp") {
            query = query.where("timestamp", ">", decoded.t);
        }
    }
    else {
        query = query.offset(validOffset);
    }
    query = query
        .orderBy(orderColumn, direction.toLowerCase())
        .orderBy("ledger", "desc")
        .limit(validLimit);
    const compiled = query.compile();
    logQuery(compiled.sql, compiled.parameters, "get_events_for_dao");
    const events = database
        .prepare(compiled.sql)
        .all(...compiled.parameters);
    // Add dao_id to each row (partition tables don't store it)
    const enrichedEvents = events.map((e) => ({ ...e, dao_id: daoId }));
    let countQuery = kysely
        .selectFrom(sql `${sql.raw(tableName)}`.as("events"))
        .select(sql `COUNT(*)`.as("total"));
    if (types && types.length > 0) {
        countQuery = countQuery.where("type", "in", validateEventTypes(types));
    }
    if (verifiedOnly) {
        countQuery = countQuery.where("verified", "=", 1);
    }
    const countCompiled = countQuery.compile();
    logQuery(countCompiled.sql, countCompiled.parameters, "count_events_for_dao");
    const countResult = database
        .prepare(countCompiled.sql)
        .get(...countCompiled.parameters);
    return {
        events: enrichedEvents.map(rowToEvent),
        total: countResult.total,
        daoId,
    };
}
/**
 * Get all indexed DAOs (with event counts from partitions).
 */
export function getIndexedDaos() {
    const database = getReadDb();
    const daoIds = getAllPartitionDaoIds(database);
    if (daoIds.length === 0)
        return [];
    // Build a UNION ALL query to get per-DAO counts
    const parts = [];
    for (const daoId of daoIds) {
        const tableName = partitionTableName(daoId);
        parts.push(`SELECT ${daoId} AS dao_id, COUNT(*) AS event_count FROM ${tableName}`);
    }
    const rows = database
        .prepare(`${parts.join(" UNION ALL ")} ORDER BY dao_id`)
        .all();
    return rows.map((r) => ({
        daoId: r.dao_id,
        eventCount: r.event_count,
    }));
}
/**
 * Get database status (cross-DAO aggregates).
 */
export function getDbStatus() {
    const database = getReadDb();
    const daoIds = getAllPartitionDaoIds(database);
    let totalEvents = 0;
    const daoCount = daoIds.length;
    if (daoIds.length > 0) {
        // Count across all partitions
        const countParts = [];
        for (const daoId of daoIds) {
            const tableName = partitionTableName(daoId);
            countParts.push(`SELECT COUNT(*) AS cnt FROM ${tableName}`);
        }
        const countRow = database
            .prepare(`${countParts.join(" UNION ALL ")}`)
            .all();
        totalEvents = countRow.reduce((sum, r) => sum + r.cnt, 0);
    }
    const lastLedger = getMetadata("lastLedger") ?? 0;
    return {
        totalEvents,
        daoCount,
        lastLedger,
        walSizeBytes: getWalSizeBytes(),
        readLagMs: getReadReplicaLagMs(),
        writeHealthy: isWriteConnectionHealthy(),
        connectionsActive: countActiveConnections(),
    };
}
/**
 * Get unverified events that need chain verification.
 * Searches across all partitions.
 */
export function getUnverifiedEvents(limit = 10) {
    const database = getReadDb();
    const daoIds = getAllPartitionDaoIds(database);
    if (daoIds.length === 0)
        return [];
    // Build a UNION ALL sub-query across partitions
    const parts = [];
    for (const daoId of daoIds) {
        const tableName = partitionTableName(daoId);
        parts.push(`SELECT id, ${daoId} AS dao_id, type, data, ledger, tx_hash, timestamp, verified, created_at FROM ${tableName} WHERE verified = 0 AND tx_hash IS NOT NULL`);
    }
    const rows = database
        .prepare(`${parts.join(" UNION ALL ")} ORDER BY created_at ASC LIMIT ?`)
        .all(limit);
    return rows.map(rowToEvent);
}
/**
 * Delete an unverified event (if verification fails).
 */
export function deleteUnverifiedEvent(txHash) {
    const database = getWriteDb();
    const daoIds = getAllPartitionDaoIds(database);
    for (const daoId of daoIds) {
        const tableName = partitionTableName(daoId);
        const result = database
            .prepare(`DELETE FROM ${tableName} WHERE tx_hash = ? AND verified = 0`)
            .run(txHash);
        if (result.changes > 0)
            return;
    }
}
/**
 * Get transaction log by nullifier hash.
 */
export function getTransactionLog(nullifierHash) {
    const database = getReadDb();
    const row = database
        .prepare("SELECT * FROM transaction_log WHERE nullifier_hash = ?")
        .get(nullifierHash);
    return row ?? null;
}
/**
 * Record new transaction submission in transaction log.
 */
export function recordTransactionLog(nullifierHash, txHash, status = "PENDING") {
    const database = getWriteDb();
    database
        .prepare(`INSERT INTO transaction_log (nullifier_hash, tx_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(nullifier_hash) DO UPDATE SET
         tx_hash = excluded.tx_hash,
         status = excluded.status,
         updated_at = CURRENT_TIMESTAMP`)
        .run(nullifierHash, txHash, status);
    incrementTransactionCounter();
}
/**
 * Update transaction status in transaction log.
 */
export function updateTransactionLogStatus(nullifierHash, status, txHash) {
    const database = getWriteDb();
    if (txHash) {
        database
            .prepare(`UPDATE transaction_log SET status = ?, tx_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE nullifier_hash = ?`)
            .run(status, txHash, nullifierHash);
    }
    else {
        database
            .prepare(`UPDATE transaction_log SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE nullifier_hash = ?`)
            .run(status, nullifierHash);
    }
}
/**
 * Cleanup old transaction log entries.
 */
export function cleanupTransactionLog(maxAgeMs = 86400000) {
    const database = getWriteDb();
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const result = database
        .prepare("DELETE FROM transaction_log WHERE updated_at < ?")
        .run(cutoff);
    return result.changes;
}
/**
 * Look up an existing vote submission by nullifier hash.
 */
export function getVoteSubmission(nullifierHash) {
    const database = getReadDb();
    const row = database
        .prepare("SELECT * FROM vote_submissions WHERE nullifier_hash = ?")
        .get(nullifierHash);
    return row ?? null;
}
/**
 * Insert a new pending vote submission. Returns false if nullifier already exists (idempotency race).
 */
export function insertVoteSubmission(nullifierHash) {
    const database = getWriteDb();
    const now = Date.now();
    const result = database
        .prepare("INSERT OR IGNORE INTO vote_submissions (nullifier_hash, status, tx_hash, created_at, updated_at) VALUES (?, 'pending', NULL, ?, ?)")
        .run(nullifierHash, now, now);
    if (result.changes > 0)
        incrementTransactionCounter();
    return result.changes > 0;
}
/**
 * Update an existing vote submission to confirmed or failed.
 */
export function updateVoteSubmission(nullifierHash, status, txHash) {
    const database = getWriteDb();
    const now = Date.now();
    if (txHash) {
        database
            .prepare("UPDATE vote_submissions SET status = ?, tx_hash = ?, updated_at = ? WHERE nullifier_hash = ?")
            .run(status, txHash, now, nullifierHash);
    }
    else {
        database
            .prepare("UPDATE vote_submissions SET status = ?, updated_at = ? WHERE nullifier_hash = ?")
            .run(status, now, nullifierHash);
    }
    incrementTransactionCounter();
}
/**
 * Delete vote submissions older than ttlMs whose status is not confirmed.
 */
export function cleanupExpiredVoteSubmissions(ttlMs) {
    const database = getWriteDb();
    const cutoff = Date.now() - ttlMs;
    const result = database
        .prepare("DELETE FROM vote_submissions WHERE status != 'confirmed' AND created_at < ?")
        .run(cutoff);
    return result.changes;
}
/**
 * Insert an audit log entry, chaining its hash to the previous entry's hash.
 * Read-then-write happens inside a single better-sqlite3 transaction (and,
 * since better-sqlite3 calls are synchronous, without any await in between),
 * so concurrent inserts can't interleave and desync the chain.
 */
export function insertAuditLog(entry) {
    const database = getWriteDb();
    const insert = database.transaction((e) => {
        const last = database
            .prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1")
            .get();
        const prevHash = last?.hash ?? "genesis";
        const hash = crypto
            .createHash("sha256")
            .update(JSON.stringify({
            timestamp: e.timestamp,
            action: e.action,
            endpoint: e.endpoint,
            authTokenId: e.authTokenId,
            ipHash: e.ipHash,
            requestId: e.requestId,
            params: e.params,
            statusCode: e.statusCode,
            prevHash,
        }))
            .digest("hex");
        const result = database
            .prepare(`INSERT INTO audit_log
          (timestamp, action, endpoint, auth_token_id, ip_hash, request_id, params, status_code, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(e.timestamp, e.action, e.endpoint, e.authTokenId, e.ipHash, e.requestId, e.params, e.statusCode, prevHash, hash);
        return {
            id: result.lastInsertRowid,
            timestamp: e.timestamp,
            action: e.action,
            endpoint: e.endpoint,
            auth_token_id: e.authTokenId,
            ip_hash: e.ipHash,
            request_id: e.requestId,
            params: e.params,
            status_code: e.statusCode,
            prev_hash: prevHash,
            hash,
            archived_at: null,
        };
    });
    return insert(entry);
}
/**
 * Paginated audit log query (newest first), optionally filtered by action.
 */
export function getAuditLogs(options = {}) {
    const database = getReadDb();
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const offset = Math.max(0, options.offset ?? 0);
    let where = "";
    const params = [];
    if (options.action) {
        where = " WHERE action = ?";
        params.push(options.action);
    }
    const logs = database
        .prepare(`SELECT * FROM audit_log${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
    const total = database
        .prepare(`SELECT COUNT(*) as total FROM audit_log${where}`)
        .get(...params).total;
    return { logs, total };
}
/**
 * All audit log rows in insertion order, for hash-chain verification.
 */
export function getAllAuditLogsOrdered() {
    const database = getReadDb();
    return database
        .prepare("SELECT * FROM audit_log ORDER BY id ASC")
        .all();
}
/**
 * Unarchived rows older than the given ISO cutoff — candidates for rotation.
 */
export function getUnarchivedAuditLogsOlderThan(cutoffIso) {
    const database = getReadDb();
    return database
        .prepare("SELECT * FROM audit_log WHERE archived_at IS NULL AND timestamp < ? ORDER BY id ASC")
        .all(cutoffIso);
}
/**
 * Mark rows as archived (allowed by the immutable-core trigger, which only
 * blocks changes to fields other than archived_at).
 */
export function markAuditLogsArchived(ids, archivedAt) {
    if (ids.length === 0)
        return;
    const database = getWriteDb();
    const stmt = database.prepare("UPDATE audit_log SET archived_at = ? WHERE id = ?");
    const run = database.transaction((rowIds) => {
        for (const id of rowIds)
            stmt.run(archivedAt, id);
    });
    run(ids);
}
/**
 * Delete rows from the hot table. Only succeeds for rows already marked
 * archived_at — enforced by the audit_log_no_unarchived_delete trigger.
 */
export function deleteAuditLogs(ids) {
    if (ids.length === 0)
        return 0;
    const database = getWriteDb();
    const stmt = database.prepare("DELETE FROM audit_log WHERE id = ?");
    const run = database.transaction((rowIds) => {
        let deleted = 0;
        for (const id of rowIds)
            deleted += stmt.run(id).changes;
        return deleted;
    });
    return run(ids);
}
/**
 * Count pending (unverified) events for a specific DAO.
 */
export function getPendingEventsCountForDao(daoId) {
    const database = getReadDb();
    const tableName = partitionTableName(daoId);
    if (!partitionTableExists(database, daoId))
        return 0;
    const row = database
        .prepare(`SELECT COUNT(*) as count FROM ${tableName} WHERE verified = 0`)
        .get();
    return row.count;
}
/**
 * Cleanup expired unverified pending events across partitions older than ttlMs.
 */
export function cleanupExpiredPendingEvents(ttlMs = 15 * 60 * 1000) {
    const database = getWriteDb();
    const daoIds = getAllPartitionDaoIds(database);
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    let deletedCount = 0;
    for (const daoId of daoIds) {
        const tableName = partitionTableName(daoId);
        const result = database
            .prepare(`DELETE FROM ${tableName} WHERE verified = 0 AND timestamp < ?`)
            .run(cutoff);
        deletedCount += result.changes;
    }
    return deletedCount;
}
// ============================================
// PARTITION MANAGEMENT
// ============================================
/**
 * Ensure a partition table exists for the given DAO ID.
 * Public version — call this when a new DAO is created.
 */
export function ensurePartition(daoId) {
    getWriteDb();
    ensurePartitionTable(daoId);
    log("info", "partition_created", { daoId });
}
/**
 * Drop a partition table (for DAO deletion/archival).
 * Removes the DAO from the registry as well.
 */
export function dropPartition(daoId) {
    const database = getWriteDb();
    const tableName = partitionTableName(daoId);
    database.exec(`DROP TABLE IF EXISTS ${tableName}`);
    database
        .prepare("DELETE FROM partition_registry WHERE dao_id = ?")
        .run(daoId);
    knownPartitions.delete(daoId);
    log("info", "partition_dropped", { daoId });
}
// ============================================
// MIGRATION: Monolithic -> Partitioned
// ============================================
/**
 * Migrate events from the old monolithic `events` table to per-DAO
 * partition tables.  This is idempotent — safe to re-run.
 *
 * Returns the number of events migrated.
 */
export function migrateToPartitions() {
    const database = getWriteDb();
    // Check if there are any rows in the old events table
    const oldCount = database
        .prepare("SELECT COUNT(*) AS total FROM events")
        .get();
    if (oldCount.total === 0) {
        log("info", "partition_migration_skipped", { reason: "no_old_events" });
        return 0;
    }
    // Read all old events, grouped by dao_id
    const oldRows = database
        .prepare("SELECT id, dao_id, type, data, ledger, tx_hash, timestamp, verified, created_at FROM events ORDER BY dao_id, id")
        .all();
    let migrated = 0;
    database.transaction(() => {
        for (const row of oldRows) {
            const tableName = partitionTableName(row.dao_id);
            // Ensure partition exists (creates the table + indexes)
            database.exec(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          data TEXT,
          ledger INTEGER,
          tx_hash TEXT,
          timestamp TEXT NOT NULL,
          verified INTEGER DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(ledger, tx_hash, type)
        );
      `);
            knownPartitions.add(row.dao_id);
            recordPartitionDaoId(database, row.dao_id);
            // Insert into partition (ignore duplicates)
            const result = database
                .prepare(`
        INSERT OR IGNORE INTO ${tableName} (type, data, ledger, tx_hash, timestamp, verified, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
                .run(row.type, row.data, row.ledger, row.tx_hash, row.timestamp, row.verified, row.created_at);
            if (result.changes > 0)
                migrated++;
        }
        // Drop the old monolithic events table
        database.exec("DROP TABLE IF EXISTS events");
    })();
    // Ensure indexes exist on new partitions
    database.transaction(() => {
        for (const daoId of knownPartitions) {
            const tableName = partitionTableName(daoId);
            database.exec(`
        CREATE INDEX IF NOT EXISTS idx_${tableName}_type ON ${tableName}(type);
        CREATE INDEX IF NOT EXISTS idx_${tableName}_timestamp ON ${tableName}(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_${tableName}_ledger ON ${tableName}(ledger DESC);
        CREATE INDEX IF NOT EXISTS idx_${tableName}_verified ON ${tableName}(verified);
      `);
        }
    })();
    log("info", "partition_migration_complete", {
        migrated,
        totalOld: oldCount.total,
    });
    return migrated;
}
/**
 * Migrate events from JSON file to SQLite (legacy migration).
 * Now routes into partition tables.
 * SECURITY: Validates all JSON input and uses parameterized queries.
 */
export function migrateFromJson(jsonPath) {
    const database = getWriteDb();
    if (!fs.existsSync(jsonPath)) {
        log("info", "no_json_to_migrate");
        return 0;
    }
    try {
        const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        const events = data.events ?? {};
        let migrated = 0;
        database.transaction(() => {
            for (const [daoIdStr, daoEvents] of Object.entries(events)) {
                // SECURITY: Validate DAO ID from JSON
                const daoId = Number(daoIdStr);
                if (!Number.isInteger(daoId) || daoId < 1) {
                    log("warn", "json_migration_invalid_dao_id", { daoIdStr });
                    continue;
                }
                const tableName = partitionTableName(daoId); // This validates daoId
                ensurePartitionTable(daoId);
                const insertQuery = `
          INSERT OR IGNORE INTO ${tableName} (type, data, ledger, tx_hash, timestamp, verified)
          VALUES (?, ?, ?, ?, ?, 1)
        `;
                const insertStmt = database.prepare(insertQuery);
                for (const event of daoEvents) {
                    try {
                        // SECURITY: Validate event type
                        if (!ALLOWED_EVENT_TYPES.has(event.type)) {
                            log("warn", "json_migration_invalid_event_type", {
                                type: event.type,
                                daoId,
                            });
                            continue;
                        }
                        // SECURITY: Validate timestamp format if provided
                        const timestamp = event.timestamp ?? new Date().toISOString();
                        if (event.timestamp &&
                            (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(event.timestamp) ||
                                Number.isNaN(Date.parse(event.timestamp)))) {
                            log("warn", "json_migration_invalid_timestamp", {
                                timestamp: event.timestamp,
                                daoId,
                            });
                            continue;
                        }
                        const params = [
                            event.type,
                            JSON.stringify(event.data),
                            event.ledger ?? null,
                            event.txHash ?? null,
                            timestamp,
                        ];
                        logQuery(insertQuery, params, "migrate_from_json");
                        insertStmt.run(...params);
                        migrated++;
                    }
                    catch (err) {
                        log("warn", "json_migration_event_failed", {
                            error: err.message,
                            daoId,
                            eventType: event.type,
                        });
                        // Skip this event and continue
                    }
                }
            }
            // Save last ledger
            if (data.lastLedger &&
                Number.isInteger(data.lastLedger) &&
                data.lastLedger > 0) {
                setMetadata("lastLedger", data.lastLedger);
            }
        })();
        log("info", "json_migration_complete", { migrated });
        // Rename old file
        fs.renameSync(jsonPath, jsonPath + ".migrated");
        return migrated;
    }
    catch (err) {
        const error = err;
        log("error", "json_migration_failed", { error: error.message });
        return 0;
    }
}
// ============================================
// DIAGNOSTICS & PERFORMANCE
// ============================================
/**
 * Get comprehensive database diagnostics for the /db/stats endpoint.
 * Includes query metrics, table statistics, cache stats, and index analysis.
 */
export function getDbDiagnostics() {
    const database = getReadDb();
    const stats = getMonitorDbStats(database);
    // Profile event queries for large DAOs (10K+ events)
    const largeDaos = stats.tables
        .filter((t) => t.name.startsWith("events_") && t.rowCount >= 10_000)
        .map((t) => Number(t.name.replace("events_", "")));
    for (const daoId of largeDaos) {
        profileEventQueries(database, daoId);
    }
    return {
        queries: stats.queries,
        tables: stats.tables,
        cache: stats.cache,
        config: stats.config,
        partitions: knownPartitions.size,
        largeDaos: largeDaos.length,
        readReplica: {
            lagMs: getReadReplicaLagMs(),
            writeHealthy: isWriteConnectionHealthy(),
            connectionsActive: countActiveConnections(),
            walSizeBytes: getWalSizeBytes(),
            writeFailureReason,
        },
    };
}
/**
 * Profile queries for a specific DAO partition (for diagnostics).
 */
export function profileDaoQueries(daoId) {
    const database = getReadDb();
    const tableName = partitionTableName(daoId);
    const tableExists = database
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(tableName);
    if (tableExists) {
        profileEventQueries(database, daoId);
    }
}
/**
 * Upsert a DAO into the cache
 */
export function upsertDao(dao) {
    const database = getWriteDb();
    database
        .prepare(`
    INSERT INTO daos (id, name, creator, membership_open, members_can_propose, metadata_cid, member_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      creator = excluded.creator,
      membership_open = excluded.membership_open,
      members_can_propose = excluded.members_can_propose,
      metadata_cid = excluded.metadata_cid,
      member_count = excluded.member_count,
      updated_at = CURRENT_TIMESTAMP
  `)
        .run(dao.id, dao.name, dao.creator, dao.membership_open ? 1 : 0, dao.members_can_propose ? 1 : 0, dao.metadata_cid ?? null, dao.member_count ?? 0);
    incrementTransactionCounter();
}
/**
 * Upsert multiple DAOs in a transaction
 */
export function upsertDaos(daos) {
    const database = getWriteDb();
    const stmt = database.prepare(`
    INSERT INTO daos (id, name, creator, membership_open, members_can_propose, metadata_cid, member_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      creator = excluded.creator,
      membership_open = excluded.membership_open,
      members_can_propose = excluded.members_can_propose,
      metadata_cid = excluded.metadata_cid,
      member_count = excluded.member_count,
      updated_at = CURRENT_TIMESTAMP
  `);
    database.transaction(() => {
        for (const dao of daos) {
            stmt.run(dao.id, dao.name, dao.creator, dao.membership_open ? 1 : 0, dao.members_can_propose ? 1 : 0, dao.metadata_cid ?? null, dao.member_count ?? 0);
        }
    })();
    log("info", "daos_upserted", { count: daos.length });
    incrementTransactionCounter();
}
/**
 * Get all cached DAOs
 */
export function getAllCachedDaos() {
    const database = getReadDb();
    const rows = database
        .prepare("SELECT * FROM daos ORDER BY id ASC")
        .all();
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        creator: row.creator,
        membership_open: !!row.membership_open,
        members_can_propose: !!row.members_can_propose,
        metadata_cid: row.metadata_cid,
        member_count: row.member_count,
        updated_at: row.updated_at,
    }));
}
/**
 * Get a specific cached DAO by ID
 */
export function getCachedDao(daoId) {
    const database = getReadDb();
    const row = database.prepare("SELECT * FROM daos WHERE id = ?").get(daoId);
    if (!row)
        return null;
    return {
        id: row.id,
        name: row.name,
        creator: row.creator,
        membership_open: !!row.membership_open,
        members_can_propose: !!row.members_can_propose,
        metadata_cid: row.metadata_cid,
        member_count: row.member_count,
        updated_at: row.updated_at,
    };
}
/**
 * Get DAOs for a specific user (by membership)
 * This requires the daos table to be populated with user membership data
 * For now, returns all DAOs - user filtering will be done by the frontend
 */
export function getDaosForUser(_userAddress) {
    return getAllCachedDaos();
}
/**
 * Get the last sync timestamp for DAOs
 */
export function getDaosSyncTime() {
    return getMetadata("daosSyncTime");
}
/**
 * Set the last sync timestamp for DAOs
 */
export function setDaosSyncTime(timestamp) {
    setMetadata("daosSyncTime", timestamp);
}
/**
 * Get cached DAO count
 */
export function getCachedDaoCount() {
    const database = getReadDb();
    const result = database
        .prepare("SELECT COUNT(*) as count FROM daos")
        .get();
    return result.count;
}
export function upsertTTLTracking(entry) {
    const database = getWriteDb();
    database
        .prepare(`
    INSERT INTO ttl_tracking (entry_id, contract_id, dao_id, method, last_renewed_at, remaining_ledgers, urgency)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      contract_id = excluded.contract_id,
      dao_id = excluded.dao_id,
      method = excluded.method,
      last_renewed_at = excluded.last_renewed_at,
      remaining_ledgers = excluded.remaining_ledgers,
      urgency = excluded.urgency
  `)
        .run(entry.entryId, entry.contractId, entry.daoId ?? null, entry.method ?? null, entry.lastRenewedAt ?? null, entry.remainingLedgers ?? null, entry.urgency);
}
export function getTTLTracking(entryId) {
    const database = getReadDb();
    const row = database
        .prepare("SELECT * FROM ttl_tracking WHERE entry_id = ?")
        .get(entryId);
    if (!row)
        return null;
    return {
        entryId: row.entry_id,
        contractId: row.contract_id,
        daoId: row.dao_id,
        method: row.method,
        lastRenewedAt: row.last_renewed_at,
        remainingLedgers: row.remaining_ledgers,
        urgency: row.urgency,
    };
}
export function getAllTTLTracking() {
    const database = getReadDb();
    const rows = database
        .prepare("SELECT * FROM ttl_tracking ORDER BY remaining_ledgers ASC")
        .all();
    return rows.map((row) => ({
        entryId: row.entry_id,
        contractId: row.contract_id,
        daoId: row.dao_id,
        method: row.method,
        lastRenewedAt: row.last_renewed_at,
        remainingLedgers: row.remaining_ledgers,
        urgency: row.urgency,
    }));
}
export function getGracePeriodEntries() {
    const database = getReadDb();
    const rows = database
        .prepare("SELECT * FROM ttl_tracking WHERE urgency = 'grace' ORDER BY remaining_ledgers ASC")
        .all();
    return rows.map((row) => ({
        entryId: row.entry_id,
        contractId: row.contract_id,
        daoId: row.dao_id,
        method: row.method,
        lastRenewedAt: row.last_renewed_at,
        remainingLedgers: row.remaining_ledgers,
        urgency: row.urgency,
    }));
}
export function createTTLCostLog(cycleId, cycleStart) {
    const database = getWriteDb();
    const result = database
        .prepare(`
    INSERT INTO ttl_cost_log (cycle_id, cycle_start, status)
    VALUES (?, ?, 'in_progress')
  `)
        .run(cycleId, cycleStart);
    return result.lastInsertRowid;
}
export function updateTTLCostLog(id, fields) {
    const database = getWriteDb();
    const sets = [];
    const values = [];
    if (fields.cycleEnd !== undefined) {
        sets.push("cycle_end = ?");
        values.push(fields.cycleEnd);
    }
    if (fields.entriesRenewed !== undefined) {
        sets.push("entries_renewed = ?");
        values.push(fields.entriesRenewed);
    }
    if (fields.entriesSkipped !== undefined) {
        sets.push("entries_skipped = ?");
        values.push(fields.entriesSkipped);
    }
    if (fields.txCount !== undefined) {
        sets.push("tx_count = ?");
        values.push(fields.txCount);
    }
    if (fields.totalFeeXlm !== undefined) {
        sets.push("total_fee_xlm = ?");
        values.push(fields.totalFeeXlm);
    }
    if (fields.status !== undefined) {
        sets.push("status = ?");
        values.push(fields.status);
    }
    if (sets.length === 0)
        return;
    values.push(id);
    database
        .prepare(`UPDATE ttl_cost_log SET ${sets.join(", ")} WHERE id = ?`)
        .run(...values);
}
export function getTTLCostLogs(limit = 10) {
    const database = getReadDb();
    const rows = database
        .prepare("SELECT * FROM ttl_cost_log ORDER BY id DESC LIMIT ?")
        .all(limit);
    return rows.map((row) => ({
        id: row.id,
        cycleId: row.cycle_id,
        cycleStart: row.cycle_start,
        cycleEnd: row.cycle_end,
        entriesRenewed: row.entries_renewed,
        entriesSkipped: row.entries_skipped,
        txCount: row.tx_count,
        totalFeeXlm: row.total_fee_xlm,
        status: row.status,
    }));
}
export function getTotalTTLCostXLM() {
    const database = getReadDb();
    const row = database
        .prepare("SELECT COALESCE(SUM(total_fee_xlm), 0) as total FROM ttl_cost_log WHERE status = 'completed'")
        .get();
    return row.total;
}
function rowToAuthToken(row) {
    return {
        id: row.id,
        tokenHash: row.token_hash,
        clientId: row.client_id,
        description: row.description ?? null,
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at ?? null,
        revokedAt: row.revoked_at ?? null,
        lastUsedAt: row.last_used_at ?? null,
        useCount: Number(row.use_count) || 0,
        rotationGroupId: row.rotation_group_id ?? null,
        isLegacy: !!row.is_legacy,
    };
}
export function createAuthToken(token) {
    const database = initDb();
    const query = `
    INSERT INTO auth_tokens (id, token_hash, client_id, description, expires_at, rotation_group_id, is_legacy)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
    const params = [
        token.id,
        token.tokenHash,
        token.clientId,
        token.description ?? null,
        token.expiresAt ?? null,
        token.rotationGroupId ?? null,
        token.isLegacy ? 1 : 0,
    ];
    logQuery(query, params, "create_auth_token");
    database.prepare(query).run(...params);
}
export function getAuthTokenByHash(tokenHash) {
    const database = initDb();
    const row = database
        .prepare("SELECT * FROM auth_tokens WHERE token_hash = ?")
        .get(tokenHash);
    return row ? rowToAuthToken(row) : null;
}
export function getAuthTokenById(id) {
    const database = initDb();
    const row = database
        .prepare("SELECT * FROM auth_tokens WHERE id = ?")
        .get(id);
    return row ? rowToAuthToken(row) : null;
}
export function getAllAuthTokens() {
    const database = initDb();
    const rows = database
        .prepare("SELECT * FROM auth_tokens ORDER BY created_at DESC")
        .all();
    return rows.map(rowToAuthToken);
}
export function getActiveAuthTokens() {
    const now = new Date().toISOString();
    const database = initDb();
    const rows = database
        .prepare(`SELECT * FROM auth_tokens 
       WHERE status = 'active' 
       AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`)
        .all(now);
    return rows.map(rowToAuthToken);
}
export function getValidAuthTokens(transitionMs) {
    const now = new Date().toISOString();
    const transitionCutoff = new Date(Date.now() - transitionMs).toISOString();
    const database = initDb();
    const rows = database
        .prepare(`SELECT * FROM auth_tokens 
       WHERE (
         status = 'active' 
         AND (expires_at IS NULL OR expires_at > ?)
       ) OR (
         status = 'rotating'
         AND revoked_at IS NOT NULL
         AND revoked_at > ?
       )
       ORDER BY created_at DESC`)
        .all(now, transitionCutoff);
    return rows.map(rowToAuthToken);
}
export function updateAuthTokenStatus(id, status) {
    const database = initDb();
    const query = "UPDATE auth_tokens SET status = ? WHERE id = ?";
    logQuery(query, [status, id], "update_auth_token_status");
    database.prepare(query).run(status, id);
}
export function revokeAuthToken(id) {
    const database = initDb();
    const query = "UPDATE auth_tokens SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE id = ?";
    logQuery(query, [id], "revoke_auth_token");
    database.prepare(query).run(id);
}
export function markTokenRotated(oldId, newId) {
    const database = initDb();
    database.transaction(() => {
        // Mark old token as rotating
        database
            .prepare("UPDATE auth_tokens SET status = 'rotating', revoked_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(oldId);
        // New token is already inserted by caller with same rotation_group_id
    })();
}
export function recordTokenUsage(id, ipHash) {
    const database = initDb();
    const query = "UPDATE auth_tokens SET last_used_at = CURRENT_TIMESTAMP, use_count = use_count + 1 WHERE id = ?";
    logQuery(query, [id], "record_token_usage");
    database.prepare(query).run(id);
}
export function expireAuthTokens() {
    const now = new Date().toISOString();
    const database = initDb();
    const query = `
    UPDATE auth_tokens SET status = 'expired' 
    WHERE status = 'active' 
    AND expires_at IS NOT NULL 
    AND expires_at <= ?
  `;
    logQuery(query, [now], "expire_auth_tokens");
    const result = database.prepare(query).run(now);
    return result.changes;
}
export function cleanupRevokedTokens(maxAgeMs = 7_776_000_000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const database = initDb();
    const query = `
    DELETE FROM auth_tokens 
    WHERE status IN ('revoked', 'expired', 'rotating') 
    AND revoked_at IS NOT NULL 
    AND revoked_at < ?
  `;
    logQuery(query, [cutoff], "cleanup_revoked_tokens");
    const result = database.prepare(query).run(cutoff);
    return result.changes;
}
export function getAuthTokensByClient(clientId) {
    const database = initDb();
    const rows = database
        .prepare("SELECT * FROM auth_tokens WHERE client_id = ? ORDER BY created_at DESC")
        .all(clientId);
    return rows.map(rowToAuthToken);
}
export function getTokensNeedingRotation(maxAgeMs) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const database = initDb();
    const rows = database
        .prepare(`SELECT * FROM auth_tokens 
       WHERE status = 'active' 
       AND is_legacy = 0
       AND created_at < ?
       AND (rotation_group_id IS NULL OR id IN (
         SELECT MIN(id) FROM auth_tokens WHERE rotation_group_id IS NOT NULL GROUP BY rotation_group_id
       ))
       ORDER BY created_at ASC`)
        .all(cutoff);
    return rows.map(rowToAuthToken);
}
// ============================================
// AUTH TOKEN AUDIT LOG FUNCTIONS
// ============================================
function rowToAuditEntry(row) {
    return {
        id: Number(row.id),
        tokenId: row.token_id ?? null,
        clientId: row.client_id ?? null,
        action: row.action,
        path: row.path ?? null,
        method: row.method ?? null,
        ipHash: row.ip_hash ?? null,
        success: !!row.success,
        errorMessage: row.error_message ?? null,
        createdAt: row.created_at ?? null,
    };
}
export function recordProofCommitment(commitmentHash, nullifier, daoId, proposalId, timestamp, walletAddress) {
    const database = initDb();
    const createdAt = new Date().toISOString();
    database
        .prepare(`INSERT INTO proof_commitments (commitment_hash, nullifier, dao_id, proposal_id, wallet_address, timestamp, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'COMMITTED', ?)
       ON CONFLICT(commitment_hash) DO UPDATE SET timestamp = excluded.timestamp, status = 'COMMITTED'`)
        .run(commitmentHash, nullifier, daoId, proposalId, walletAddress || null, timestamp, createdAt);
}
export function getProofCommitment(commitmentHash) {
    const database = initDb();
    const row = database
        .prepare("SELECT * FROM proof_commitments WHERE commitment_hash = ?")
        .get(commitmentHash);
    if (!row)
        return null;
    return {
        commitmentHash: row.commitment_hash,
        nullifier: row.nullifier,
        daoId: row.dao_id,
        proposalId: row.proposal_id,
        walletAddress: row.wallet_address,
        timestamp: row.timestamp,
        status: row.status,
        createdAt: row.created_at,
    };
}
export function recordAuthAudit(entry) {
    const database = initDb();
    const query = `
    INSERT INTO auth_token_audit (token_id, client_id, action, path, method, ip_hash, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
    const params = [
        entry.tokenId ?? null,
        entry.clientId ?? null,
        entry.action,
        entry.path ?? null,
        entry.method ?? null,
        entry.ipHash ?? null,
        entry.success !== false ? 1 : 0,
        entry.errorMessage ?? null,
    ];
    database.prepare(query).run(...params);
}
export function getAuditLog(options = {}) {
    const { tokenId, clientId, action, limit = 100, offset = 0 } = options;
    const database = initDb();
    let query = "SELECT * FROM auth_token_audit WHERE 1=1";
    const params = [];
    if (tokenId) {
        query += " AND token_id = ?";
        params.push(tokenId);
    }
    if (clientId) {
        query += " AND client_id = ?";
        params.push(clientId);
    }
    if (action) {
        query += " AND action = ?";
        params.push(action);
    }
    query += " ORDER BY id DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);
    const rows = database.prepare(query).all(...params);
    return rows.map(rowToAuditEntry);
}
export function cleanupAuditLog(maxAgeMs = 15_552_000_000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const database = initDb();
    const result = database
        .prepare("DELETE FROM auth_token_audit WHERE created_at < ?")
        .run(cutoff);
    return result.changes;
}
export function updateProofCommitmentStatus(commitmentHash, status) {
    const database = initDb();
    database
        .prepare("UPDATE proof_commitments SET status = ? WHERE commitment_hash = ?")
        .run(status, commitmentHash);
}
/**
 * Store a vote receipt for confirmation and verification
 */
export function storeVoteReceipt(nullifier, txHash, proposalId, daoId, status = "confirmed") {
    const database = getWriteDb();
    try {
        database
            .prepare(`INSERT INTO vote_receipts (nullifier, tx_hash, proposal_id, dao_id, status)
         VALUES (?, ?, ?, ?, ?)`)
            .run(nullifier, txHash, proposalId, daoId, status);
        incrementTransactionCounter();
    }
    catch (err) {
        // Ignore duplicate key errors (idempotent)
        if (!(err instanceof Error && err.message.includes("UNIQUE"))) {
            throw err;
        }
    }
}
/**
 * Retrieve a vote receipt by nullifier
 */
export function getVoteReceipt(nullifier) {
    const database = getReadDb();
    const row = database
        .prepare("SELECT * FROM vote_receipts WHERE nullifier = ?")
        .get(nullifier);
    return row ? row : null;
}
/**
 * Retrieve vote receipts for a specific DAO
 */
export function getVoteReceiptsByDao(daoId, limit = 100, offset = 0) {
    const database = getReadDb();
    const rows = database
        .prepare(`SELECT * FROM vote_receipts
       WHERE dao_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`)
        .all(daoId, limit, offset);
    return rows ? rows : [];
}
//# sourceMappingURL=db.js.map