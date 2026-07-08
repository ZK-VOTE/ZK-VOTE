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
const log = (level, event, meta = {}) => {
    console.log(JSON.stringify({ level, event, ts: new Date().toISOString(), ...meta }));
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
/**
 * Poll for new events from Soroban RPC
 */
async function pollEvents(server, contracts, startLedger) {
    try {
        const latestLedger = await server.getLatestLedger();
        const currentLedger = latestLedger.sequence;
        if (startLedger >= currentLedger) {
            return startLedger;
        }
        for (const contractId of contracts) {
            try {
                // The SDK now requires endLedger
                const events = await server.getEvents({
                    startLedger: startLedger + 1,
                    endLedger: currentLedger,
                    filters: [
                        {
                            type: "contract",
                            contractIds: [contractId],
                        },
                    ],
                    limit: 100,
                });
                if (events.events && events.events.length > 0) {
                    let addedCount = 0;
                    for (const event of events.events) {
                        const parsed = parseEventData(event);
                        if (parsed && parsed.daoId !== null) {
                            const eventInput = {
                                daoId: parsed.daoId,
                                type: parsed.type,
                                data: parsed.data,
                                ledger: parsed.ledger,
                                txHash: parsed.txHash,
                                timestamp: parsed.timestamp,
                                verified: true, // Events from RPC are verified
                            };
                            const added = db.addEvent(eventInput);
                            if (added)
                                addedCount++;
                        }
                    }
                    if (addedCount > 0) {
                        log("info", "events_indexed", {
                            contract: contractId.slice(0, 8) + "...",
                            count: addedCount,
                            latestLedger: currentLedger,
                        });
                    }
                }
            }
            catch (err) {
                const error = err;
                if (!error.message.includes("not found")) {
                    log("warn", "poll_contract_failed", {
                        contract: contractId.slice(0, 8) + "...",
                        error: error.message,
                    });
                }
            }
        }
        return currentLedger;
    }
    catch (err) {
        log("error", "poll_events_failed", { error: err.message });
        return startLedger;
    }
}
// ============================================
// VERIFICATION
// ============================================
/**
 * Verify a pending event against the chain
 * Returns true if verified, false if should be deleted
 */
async function verifyEventOnChain(event) {
    if (!rpcServer || !event.tx_hash)
        return false;
    try {
        // Try to get the transaction
        const txResult = await rpcServer.getTransaction(event.tx_hash);
        if (txResult.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
            // Transaction confirmed - mark as verified
            db.verifyEvent(event.tx_hash, txResult.ledger);
            log("info", "event_verified", {
                txHash: event.tx_hash,
                ledger: txResult.ledger,
            });
            return true;
        }
        else if (txResult.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
            // Transaction failed - delete the event
            db.deleteUnverifiedEvent(event.tx_hash);
            log("warn", "event_verification_failed", {
                txHash: event.tx_hash,
                status: txResult.status,
            });
            return false;
        }
        // NOT_FOUND - keep pending for now
        return false;
    }
    catch (err) {
        log("warn", "event_verify_error", {
            txHash: event.tx_hash,
            error: err.message,
        });
        return false;
    }
}
/**
 * Background job to verify pending events
 */
async function verifyPendingEvents() {
    const unverified = db.getUnverifiedEvents(10);
    for (const event of unverified) {
        await verifyEventOnChain(event);
    }
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
    // Initialize database and migrate from JSON if exists
    db.initDb();
    const jsonPath = path.join(__dirname, "..", "..", "data", "events.json");
    db.migrateFromJson(jsonPath);
    let lastLedger = db.getMetadata("lastLedger") ?? 0;
    log("info", "indexer_started", {
        contracts: contracts.length,
        pollInterval: pollIntervalMs,
        startLedger: lastLedger,
    });
    // Initial poll
    lastLedger = await pollEvents(rpcServer, contracts, lastLedger);
    db.setMetadata("lastLedger", lastLedger);
    // Periodic polling
    const poll = async () => {
        if (!isPolling)
            return;
        try {
            const newLedger = await pollEvents(rpcServer, contracts, lastLedger);
            if (newLedger > lastLedger) {
                lastLedger = newLedger;
                db.setMetadata("lastLedger", lastLedger);
            }
            // Also verify any pending events
            await verifyPendingEvents();
        }
        catch (err) {
            log("error", "poll_failed", { error: err.message });
        }
        setTimeout(poll, pollIntervalMs);
    };
    setTimeout(poll, pollIntervalMs);
}
/**
 * Stop the indexer
 */
export function stopIndexer() {
    isPolling = false;
    db.closeDb();
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