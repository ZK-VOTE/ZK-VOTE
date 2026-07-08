/**
 * SQLite Database for ZKVote Event Storage
 *
 * Provides persistent storage for events with efficient querying.
 * Supports frontend notifications with on-chain verification.
 */
import { type Database as DatabaseType } from "better-sqlite3";
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
/**
 * Initialize the database
 */
export declare function initDb(): DatabaseType;
/**
 * Close the database
 */
export declare function closeDb(): void;
/**
 * Get metadata value by key
 */
export declare function getMetadata<T>(key: string): T | null;
/**
 * Set metadata value
 */
export declare function setMetadata<T>(key: string, value: T): void;
/**
 * Add an event to the database
 * Returns true if added, false if duplicate
 */
export declare function addEvent(event: EventInput): boolean;
/**
 * Add a pending (unverified) event from frontend notification
 * The event will be verified against the chain before being marked as verified
 */
export declare function addPendingEvent(daoId: number, type: string, data: Record<string, unknown> | null, txHash: string): boolean;
/**
 * Mark an event as verified
 */
export declare function verifyEvent(txHash: string, ledger: number): void;
/**
 * Get events for a DAO
 */
export declare function getEventsForDao(daoId: number, options?: EventQueryOptions): EventQueryResult;
/**
 * Get all indexed DAOs
 */
export declare function getIndexedDaos(): IndexedDao[];
/**
 * Get database status
 */
export declare function getDbStatus(): DbStatus;
/**
 * Get unverified events that need chain verification
 */
export declare function getUnverifiedEvents(limit?: number): Event[];
/**
 * Delete an unverified event (if verification fails)
 */
export declare function deleteUnverifiedEvent(txHash: string): void;
/**
 * Upsert a DAO into the cache
 */
export declare function upsertDao(dao: DaoInput): void;
/**
 * Upsert multiple DAOs in a transaction
 */
export declare function upsertDaos(daos: DaoInput[]): void;
/**
 * Get all cached DAOs
 */
export declare function getAllCachedDaos(): DaoCache[];
/**
 * Get a specific cached DAO by ID
 */
export declare function getCachedDao(daoId: number): DaoCache | null;
/**
 * Get DAOs for a specific user (by membership)
 * This requires the daos table to be populated with user membership data
 * For now, returns all DAOs - user filtering will be done by the frontend
 */
export declare function getDaosForUser(_userAddress: string): DaoCache[];
/**
 * Get the last sync timestamp for DAOs
 */
export declare function getDaosSyncTime(): string | null;
/**
 * Set the last sync timestamp for DAOs
 */
export declare function setDaosSyncTime(timestamp: string): void;
/**
 * Get cached DAO count
 */
export declare function getCachedDaoCount(): number;
/**
 * Migrate events from JSON file to SQLite
 */
export declare function migrateFromJson(jsonPath: string): number;
//# sourceMappingURL=db.d.ts.map