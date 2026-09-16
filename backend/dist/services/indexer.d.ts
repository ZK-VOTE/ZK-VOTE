/**
 * Event Indexer for DaoVote
 *
 * Stores events in SQLite for persistence.
 * Supports frontend notifications with on-chain verification.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import type { Event, EventInput, EventQueryOptions, DbStatus } from "./db.js";
import { type RelayReplayFixture } from "./replay.js";
/** Indexer status response */
export interface IndexerStatus extends DbStatus {
    isRunning: boolean;
    isStreaming?: boolean;
    queueDepth?: number;
    indexerLag: number;
    hasGap: boolean;
    catchUpMode: boolean;
    checkpoint: string | null;
}
/** DAO data for synthetic events */
export interface DaoData {
    id?: number;
    name?: string;
    creator?: string;
    membership_open?: boolean;
    members_can_propose?: boolean;
    metadata_cid?: string | null;
    member_count?: number;
}
/** Events result with pagination */
export interface EventsResult {
    events: Event[];
    total: number;
}
export type { Event, EventQueryOptions };
/**
 * The replay fixture for the most recently captured poll cycle, or `null`
 * when capture is disabled or no cycle has completed yet.
 */
export declare function getLastReplayFixture(): RelayReplayFixture | null;
/**
 * Start the event indexer
 */
export declare function startIndexer(server: StellarSdk.rpc.Server | {
    getLatestLedger: () => Promise<{
        sequence: number;
    }>;
}, contracts: string[], pollIntervalMs?: number): Promise<void>;
/**
 * Stop the indexer
 */
export declare function stopIndexer(): Promise<void>;
/**
 * Get events for a specific DAO
 */
export declare function getEventsForDao(daoId: number, options?: EventQueryOptions): EventsResult;
/**
 * Get all indexed DAOs
 */
export declare function getIndexedDaos(): number[];
/**
 * Ingest an event through the backpressure queue
 */
export declare function pushStreamEvent(eventInput: EventInput): Promise<boolean>;
/**
 * Drain queued stream events to persistent storage
 */
export declare function drainEventQueue(): Promise<number>;
/**
 * Start indexer in streaming mode with automatic gap detection and backpressure
 */
export declare function startStreamingIndexer(server: StellarSdk.rpc.Server, contracts: string[], pollIntervalMs?: number): Promise<void>;
/**
 * Get indexer status
 */
export declare function getIndexerStatus(): IndexerStatus;
/**
 * Manually add an event (useful for testing)
 */
export declare function addManualEvent(daoId: number, type: string, data: Record<string, unknown>, ledger?: number): void;
/**
 * Notify the indexer of an event from the frontend
 * The event is stored as pending and verified against the chain
 */
export declare function notifyEvent(daoId: number, type: string, data: Record<string, unknown>, txHash: string): void;
/**
 * Get the RPC server instance (for on-chain verification)
 */
export declare function getRpcServer(): StellarSdk.rpc.Server | null;
/**
 * Ensure a dao_create event exists for a DAO
 * Creates a synthetic event if one doesn't already exist
 * This handles DAOs created before the indexer started watching
 */
export declare function ensureDaoCreateEvent(daoId: number, daoData: DaoData): boolean;
//# sourceMappingURL=indexer.d.ts.map