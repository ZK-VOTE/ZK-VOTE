/**
 * SQLite Database for ZKVote Event Storage
 *
 * Provides persistent storage for events with efficient querying.
 * Supports frontend notifications with on-chain verification.
 */

import Database, { type Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DB_FILE = path.join(DATA_DIR, "zkvote.db");

// ============================================
// TYPES
// ============================================

export interface Event {
  id?: number;
  dao_id: number;
  type: string;
  data: Record<string, unknown> | null;
  ledger: number | null;
  tx_hash: string | null;
  timestamp: string;
  verified: boolean;
  created_at?: string;
}

export interface EventInput {
  daoId: number;
  type: string;
  data: Record<string, unknown> | null;
  ledger?: number | null;
  txHash?: string | null;
  timestamp?: string;
  verified?: boolean;
}

export interface EventQueryOptions {
  limit?: number;
  offset?: number;
  types?: string[] | null;
  verifiedOnly?: boolean;
}

export interface EventQueryResult {
  events: Event[];
  total: number;
  daoId: number;
}

export interface DaoCache {
  id: number;
  name: string;
  creator: string;
  membership_open: boolean;
  members_can_propose: boolean;
  metadata_cid: string | null;
  member_count: number;
  updated_at?: string;
}

export interface DaoInput {
  id: number;
  name: string;
  creator: string;
  membership_open: boolean;
  members_can_propose: boolean;
  metadata_cid?: string | null;
  member_count?: number;
}

export interface DbStatus {
  totalEvents: number;
  daoCount: number;
  lastLedger: number;
}

export interface IndexedDao {
  daoId: number;
  eventCount: number;
}

// ============================================
// LOGGER
// ============================================

import { createLogger } from "./logger.js";

const dbLogger = createLogger("db");
const log = (
  level: "debug" | "info" | "warn" | "error",
  event: string,
  meta: Record<string, unknown> = {},
): void => {
  dbLogger[level](event, meta);
};

// ============================================
// DATABASE INSTANCE
// ============================================

let db: DatabaseType | null = null;

/**
 * Initialize the database
 */
export function initDb(): DatabaseType {
  if (db) return db;

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
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    log("info", "db_closed");
  }
}

// ============================================
// METADATA FUNCTIONS
// ============================================

interface MetadataRow {
  value: string;
}

/**
 * Get metadata value by key
 */
export function getMetadata<T>(key: string): T | null {
  const database = initDb();
  const row = database
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(key) as MetadataRow | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

/**
 * Set metadata value
 */
export function setMetadata<T>(key: string, value: T): void {
  const database = initDb();
  database
    .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
    .run(key, JSON.stringify(value));
}

// ============================================
// EVENT FUNCTIONS
// ============================================

interface EventRow {
  id: number;
  dao_id: number;
  type: string;
  data: string | null;
  ledger: number | null;
  tx_hash: string | null;
  timestamp: string;
  verified: number;
  created_at: string;
}

interface CountRow {
  total: number;
}

/**
 * Add an event to the database
 * Returns true if added, false if duplicate
 */
export function addEvent(event: EventInput): boolean {
  const database = initDb();
  try {
    database
      .prepare(
        `
      INSERT INTO events (dao_id, type, data, ledger, tx_hash, timestamp, verified)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        event.daoId,
        event.type,
        JSON.stringify(event.data),
        event.ledger ?? null,
        event.txHash ?? null,
        event.timestamp ?? new Date().toISOString(),
        event.verified ? 1 : 0,
      );
    return true;
  } catch (err) {
    const error = err as { code?: string };
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
export function addPendingEvent(
  daoId: number,
  type: string,
  data: Record<string, unknown> | null,
  txHash: string,
): boolean {
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
export function verifyEvent(txHash: string, ledger: number): void {
  const database = initDb();
  database
    .prepare("UPDATE events SET verified = 1, ledger = ? WHERE tx_hash = ?")
    .run(ledger, txHash);
}

/**
 * Get events for a DAO
 */
export function getEventsForDao(
  daoId: number,
  options: EventQueryOptions = {},
): EventQueryResult {
  const database = initDb();
  const {
    limit = 50,
    offset = 0,
    types = null,
    verifiedOnly = false,
  } = options;

  let query = "SELECT * FROM events WHERE dao_id = ?";
  const params: (number | string)[] = [daoId];

  if (types && types.length > 0) {
    query += ` AND type IN (${types.map(() => "?").join(",")})`;
    params.push(...types);
  }

  if (verifiedOnly) {
    query += " AND verified = 1";
  }

  query += " ORDER BY timestamp DESC, ledger DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const events = database.prepare(query).all(...params) as EventRow[];

  // Get total count
  let countQuery = "SELECT COUNT(*) as total FROM events WHERE dao_id = ?";
  const countParams: (number | string)[] = [daoId];
  if (types && types.length > 0) {
    countQuery += ` AND type IN (${types.map(() => "?").join(",")})`;
    countParams.push(...types);
  }
  if (verifiedOnly) {
    countQuery += " AND verified = 1";
  }
  const countResult = database
    .prepare(countQuery)
    .get(...countParams) as CountRow;

  return {
    events: events.map((e) => ({
      id: e.id,
      dao_id: e.dao_id,
      type: e.type,
      data: e.data ? (JSON.parse(e.data) as Record<string, unknown>) : null,
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
export function getIndexedDaos(): IndexedDao[] {
  const database = initDb();
  const rows = database
    .prepare(
      `
    SELECT dao_id, COUNT(*) as event_count
    FROM events
    GROUP BY dao_id
    ORDER BY dao_id
  `,
    )
    .all() as Array<{ dao_id: number; event_count: number }>;

  return rows.map((r) => ({
    daoId: r.dao_id,
    eventCount: r.event_count,
  }));
}

/**
 * Get database status
 */
export function getDbStatus(): DbStatus {
  const database = initDb();
  const totalResult = database
    .prepare("SELECT COUNT(*) as total FROM events")
    .get() as CountRow;
  const daoCountResult = database
    .prepare("SELECT COUNT(DISTINCT dao_id) as daoCount FROM events")
    .get() as { daoCount: number };
  const lastLedger = getMetadata<number>("lastLedger") ?? 0;

  return {
    totalEvents: totalResult.total,
    daoCount: daoCountResult.daoCount,
    lastLedger,
  };
}

/**
 * Get unverified events that need chain verification
 */
export function getUnverifiedEvents(limit = 10): Event[] {
  const database = initDb();
  const rows = database
    .prepare(
      `
    SELECT * FROM events
    WHERE verified = 0 AND tx_hash IS NOT NULL
    ORDER BY created_at ASC
    LIMIT ?
  `,
    )
    .all(limit) as EventRow[];

  return rows.map((e) => ({
    id: e.id,
    dao_id: e.dao_id,
    type: e.type,
    data: e.data ? (JSON.parse(e.data) as Record<string, unknown>) : null,
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
export function deleteUnverifiedEvent(txHash: string): void {
  const database = initDb();
  database
    .prepare("DELETE FROM events WHERE tx_hash = ? AND verified = 0")
    .run(txHash);
}

// ============================================
// DAO CACHE FUNCTIONS
// ============================================

interface DaoRow {
  id: number;
  name: string;
  creator: string;
  membership_open: number;
  members_can_propose: number;
  metadata_cid: string | null;
  member_count: number;
  updated_at: string;
}

/**
 * Upsert a DAO into the cache
 */
export function upsertDao(dao: DaoInput): void {
  const database = initDb();
  database
    .prepare(
      `
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
  `,
    )
    .run(
      dao.id,
      dao.name,
      dao.creator,
      dao.membership_open ? 1 : 0,
      dao.members_can_propose ? 1 : 0,
      dao.metadata_cid ?? null,
      dao.member_count ?? 0,
    );
}

/**
 * Upsert multiple DAOs in a transaction
 */
export function upsertDaos(daos: DaoInput[]): void {
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
      stmt.run(
        dao.id,
        dao.name,
        dao.creator,
        dao.membership_open ? 1 : 0,
        dao.members_can_propose ? 1 : 0,
        dao.metadata_cid ?? null,
        dao.member_count ?? 0,
      );
    }
  })();

  log("info", "daos_upserted", { count: daos.length });
}

/**
 * Get all cached DAOs
 */
export function getAllCachedDaos(): DaoCache[] {
  const database = initDb();
  const rows = database
    .prepare("SELECT * FROM daos ORDER BY id ASC")
    .all() as DaoRow[];
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
export function getCachedDao(daoId: number): DaoCache | null {
  const database = initDb();
  const row = database.prepare("SELECT * FROM daos WHERE id = ?").get(daoId) as
    | DaoRow
    | undefined;
  if (!row) return null;
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
export function getDaosForUser(_userAddress: string): DaoCache[] {
  // This would require a separate user_dao_memberships table
  // For now, just return all DAOs
  return getAllCachedDaos();
}

/**
 * Get the last sync timestamp for DAOs
 */
export function getDaosSyncTime(): string | null {
  return getMetadata<string>("daosSyncTime");
}

/**
 * Set the last sync timestamp for DAOs
 */
export function setDaosSyncTime(timestamp: string): void {
  setMetadata("daosSyncTime", timestamp);
}

/**
 * Get cached DAO count
 */
export function getCachedDaoCount(): number {
  const database = initDb();
  const result = database
    .prepare("SELECT COUNT(*) as count FROM daos")
    .get() as { count: number };
  return result.count;
}

// ============================================
// MIGRATION FUNCTIONS
// ============================================

/**
 * Migrate events from JSON file to SQLite
 */
export function migrateFromJson(jsonPath: string): number {
  const database = initDb();

  if (!fs.existsSync(jsonPath)) {
    log("info", "no_json_to_migrate");
    return 0;
  }

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as {
      events?: Record<
        string,
        Array<{
          type: string;
          data: Record<string, unknown> | null;
          ledger?: number | null;
          txHash?: string | null;
          timestamp?: string;
        }>
      >;
      lastLedger?: number;
    };
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
            insertStmt.run(
              Number(daoId),
              event.type,
              JSON.stringify(event.data),
              event.ledger ?? null,
              event.txHash ?? null,
              event.timestamp ?? new Date().toISOString(),
            );
            migrated++;
          } catch {
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
  } catch (err) {
    const error = err as Error;
    log("error", "json_migration_failed", { error: error.message });
    return 0;
  }
}
