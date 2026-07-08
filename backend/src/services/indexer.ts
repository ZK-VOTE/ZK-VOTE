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
import type { Event, EventInput, EventQueryOptions, DbStatus } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// TYPES
// ============================================

/** Event types we index from contracts */
const EVENT_TYPES: Record<string, string> = {
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

/** Parsed event from the chain */
interface ParsedEvent {
  type: string;
  daoId: number | null;
  data: Record<string, unknown>;
  ledger: number;
  txHash: string | null;
  timestamp: string;
}

/** Indexer status response */
export interface IndexerStatus extends DbStatus {
  isRunning: boolean;
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

// Re-export types that may be needed by consumers
export type { Event, EventQueryOptions };

// ============================================
// STATE
// ============================================

let isPolling = false;
let rpcServer: StellarSdk.rpc.Server | null = null;

// ============================================
// LOGGER
// ============================================

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogMeta {
  [key: string]: unknown;
}

const log = (level: LogLevel, event: string, meta: LogMeta = {}): void => {
  console.log(
    JSON.stringify({ level, event, ts: new Date().toISOString(), ...meta }),
  );
};

// ============================================
// EVENT PARSING
// ============================================

/**
 * Parse contract event data from Soroban RPC
 */
function parseEventData(event: {
  topic?: StellarSdk.xdr.ScVal[];
  value?: StellarSdk.xdr.ScVal;
  ledger?: number;
  txHash?: string;
}): ParsedEvent | null {
  try {
    const topics = event.topic ?? [];
    const data = event.value;

    let eventType = "unknown";
    let daoId: number | null = null;
    let parsed: Record<string, unknown> = {};

    if (topics.length > 0) {
      const eventName = StellarSdk.scValToNative(topics[0]) as string;
      eventType = EVENT_TYPES[eventName] ?? eventName;

      if (topics.length > 1) {
        try {
          daoId = Number(StellarSdk.scValToNative(topics[1]));
        } catch {
          // Not a DAO ID
        }
      }
    }

    if (data) {
      try {
        parsed = StellarSdk.scValToNative(data) as Record<string, unknown>;
      } catch {
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
  } catch (err) {
    log("warn", "event_parse_failed", { error: (err as Error).message });
    return null;
  }
}

// ============================================
// POLLING
// ============================================

/**
 * Poll for new events from Soroban RPC
 */
async function pollEvents(
  server: StellarSdk.rpc.Server,
  contracts: string[],
  startLedger: number,
): Promise<number> {
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
              const eventInput: EventInput = {
                daoId: parsed.daoId,
                type: parsed.type,
                data: parsed.data,
                ledger: parsed.ledger,
                txHash: parsed.txHash,
                timestamp: parsed.timestamp,
                verified: true, // Events from RPC are verified
              };
              const added = db.addEvent(eventInput);
              if (added) addedCount++;
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
      } catch (err) {
        const error = err as Error;
        if (!error.message.includes("not found")) {
          log("warn", "poll_contract_failed", {
            contract: contractId.slice(0, 8) + "...",
            error: error.message,
          });
        }
      }
    }

    return currentLedger;
  } catch (err) {
    log("error", "poll_events_failed", { error: (err as Error).message });
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
async function verifyEventOnChain(event: Event): Promise<boolean> {
  if (!rpcServer || !event.tx_hash) return false;

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
    } else if (
      txResult.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED
    ) {
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
  } catch (err) {
    log("warn", "event_verify_error", {
      txHash: event.tx_hash,
      error: (err as Error).message,
    });
    return false;
  }
}

/**
 * Background job to verify pending events
 */
async function verifyPendingEvents(): Promise<void> {
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
export async function startIndexer(
  server:
    | StellarSdk.rpc.Server
    | { getLatestLedger: () => Promise<{ sequence: number }> },
  contracts: string[],
  pollIntervalMs = 5000,
): Promise<void> {
  if (isPolling) {
    log("warn", "indexer_already_running");
    return;
  }

  isPolling = true;
  rpcServer = server as StellarSdk.rpc.Server;

  // Initialize database and migrate from JSON if exists
  db.initDb();
  const jsonPath = path.join(__dirname, "..", "..", "data", "events.json");
  db.migrateFromJson(jsonPath);

  let lastLedger = db.getMetadata<number>("lastLedger") ?? 0;

  log("info", "indexer_started", {
    contracts: contracts.length,
    pollInterval: pollIntervalMs,
    startLedger: lastLedger,
  });

  // Initial poll
  lastLedger = await pollEvents(rpcServer, contracts, lastLedger);
  db.setMetadata("lastLedger", lastLedger);

  // Periodic polling
  const poll = async (): Promise<void> => {
    if (!isPolling) return;

    try {
      const newLedger = await pollEvents(rpcServer!, contracts, lastLedger);
      if (newLedger > lastLedger) {
        lastLedger = newLedger;
        db.setMetadata("lastLedger", lastLedger);
      }

      // Also verify any pending events
      await verifyPendingEvents();
    } catch (err) {
      log("error", "poll_failed", { error: (err as Error).message });
    }

    setTimeout(poll, pollIntervalMs);
  };

  setTimeout(poll, pollIntervalMs);
}

/**
 * Stop the indexer
 */
export function stopIndexer(): void {
  isPolling = false;
  db.closeDb();
  log("info", "indexer_stopped");
}

/**
 * Get events for a specific DAO
 */
export function getEventsForDao(
  daoId: number,
  options: EventQueryOptions = {},
): EventsResult {
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
export function getIndexedDaos(): number[] {
  db.initDb();
  const daos = db.getIndexedDaos();
  return daos.map((d) => d.daoId);
}

/**
 * Get indexer status
 */
export function getIndexerStatus(): IndexerStatus {
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
export function addManualEvent(
  daoId: number,
  type: string,
  data: Record<string, unknown>,
  ledger = 0,
): void {
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
export function notifyEvent(
  daoId: number,
  type: string,
  data: Record<string, unknown>,
  txHash: string,
): void {
  db.initDb();
  db.addPendingEvent(daoId, type, data, txHash);
  log("info", "event_notified", { daoId, type, txHash });
}

/**
 * Get the RPC server instance (for on-chain verification)
 */
export function getRpcServer(): StellarSdk.rpc.Server | null {
  return rpcServer;
}

/**
 * Ensure a dao_create event exists for a DAO
 * Creates a synthetic event if one doesn't already exist
 * This handles DAOs created before the indexer started watching
 */
export function ensureDaoCreateEvent(daoId: number, daoData: DaoData): boolean {
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
