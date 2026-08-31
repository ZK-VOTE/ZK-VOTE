/**
 * Event Indexer for DaoVote
 *
 * Stores events in SQLite for persistence.
 * Supports frontend notifications with on-chain verification.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import path from "path";
import { fileURLToPath } from "url";
import * as db from "./db.js";
import { serviceLastRunTime, serviceErrors, serviceRunning, indexerEventsProcessed, indexerLag as indexerLagGauge, indexerWatermarkLedger, indexerPollDuration, indexerOverrunSkips, } from "./metrics.js";
import { markDegraded, markHealthy } from "./service-health.js";
import { WatermarkScheduler } from "./indexer-scheduler.js";
import { withIndexerSpan } from "./indexer-tracing.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// ============================================
// TYPES
// ============================================
/** Event types we index from contracts */
const EVENT_TYPES = {
    // DAO Registry
    DaoCreateEvent: "dao_create",
    AdminXferEvent: "admin_transfer",
    // Membership SBT
    SbtMintEvent: "member_added",
    SbtRevokeEvent: "member_revoked",
    SbtLeaveEvent: "member_left",
    // Membership Tree
    TreeInitEvent: "tree_init",
    CommitEvent: "voter_registered",
    RemovalEvent: "voter_removed",
    ReinstatementEvent: "voter_reinstated",
    // Voting
    VKSetEvent: "vk_updated",
    ProposalEvent: "proposal_created",
    ProposalClosedEvent: "proposal_closed",
    ProposalArchivedEvent: "proposal_archived",
    VoteEvent: "vote_cast",
};
// ============================================
// STATE
// ============================================
let isPolling = false;
let rpcServer = null;
let indexerLag = 0;
let hasGap = false;
let catchUpMode = false;
let activeScheduler = null;
const log = (level, event, meta = {}) => {
    console.info(JSON.stringify({ level, event, ts: new Date().toISOString(), ...meta }));
};
// ============================================
// EVENT PARSING
// ============================================
/**
 * Parse contract event data from Soroban RPC
 */
function parseEventData(event) {
    try {
        const topics = event.topic ?? [];
        const data = event.value;
        let eventType = "unknown";
        let daoId = null;
        let parsed = {};
        if (topics.length > 0) {
            const eventName = StellarSdk.scValToNative(topics[0]);
            eventType = EVENT_TYPES[eventName] ?? eventName;
            if (topics.length > 1) {
                try {
                    daoId = Number(StellarSdk.scValToNative(topics[1]));
                }
                catch {
                    // Not a DAO ID
                }
            }
        }
        if (data) {
            try {
                parsed = StellarSdk.scValToNative(data);
            }
            catch {
                // Keep raw
            }
        }
        return {
            type: eventType,
            daoId,
            data: parsed,
            ledger: event.ledger ?? 0,
            txHash: event.txHash ?? null,
            timestamp: new Date().toISOString(),
        };
    }
    catch (err) {
        log("warn", "event_parse_failed", { error: err.message });
        return null;
    }
}
// ============================================
// POLLING
// ============================================
function throwIfAborted(signal) {
    if (signal.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new Error("Indexer poll aborted");
    }
}
/** Poll for new events from Soroban RPC. */
async function pollEvents(server, contracts, startLedger, parentSpan, signal) {
    try {
        throwIfAborted(signal);
        const latestLedger = await withIndexerSpan("indexer.stellar.latest_ledger", parentSpan, { component: "stellar" }, () => server.getLatestLedger());
        throwIfAborted(signal);
        const currentLedger = latestLedger.sequence;
        if (startLedger >= currentLedger) {
            indexerLag = 0;
            indexerLagGauge.set(0);
            catchUpMode = false;
            return startLedger;
        }
        indexerLag = currentLedger - startLedger;
        indexerLagGauge.set(indexerLag);
        let targetEndLedger = currentLedger;
        if (indexerLag > 100) {
            catchUpMode = true;
            hasGap = true;
            targetEndLedger = startLedger + 100;
        }
        else {
            catchUpMode = false;
        }
        for (const contractId of contracts) {
            throwIfAborted(signal);
            try {
                const events = await withIndexerSpan("indexer.stellar.get_events", parentSpan, {
                    component: "stellar",
                    contract: contractId,
                    start_ledger: startLedger + 1,
                    end_ledger: targetEndLedger,
                }, () => server.getEvents({
                    startLedger: startLedger + 1,
                    endLedger: targetEndLedger,
                    filters: [
                        {
                            type: "contract",
                            contractIds: [contractId],
                        },
                    ],
                    limit: 100,
                }));
                throwIfAborted(signal);
                if (events.events && events.events.length > 0) {
                    const addedCount = await withIndexerSpan("indexer.db.persist_events", parentSpan, {
                        component: "database",
                        contract: contractId,
                        event_count: events.events.length,
                    }, () => {
                        let count = 0;
                        for (const event of events.events) {
                            throwIfAborted(signal);
                            const parsed = parseEventData(event);
                            if (parsed && parsed.daoId !== null) {
                                const eventInput = {
                                    daoId: parsed.daoId,
                                    type: parsed.type,
                                    data: parsed.data,
                                    ledger: parsed.ledger,
                                    txHash: parsed.txHash,
                                    timestamp: parsed.timestamp,
                                    verified: true,
                                };
                                if (db.addEvent(eventInput))
                                    count++;
                            }
                        }
                        return count;
                    });
                    if (addedCount > 0) {
                        indexerEventsProcessed.inc({ event_type: "indexed" }, addedCount);
                        log("info", "events_indexed", {
                            contract: contractId.slice(0, 8) + "...",
                            count: addedCount,
                            latestLedger: targetEndLedger,
                        });
                    }
                }
            }
            catch (err) {
                if (signal.aborted)
                    throw err;
                const error = err;
                if (!error.message.includes("not found")) {
                    log("warn", "poll_contract_failed", {
                        contract: contractId.slice(0, 8) + "...",
                        error: error.message,
                    });
                }
            }
        }
        throwIfAborted(signal);
        await withIndexerSpan("indexer.db.persist_checkpoint", parentSpan, { component: "database", ledger: targetEndLedger }, () => db.setMetadata("indexerCheckpoint", new Date().toISOString()));
        return targetEndLedger;
    }
    catch (err) {
        log("error", "poll_events_failed", { error: err.message });
        throw err;
    }
}
// ============================================
// VERIFICATION
// ============================================
/** Verify a pending event against the chain. */
async function verifyEventOnChain(event, parentSpan, signal) {
    if (!rpcServer || !event.tx_hash)
        return false;
    try {
        throwIfAborted(signal);
        const txResult = await withIndexerSpan("indexer.stellar.verify_transaction", parentSpan, { component: "stellar" }, () => rpcServer.getTransaction(event.tx_hash));
        throwIfAborted(signal);
        if (txResult.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
            await withIndexerSpan("indexer.db.verify_event", parentSpan, { component: "database", ledger: txResult.ledger }, () => db.verifyEvent(event.tx_hash, txResult.ledger));
            log("info", "event_verified", {
                txHash: event.tx_hash,
                ledger: txResult.ledger,
            });
            return true;
        }
        if (txResult.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
            await withIndexerSpan("indexer.db.delete_failed_event", parentSpan, { component: "database" }, () => db.deleteUnverifiedEvent(event.tx_hash));
            log("warn", "event_verification_failed", {
                txHash: event.tx_hash,
                status: txResult.status,
            });
        }
        return false;
    }
    catch (err) {
        if (signal.aborted)
            throw err;
        log("warn", "event_verify_error", {
            txHash: event.tx_hash,
            error: err.message,
        });
        return false;
    }
}
/** Background job to verify pending events. */
async function verifyPendingEvents(parentSpan, signal) {
    const unverified = await withIndexerSpan("indexer.db.load_pending_events", parentSpan, { component: "database" }, () => {
        db.cleanupExpiredPendingEvents(15 * 60 * 1000);
        return db.getUnverifiedEvents(10);
    });
    for (const event of unverified) {
        throwIfAborted(signal);
        await verifyEventOnChain(event, parentSpan, signal);
    }
}
async function runPollingCycle(server, contracts, lastLedger, signal) {
    const stopTimer = indexerPollDuration.startTimer();
    try {
        return await withIndexerSpan("indexer.poll_cycle", null, { contract_count: contracts.length, start_ledger: lastLedger }, async (rootSpan) => {
            const newLedger = await pollEvents(server, contracts, lastLedger, rootSpan, signal);
            throwIfAborted(signal);
            if (newLedger > lastLedger) {
                await withIndexerSpan("indexer.db.persist_watermark", rootSpan, { component: "database", ledger: newLedger }, () => db.setMetadata("lastLedger", newLedger));
            }
            indexerWatermarkLedger.set(newLedger);
            await verifyPendingEvents(rootSpan, signal);
            markHealthy("indexer");
            serviceLastRunTime.set({ service: "indexer" }, Date.now() / 1000);
            return newLedger;
        });
    }
    finally {
        stopTimer();
    }
}
function handlePollError(error) {
    serviceErrors.inc({ service: "indexer" });
    markDegraded("indexer", error.message);
    log("error", "poll_failed", { error: error.message });
}
// ============================================
// PUBLIC API
// ============================================
/**
 * Start the event indexer
 */
export async function startIndexer(server, contracts, pollIntervalMs = 5000) {
    if (isPolling) {
        log("warn", "indexer_already_running");
        return;
    }
    isPolling = true;
    rpcServer = server;
    serviceRunning.set({ service: "indexer" }, 1);
    // Initialize database and migrate from JSON if exists
    db.initDb();
    const jsonPath = path.join(__dirname, "..", "..", "data", "events.json");
    db.migrateFromJson(jsonPath);
    // Migrate from monolithic events table to per-DAO partitions
    // Idempotent — safe to run on every startup until migration is complete
    const migrated = db.migrateToPartitions();
    if (migrated > 0) {
        log("info", "partition_migration_complete", { migrated });
    }
    let lastLedger = db.getMetadata("lastLedger") ?? 0;
    log("info", "indexer_started", {
        contracts: contracts.length,
        pollInterval: pollIntervalMs,
        startLedger: lastLedger,
    });
    const initialController = new AbortController();
    try {
        lastLedger = await runPollingCycle(rpcServer, contracts, lastLedger, initialController.signal);
    }
    catch (error) {
        handlePollError(error instanceof Error ? error : new Error(String(error)));
    }
    activeScheduler = new WatermarkScheduler({
        intervalMs: pollIntervalMs,
        runCycle: async (signal) => {
            lastLedger = await runPollingCycle(rpcServer, contracts, lastLedger, signal);
        },
        onOverrun: (skippedPolls) => {
            indexerOverrunSkips.inc(skippedPolls);
            log("warn", "indexer_poll_overrun", { skippedPolls });
        },
        onError: handlePollError,
    });
    activeScheduler.start();
}
/**
 * Stop the indexer
 */
export function stopIndexer() {
    isPolling = false;
    serviceRunning.set({ service: "indexer" }, 0);
    rpcServer = null;
    const scheduler = activeScheduler;
    activeScheduler = null;
    if (scheduler) {
        void scheduler.stop().finally(() => {
            if (!isPolling)
                db.closeDb();
        });
    }
    else {
        db.closeDb();
    }
    log("info", "indexer_stopped");
}
/**
 * Get events for a specific DAO
 */
export function getEventsForDao(daoId, options = {}) {
    db.initDb(); // Ensure DB is initialized
    const result = db.getEventsForDao(daoId, options);
    return {
        events: result.events,
        total: result.total,
    };
}
/**
 * Get all indexed DAOs
 */
export function getIndexedDaos() {
    db.initDb();
    const daos = db.getIndexedDaos();
    return daos.map((d) => d.daoId);
}
/**
 * Get indexer status
 */
export function getIndexerStatus() {
    db.initDb();
    const status = db.getDbStatus();
    return {
        isRunning: isPolling,
        indexerLag,
        hasGap,
        catchUpMode,
        checkpoint: db.getMetadata("indexerCheckpoint") ?? null,
        ...status,
    };
}
/**
 * Manually add an event (useful for testing)
 */
export function addManualEvent(daoId, type, data, ledger = 0) {
    db.initDb();
    db.addEvent({
        daoId: Number(daoId),
        type,
        data,
        ledger,
        txHash: "manual-" + Date.now(),
        timestamp: new Date().toISOString(),
        verified: true,
    });
}
/**
 * Notify the indexer of an event from the frontend
 * The event is stored as pending and verified against the chain
 */
export function notifyEvent(daoId, type, data, txHash) {
    db.initDb();
    db.addPendingEvent(daoId, type, data, txHash);
    log("info", "event_notified", { daoId, type, txHash });
}
/**
 * Get the RPC server instance (for on-chain verification)
 */
export function getRpcServer() {
    return rpcServer;
}
/**
 * Ensure a dao_create event exists for a DAO
 * Creates a synthetic event if one doesn't already exist
 * This handles DAOs created before the indexer started watching
 */
export function ensureDaoCreateEvent(daoId, daoData) {
    db.initDb();
    // Check if dao_create event already exists for this DAO
    const existingEvents = db.getEventsForDao(daoId, {
        types: ["dao_create", "dao_create_event"],
        limit: 1,
    });
    if (existingEvents.events.length > 0) {
        // Already has a dao_create event
        return false;
    }
    // Create a synthetic dao_create event
    const added = db.addEvent({
        daoId: Number(daoId),
        type: "dao_create",
        data: {
            admin: daoData.creator,
            name: daoData.name,
            synthetic: true, // Mark as synthetic (not from on-chain event)
        },
        ledger: 0, // Unknown ledger for historical events
        txHash: `synthetic-dao-create-${daoId}`,
        timestamp: new Date(0).toISOString(), // Epoch time to sort to the bottom
        verified: true,
    });
    if (added) {
        log("info", "dao_create_event_synthesized", { daoId, name: daoData.name });
    }
    return added;
}
//# sourceMappingURL=indexer.js.map