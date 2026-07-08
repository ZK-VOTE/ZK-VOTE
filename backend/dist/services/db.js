/**
 * SQLite Database for ZKVote Event Storage
 *
 * Provides persistent storage for events with efficient querying.
 * Supports frontend notifications with on-chain verification.
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DB_FILE = path.join(DATA_DIR, "zkvote.db");
// ============================================
// LOGGER
// ============================================
import { createLogger } from "./logger.js";
const dbLogger = createLogger("db");
const log = (level, event, meta = {}) => {
    dbLogger[level](event, meta);
};
// ============================================
// DATABASE INSTANCE
// ============================================
let db = null;
/**
 * Initialize the database
 */
export function initDb() {
    if (db)
        return db;
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    db = new Database(DB_FILE);
    db.pragma("journal_mode = WAL"); // Better concurrency
    // Create tables
    db.exec(`
    -- Events table
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dao_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT, -- JSON
      ledger INTEGER,
      tx_hash TEXT,
      timestamp TEXT NOT NULL,
      verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(dao_id, ledger, tx_hash, type)
    );

    -- Indexes for efficient querying
    CREATE INDEX IF NOT EXISTS idx_events_dao_id ON events(dao_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_events_ledger ON events(ledger DESC);
    CREATE INDEX IF NOT EXISTS idx_events_dao_type ON events(dao_id, type);

    -- Metadata table for tracking state
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- DAOs table for cached DAO data
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
  `);
    log("info", "db_initialized", { path: DB_FILE });
    return db;
}
/**
 * Close the database
 */
export function closeDb() {
    if (db) {
        db.close();
        db = null;
        log("info", "db_closed");
    }
}
/**
 * Get metadata value by key
 */
export function getMetadata(key) {
    const database = initDb();
    const row = database
        .prepare("SELECT value FROM metadata WHERE key = ?")
        .get(key);
    return row ? JSON.parse(row.value) : null;
}
/**
 * Set metadata value
 */
export function setMetadata(key, value) {
    const database = initDb();
    database
        .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
        .run(key, JSON.stringify(value));
}
/**
 * Add an event to the database
 * Returns true if added, false if duplicate
 */
export function addEvent(event) {
    const database = initDb();
    try {
        database
            .prepare(`
      INSERT INTO events (dao_id, type, data, ledger, tx_hash, timestamp, verified)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
            .run(event.daoId, event.type, JSON.stringify(event.data), event.ledger ?? null, event.txHash ?? null, event.timestamp ?? new Date().toISOString(), event.verified ? 1 : 0);
        return true;
    }
    catch (err) {
        const error = err;
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
            return false; // Duplicate
        }
        throw err;
    }
}
/**
 * Add a pending (unverified) event from frontend notification
 * The event will be verified against the chain before being marked as verified
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
 * Mark an event as verified
 */
export function verifyEvent(txHash, ledger) {
    const database = initDb();
    database
        .prepare("UPDATE events SET verified = 1, ledger = ? WHERE tx_hash = ?")
        .run(ledger, txHash);
}
/**
 * Get events for a DAO
 */
export function getEventsForDao(daoId, options = {}) {
    const database = initDb();
    const { limit = 50, offset = 0, types = null, verifiedOnly = false, } = options;
    let query = "SELECT * FROM events WHERE dao_id = ?";
    const params = [daoId];
    if (types && types.length > 0) {
        query += ` AND type IN (${types.map(() => "?").join(",")})`;
        params.push(...types);
    }
    if (verifiedOnly) {
        query += " AND verified = 1";
    }
    query += " ORDER BY timestamp DESC, ledger DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);
    const events = database.prepare(query).all(...params);
    // Get total count
    let countQuery = "SELECT COUNT(*) as total FROM events WHERE dao_id = ?";
    const countParams = [daoId];
    if (types && types.length > 0) {
        countQuery += ` AND type IN (${types.map(() => "?").join(",")})`;
        countParams.push(...types);
    }
    if (verifiedOnly) {
        countQuery += " AND verified = 1";
    }
    const countResult = database
        .prepare(countQuery)
        .get(...countParams);
    return {
        events: events.map((e) => ({
            id: e.id,
            dao_id: e.dao_id,
            type: e.type,
            data: e.data ? JSON.parse(e.data) : null,
            ledger: e.ledger,
            tx_hash: e.tx_hash,
            timestamp: e.timestamp,
            verified: !!e.verified,
            created_at: e.created_at,
        })),
        total: countResult.total,
        daoId,
    };
}
/**
 * Get all indexed DAOs
 */
export function getIndexedDaos() {
    const database = initDb();
    const rows = database
        .prepare(`
    SELECT dao_id, COUNT(*) as event_count
    FROM events
    GROUP BY dao_id
    ORDER BY dao_id
  `)
        .all();
    return rows.map((r) => ({
        daoId: r.dao_id,
        eventCount: r.event_count,
    }));
}
/**
 * Get database status
 */
export function getDbStatus() {
    const database = initDb();
    const totalResult = database
        .prepare("SELECT COUNT(*) as total FROM events")
        .get();
    const daoCountResult = database
        .prepare("SELECT COUNT(DISTINCT dao_id) as daoCount FROM events")
        .get();
    const lastLedger = getMetadata("lastLedger") ?? 0;
    return {
        totalEvents: totalResult.total,
        daoCount: daoCountResult.daoCount,
        lastLedger,
    };
}
/**
 * Get unverified events that need chain verification
 */
export function getUnverifiedEvents(limit = 10) {
    const database = initDb();
    const rows = database
        .prepare(`
    SELECT * FROM events
    WHERE verified = 0 AND tx_hash IS NOT NULL
    ORDER BY created_at ASC
    LIMIT ?
  `)
        .all(limit);
    return rows.map((e) => ({
        id: e.id,
        dao_id: e.dao_id,
        type: e.type,
        data: e.data ? JSON.parse(e.data) : null,
        ledger: e.ledger,
        tx_hash: e.tx_hash,
        timestamp: e.timestamp,
        verified: !!e.verified,
        created_at: e.created_at,
    }));
}
/**
 * Delete an unverified event (if verification fails)
 */
export function deleteUnverifiedEvent(txHash) {
    const database = initDb();
    database
        .prepare("DELETE FROM events WHERE tx_hash = ? AND verified = 0")
        .run(txHash);
}
/**
 * Upsert a DAO into the cache
 */
export function upsertDao(dao) {
    const database = initDb();
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
}
/**
 * Upsert multiple DAOs in a transaction
 */
export function upsertDaos(daos) {
    const database = initDb();
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
}
/**
 * Get all cached DAOs
 */
export function getAllCachedDaos() {
    const database = initDb();
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
    const database = initDb();
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
    // This would require a separate user_dao_memberships table
    // For now, just return all DAOs
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
    const database = initDb();
    const result = database
        .prepare("SELECT COUNT(*) as count FROM daos")
        .get();
    return result.count;
}
// ============================================
// MIGRATION FUNCTIONS
// ============================================
/**
 * Migrate events from JSON file to SQLite
 */
export function migrateFromJson(jsonPath) {
    const database = initDb();
    if (!fs.existsSync(jsonPath)) {
        log("info", "no_json_to_migrate");
        return 0;
    }
    try {
        const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        const events = data.events ?? {};
        let migrated = 0;
        const insertStmt = database.prepare(`
      INSERT OR IGNORE INTO events (dao_id, type, data, ledger, tx_hash, timestamp, verified)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `);
        database.transaction(() => {
            for (const [daoId, daoEvents] of Object.entries(events)) {
                for (const event of daoEvents) {
                    try {
                        insertStmt.run(Number(daoId), event.type, JSON.stringify(event.data), event.ledger ?? null, event.txHash ?? null, event.timestamp ?? new Date().toISOString());
                        migrated++;
                    }
                    catch {
                        // Skip duplicates
                    }
                }
            }
            // Save last ledger
            if (data.lastLedger) {
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
//# sourceMappingURL=db.js.map