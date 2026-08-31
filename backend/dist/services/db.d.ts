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
import { type Database as DatabaseType } from "better-sqlite3";
/** Optional Prometheus sink — wired from boot so db.ts stays testable without prom-client. */
export interface DbMetricsSink {
    setConnectionsActive(n: number): void;
    setWalSizeBytes(n: number): void;
    setReadLagMs(n: number): void;
    setWriteHealthy(healthy: boolean): void;
    incWriteFailover(result: "success" | "failure"): void;
}
export declare function setDbMetricsSink(sink: DbMetricsSink | null): void;
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
    orderBy?: string;
    orderDirection?: string;
    cursor?: string;
    cursorField?: string;
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
    /** Size of the SQLite WAL file in bytes (0 if absent). */
    walSizeBytes?: number;
    /** Estimated read-connection lag behind the writer (ms). */
    readLagMs?: number;
    /** Whether the write connection is healthy. */
    writeHealthy?: boolean;
    /** Active SQLite connections (write + read). */
    connectionsActive?: number;
}
export interface IndexedDao {
    daoId: number;
    eventCount: number;
}
export declare class WriteConnectionUnavailableError extends Error {
    constructor(message: string);
}
export declare function getWalSizeBytes(dbFile?: string): number;
/**
 * Estimate how far the read connection lags the writer.
 * Same-file WAL readers typically see lag ≈ 0 once the write commits;
 * a version mismatch reports time since the last successful write.
 */
export declare function getReadReplicaLagMs(): number;
/**
 * Attempt to reopen the write connection after failure.
 * Read connection is left open so API queries can continue in degraded mode.
 */
export declare function reconnectWriteDb(): boolean;
/** Reopen the readonly connection (e.g. after restore / WAL truncate). */
export declare function reopenReadDb(): void;
export declare function isWriteConnectionHealthy(): boolean;
export declare function getWriteFailureReason(): string | null;
/**
 * Return the write connection (initializing if needed).
 * On connection-level failure, attempts one reconnect (failover).
 * Does not switch away from an already-open custom dbPath.
 */
export declare function getWriteDb(): DatabaseType;
/**
 * Return the readonly connection for API queries.
 * Falls back to the write connection if the read handle is unavailable
 * (degraded mode) so GET endpoints keep serving.
 */
export declare function getReadDb(): DatabaseType;
/**
 * Initialize the database and migrate from the monolithic schema.
 * Opens a write connection plus a readonly read connection on the same
 * WAL-mode file for query isolation (issue #205).
 * SECURITY: Enables SQLite strict mode and WAL journaling.
 * @returns The write connection (backward compatible with prior callers).
 */
export declare function initDb(dbPath?: string): DatabaseType;
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
export declare function getDb(): DatabaseType;
/**
 * Close write and read database connections.
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
 * Add an event to the database.
 * Writes to the partition table for the DAO.
 * Returns true if added, false if duplicate.
 * SECURITY: Validates event type and uses parameterized queries.
 */
export declare function addEvent(event: EventInput): boolean;
/**
 * Add a pending (unverified) event from frontend notification.
 */
export declare function addPendingEvent(daoId: number, type: string, data: Record<string, unknown> | null, txHash: string): boolean;
/**
 * Mark an event as verified.
 * Searches across the DAO's partition table.
 * SECURITY: Uses parameterized queries and validates inputs.
 */
export declare function verifyEvent(txHash: string, ledger: number): void;
/**
 * Get events for a DAO (from its partition).
 * Supports both cursor-based and offset-based pagination.
 * SECURITY: Uses parameterized queries and validates all inputs.
 */
export declare function getEventsForDao(daoId: number, options?: EventQueryOptions): EventQueryResult;
/**
 * Get all indexed DAOs (with event counts from partitions).
 */
export declare function getIndexedDaos(): IndexedDao[];
/**
 * Get database status (cross-DAO aggregates).
 */
export declare function getDbStatus(): DbStatus;
/**
 * Get unverified events that need chain verification.
 * Searches across all partitions.
 */
export declare function getUnverifiedEvents(limit?: number): Event[];
/**
 * Delete an unverified event (if verification fails).
 */
export declare function deleteUnverifiedEvent(txHash: string): void;
export interface TransactionLogRow {
    nullifier_hash: string;
    tx_hash: string;
    status: string;
    created_at: string;
    updated_at: string;
}
/**
 * Get transaction log by nullifier hash.
 */
export declare function getTransactionLog(nullifierHash: string): TransactionLogRow | null;
/**
 * Record new transaction submission in transaction log.
 */
export declare function recordTransactionLog(nullifierHash: string, txHash: string, status?: string): void;
/**
 * Update transaction status in transaction log.
 */
export declare function updateTransactionLogStatus(nullifierHash: string, status: string, txHash?: string): void;
/**
 * Cleanup old transaction log entries.
 */
export declare function cleanupTransactionLog(maxAgeMs?: number): number;
export interface VoteSubmissionRow {
    id: number;
    nullifier_hash: string;
    status: "pending" | "confirmed" | "failed";
    tx_hash: string | null;
    created_at: number;
    updated_at: number;
}
/**
 * Look up an existing vote submission by nullifier hash.
 */
export declare function getVoteSubmission(nullifierHash: string): VoteSubmissionRow | null;
/**
 * Insert a new pending vote submission. Returns false if nullifier already exists (idempotency race).
 */
export declare function insertVoteSubmission(nullifierHash: string): boolean;
/**
 * Update an existing vote submission to confirmed or failed.
 */
export declare function updateVoteSubmission(nullifierHash: string, status: "confirmed" | "failed", txHash?: string): void;
/**
 * Delete vote submissions older than ttlMs whose status is not confirmed.
 */
export declare function cleanupExpiredVoteSubmissions(ttlMs: number): number;
export interface AuditLogInput {
    timestamp: string;
    action: string;
    endpoint: string;
    authTokenId: string | null;
    ipHash: string | null;
    requestId: string | null;
    params: string | null;
    statusCode: number | null;
}
export interface AuditLogRow {
    id: number;
    timestamp: string;
    action: string;
    endpoint: string;
    auth_token_id: string | null;
    ip_hash: string | null;
    request_id: string | null;
    params: string | null;
    status_code: number | null;
    prev_hash: string | null;
    hash: string;
    archived_at: string | null;
}
export interface AuditLogQueryOptions {
    limit?: number;
    offset?: number;
    action?: string;
}
/**
 * Insert an audit log entry, chaining its hash to the previous entry's hash.
 * Read-then-write happens inside a single better-sqlite3 transaction (and,
 * since better-sqlite3 calls are synchronous, without any await in between),
 * so concurrent inserts can't interleave and desync the chain.
 */
export declare function insertAuditLog(entry: AuditLogInput): AuditLogRow;
/**
 * Paginated audit log query (newest first), optionally filtered by action.
 */
export declare function getAuditLogs(options?: AuditLogQueryOptions): {
    logs: AuditLogRow[];
    total: number;
};
/**
 * All audit log rows in insertion order, for hash-chain verification.
 */
export declare function getAllAuditLogsOrdered(): AuditLogRow[];
/**
 * Unarchived rows older than the given ISO cutoff — candidates for rotation.
 */
export declare function getUnarchivedAuditLogsOlderThan(cutoffIso: string): AuditLogRow[];
/**
 * Mark rows as archived (allowed by the immutable-core trigger, which only
 * blocks changes to fields other than archived_at).
 */
export declare function markAuditLogsArchived(ids: number[], archivedAt: string): void;
/**
 * Delete rows from the hot table. Only succeeds for rows already marked
 * archived_at — enforced by the audit_log_no_unarchived_delete trigger.
 */
export declare function deleteAuditLogs(ids: number[]): number;
/**
 * Count pending (unverified) events for a specific DAO.
 */
export declare function getPendingEventsCountForDao(daoId: number): number;
/**
 * Cleanup expired unverified pending events across partitions older than ttlMs.
 */
export declare function cleanupExpiredPendingEvents(ttlMs?: number): number;
/**
 * Ensure a partition table exists for the given DAO ID.
 * Public version — call this when a new DAO is created.
 */
export declare function ensurePartition(daoId: number): void;
/**
 * Drop a partition table (for DAO deletion/archival).
 * Removes the DAO from the registry as well.
 */
export declare function dropPartition(daoId: number): void;
/**
 * Migrate events from the old monolithic `events` table to per-DAO
 * partition tables.  This is idempotent — safe to re-run.
 *
 * Returns the number of events migrated.
 */
export declare function migrateToPartitions(): number;
/**
 * Migrate events from JSON file to SQLite (legacy migration).
 * Now routes into partition tables.
 * SECURITY: Validates all JSON input and uses parameterized queries.
 */
export declare function migrateFromJson(jsonPath: string): number;
/**
 * Get comprehensive database diagnostics for the /db/stats endpoint.
 * Includes query metrics, table statistics, cache stats, and index analysis.
 */
export declare function getDbDiagnostics(): Record<string, unknown>;
/**
 * Profile queries for a specific DAO partition (for diagnostics).
 */
export declare function profileDaoQueries(daoId: number): void;
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
export interface TTLTrackingEntry {
    entryId: string;
    contractId: string;
    daoId: number | null;
    method: string | null;
    lastRenewedAt: string | null;
    remainingLedgers: number | null;
    urgency: string;
}
export interface TTLCostLogEntry {
    id: number;
    cycleId: string;
    cycleStart: string | null;
    cycleEnd: string | null;
    entriesRenewed: number;
    entriesSkipped: number;
    txCount: number;
    totalFeeXlm: number;
    status: string;
}
export declare function upsertTTLTracking(entry: TTLTrackingEntry): void;
export declare function getTTLTracking(entryId: string): TTLTrackingEntry | null;
export declare function getAllTTLTracking(): TTLTrackingEntry[];
export declare function getGracePeriodEntries(): TTLTrackingEntry[];
export declare function createTTLCostLog(cycleId: string, cycleStart: string): number;
export declare function updateTTLCostLog(id: number, fields: Partial<{
    cycleEnd: string;
    entriesRenewed: number;
    entriesSkipped: number;
    txCount: number;
    totalFeeXlm: number;
    status: string;
}>): void;
export declare function getTTLCostLogs(limit?: number): TTLCostLogEntry[];
export declare function getTotalTTLCostXLM(): number;
export interface AuthToken {
    id: string;
    tokenHash: string;
    clientId: string;
    description: string | null;
    status: "active" | "expired" | "revoked" | "rotating";
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
    useCount: number;
    rotationGroupId: string | null;
    isLegacy: boolean;
}
export interface AuthTokenAuditEntry {
    id: number;
    tokenId: string | null;
    clientId: string | null;
    action: string;
    path: string | null;
    method: string | null;
    ipHash: string | null;
    success: boolean;
    errorMessage: string | null;
    createdAt: string;
}
export declare function createAuthToken(token: {
    id: string;
    tokenHash: string;
    clientId: string;
    description?: string | null;
    expiresAt?: string | null;
    rotationGroupId?: string | null;
    isLegacy?: boolean;
}): void;
export declare function getAuthTokenByHash(tokenHash: string): AuthToken | null;
export declare function getAuthTokenById(id: string): AuthToken | null;
export declare function getAllAuthTokens(): AuthToken[];
export declare function getActiveAuthTokens(): AuthToken[];
export declare function getValidAuthTokens(transitionMs: number): AuthToken[];
export declare function updateAuthTokenStatus(id: string, status: AuthToken["status"]): void;
export declare function revokeAuthToken(id: string): void;
export declare function markTokenRotated(oldId: string, newId: string): void;
export declare function recordTokenUsage(id: string, ipHash: string | null): void;
export declare function expireAuthTokens(): number;
export declare function cleanupRevokedTokens(maxAgeMs?: number): number;
export declare function getAuthTokensByClient(clientId: string): AuthToken[];
export declare function getTokensNeedingRotation(maxAgeMs: number): AuthToken[];
export interface ProofCommitmentRecord {
    commitmentHash: string;
    nullifier: string;
    daoId: number;
    proposalId: number;
    walletAddress?: string | null;
    timestamp: number;
    status: "COMMITTED" | "REVEALED" | "EXPIRED";
    createdAt: string;
}
export declare function recordProofCommitment(commitmentHash: string, nullifier: string, daoId: number, proposalId: number, timestamp: number, walletAddress?: string | null): void;
export declare function getProofCommitment(commitmentHash: string): ProofCommitmentRecord | null;
export declare function recordAuthAudit(entry: {
    tokenId?: string | null;
    clientId?: string | null;
    action: string;
    path?: string | null;
    method?: string | null;
    ipHash?: string | null;
    success?: boolean;
    errorMessage?: string | null;
}): void;
export declare function getAuditLog(options?: {
    tokenId?: string;
    clientId?: string;
    action?: string;
    limit?: number;
    offset?: number;
}): AuthTokenAuditEntry[];
export declare function cleanupAuditLog(maxAgeMs?: number): number;
export declare function updateProofCommitmentStatus(commitmentHash: string, status: "COMMITTED" | "REVEALED" | "EXPIRED"): void;
/**
 * Store a vote receipt for confirmation and verification
 */
export declare function storeVoteReceipt(nullifier: string, txHash: string, proposalId: number, daoId: number, status?: "confirmed" | "pending" | "failed"): void;
/**
 * Retrieve a vote receipt by nullifier
 */
export declare function getVoteReceipt(nullifier: string): Record<string, unknown> | null;
/**
 * Retrieve vote receipts for a specific DAO
 */
export declare function getVoteReceiptsByDao(daoId: number, limit?: number, offset?: number): Record<string, unknown>[];
//# sourceMappingURL=db.d.ts.map