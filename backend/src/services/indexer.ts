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
import {
  serviceLastRunTime,
  serviceErrors,
  serviceRunning,
  indexerEventsProcessed,
  indexerLag as indexerLagGauge,
  indexerWatermarkLedger,
  indexerPollDuration,
  indexerOverrunSkips,
  indexerQueueDepth,
  indexerRpcStreamReconnectsTotal,
  indexerGapRecoveriesTotal,
} from "./metrics.js";
import { markDegraded, markHealthy } from "./service-health.js";
import { WatermarkScheduler } from "./indexer-scheduler.js";
import { withIndexerSpan, type IndexerSpanContext } from "./indexer-tracing.js";
import {
  isReplayCaptureEnabled,
  recordInteraction,
  startRecording,
  stopRecording,
  writeFixture,
  type RelayReplayFixture,
} from "./replay.js";

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

// Re-export types that may be needed by consumers
export type { Event, EventQueryOptions };

// ============================================
// STATE
// ============================================

let isPolling = false;
let isStreamingMode = false;
let rpcServer: StellarSdk.rpc.Server | null = null;
let indexerLag = 0;
let hasGap = false;
let catchUpMode = false;
let activeScheduler: WatermarkScheduler | null = null;
let eventQueue: EventInput[] = [];
let isDrainingQueue = false;
const HIGH_WATERMARK = 500;
const LOW_WATERMARK = 100;

// ============================================
// LOGGER
// ============================================

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogMeta {
  [key: string]: unknown;
}

const log = (level: LogLevel, event: string, meta: LogMeta = {}): void => {
  console.info(
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
    let proposalId: number | null = null;
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

      // Proposal-scoped events carry the proposal ID as their second topic
      // (see ProposalEvent / VoteEvent in contracts/voting). It is not part of
      // the event value, so lift it into `data` — governance analytics (#322)
      // groups turnout by it.
      if (topics.length > 2) {
        try {
          const topicProposalId = Number(StellarSdk.scValToNative(topics[2]));
          if (Number.isFinite(topicProposalId)) {
            proposalId = topicProposalId;
          }
        } catch {
          // Not a proposal ID — event is DAO scoped only.
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
      data: proposalId === null ? parsed : { proposalId, ...parsed },
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Indexer poll aborted");
  }
}

/** Poll for new events from Soroban RPC. */
async function pollEvents(
  server: StellarSdk.rpc.Server,
  contracts: string[],
  startLedger: number,
  parentSpan: IndexerSpanContext,
  signal: AbortSignal,
): Promise<number> {
  try {
    throwIfAborted(signal);
    const latestLedger = await withIndexerSpan(
      "indexer.stellar.latest_ledger",
      parentSpan,
      { component: "stellar" },
      () => server.getLatestLedger(),
    );
    throwIfAborted(signal);
    const currentLedger = latestLedger.sequence;
    recordInteraction("rpc", "rpc.getLatestLedger", {
      sequence: currentLedger,
    });

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
    } else {
      catchUpMode = false;
    }

    for (const contractId of contracts) {
      throwIfAborted(signal);
      try {
        const events = await withIndexerSpan(
          "indexer.stellar.get_events",
          parentSpan,
          {
            component: "stellar",
            contract: contractId,
            start_ledger: startLedger + 1,
            end_ledger: targetEndLedger,
          },
          () =>
            server.getEvents({
              startLedger: startLedger + 1,
              endLedger: targetEndLedger,
              filters: [
                {
                  type: "contract",
                  contractIds: [contractId],
                },
              ],
              limit: 100,
            }),
        );
        throwIfAborted(signal);

        if (events.events && events.events.length > 0) {
          const addedCount = await withIndexerSpan(
            "indexer.db.persist_events",
            parentSpan,
            {
              component: "database",
              contract: contractId,
              event_count: events.events.length,
            },
            () => {
              let count = 0;
              for (const event of events.events) {
                throwIfAborted(signal);
                const parsed = parseEventData(event);
                if (parsed && parsed.daoId !== null) {
                  const eventInput: EventInput = {
                    daoId: parsed.daoId,
                    type: parsed.type,
                    data: parsed.data,
                    ledger: parsed.ledger,
                    txHash: parsed.txHash,
                    timestamp: parsed.timestamp,
                    verified: true,
                  };
                  if (db.addEvent(eventInput)) {
                    count++;
                    recordInteraction("db", "db.addEvent", {
                      daoId: eventInput.daoId,
                      type: eventInput.type,
                      ledger: eventInput.ledger,
                      txHash: eventInput.txHash,
                      timestamp: eventInput.timestamp,
                    });
                  }
                }
              }
              return count;
            },
          );

          if (addedCount > 0) {
            indexerEventsProcessed.inc({ event_type: "indexed" }, addedCount);
            log("info", "events_indexed", {
              contract: contractId.slice(0, 8) + "...",
              count: addedCount,
              latestLedger: targetEndLedger,
            });
          }
        }
      } catch (err) {
        if (signal.aborted) throw err;
        const error = err as Error;
        if (!error.message.includes("not found")) {
          log("warn", "poll_contract_failed", {
            contract: contractId.slice(0, 8) + "...",
            error: error.message,
          });
        }
      }
    }

    throwIfAborted(signal);
    await withIndexerSpan(
      "indexer.db.persist_checkpoint",
      parentSpan,
      { component: "database", ledger: targetEndLedger },
      () => db.setMetadata("indexerCheckpoint", new Date().toISOString()),
    );
    return targetEndLedger;
  } catch (err) {
    log("error", "poll_events_failed", { error: (err as Error).message });
    throw err;
  }
}

// ============================================
// VERIFICATION
// ============================================

/** Verify a pending event against the chain. */
async function verifyEventOnChain(
  event: Event,
  parentSpan: IndexerSpanContext,
  signal: AbortSignal,
): Promise<boolean> {
  if (!rpcServer || !event.tx_hash) return false;

  try {
    throwIfAborted(signal);
    const txResult = await withIndexerSpan(
      "indexer.stellar.verify_transaction",
      parentSpan,
      { component: "stellar" },
      () => rpcServer!.getTransaction(event.tx_hash!),
    );
    throwIfAborted(signal);

    if (txResult.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
      await withIndexerSpan(
        "indexer.db.verify_event",
        parentSpan,
        { component: "database", ledger: txResult.ledger },
        () => db.verifyEvent(event.tx_hash!, txResult.ledger),
      );
      log("info", "event_verified", {
        txHash: event.tx_hash,
        ledger: txResult.ledger,
      });
      return true;
    }

    if (txResult.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
      await withIndexerSpan(
        "indexer.db.delete_failed_event",
        parentSpan,
        { component: "database" },
        () => db.deleteUnverifiedEvent(event.tx_hash!),
      );
      log("warn", "event_verification_failed", {
        txHash: event.tx_hash,
        status: txResult.status,
      });
    }
    return false;
  } catch (err) {
    if (signal.aborted) throw err;
    log("warn", "event_verify_error", {
      txHash: event.tx_hash,
      error: (err as Error).message,
    });
    return false;
  }
}

/** Background job to verify pending events. */
async function verifyPendingEvents(
  parentSpan: IndexerSpanContext,
  signal: AbortSignal,
): Promise<void> {
  const unverified = await withIndexerSpan(
    "indexer.db.load_pending_events",
    parentSpan,
    { component: "database" },
    () => {
      db.cleanupExpiredPendingEvents(15 * 60 * 1000);
      return db.getUnverifiedEvents(10);
    },
  );

  verificationBacklog = unverified.length;

  for (const event of unverified) {
    throwIfAborted(signal);
    if (await verifyEventOnChain(event, parentSpan, signal)) {
      verificationBacklog = Math.max(0, verificationBacklog - 1);
    }
  }
}

/** Directory replay fixtures are written to when capture is enabled. */
const REPLAY_FIXTURE_DIR =
  process.env.RELAY_REPLAY_DIR ||
  path.join(__dirname, "..", "..", "data", "replay");

/** Fixture from the most recent captured cycle, exposed for tooling/tests. */
let lastReplayFixture: RelayReplayFixture | null = null;

/**
 * The replay fixture for the most recently captured poll cycle, or `null`
 * when capture is disabled or no cycle has completed yet.
 */
export function getLastReplayFixture(): RelayReplayFixture | null {
  return lastReplayFixture;
}

/**
 * Persist a captured cycle so it can be replayed offline (#321).
 *
 * Fixture writes are best effort: a full disk or a read-only mount must not
 * turn a healthy poll cycle into a failed one.
 */
function persistReplayFixture(fixture: RelayReplayFixture): void {
  lastReplayFixture = fixture;
  try {
    writeFixture(
      path.join(REPLAY_FIXTURE_DIR, `poll-cycle-${fixture.traceId}.json`),
      fixture,
    );
    log("info", "replay_fixture_written", {
      traceId: fixture.traceId,
      interactions: fixture.interactions.length,
      digest: fixture.digest,
    });
  } catch (error) {
    log("warn", "replay_fixture_write_failed", {
      error: (error as Error).message,
    });
  }
}

async function runPollingCycle(
  server: StellarSdk.rpc.Server,
  contracts: string[],
  lastLedger: number,
  signal: AbortSignal,
): Promise<number> {
  const stopTimer = indexerPollDuration.startTimer();
  const capturing = isReplayCaptureEnabled();
  try {
    return await withIndexerSpan(
      "indexer.poll_cycle",
      null,
      { contract_count: contracts.length, start_ledger: lastLedger },
      async (rootSpan) => {
        // Recording starts inside the root span so the fixture inherits the
        // cycle's trace ID — a fixture and its exported spans are joinable.
        if (capturing) startRecording("indexer.poll_cycle", rootSpan.traceId);
        const newLedger = await pollEvents(
          server,
          contracts,
          lastLedger,
          rootSpan,
          signal,
        );
        throwIfAborted(signal);

        if (newLedger > lastLedger) {
          await withIndexerSpan(
            "indexer.db.persist_watermark",
            rootSpan,
            { component: "database", ledger: newLedger },
            () => {
              db.setMetadata("lastLedger", newLedger);
              recordInteraction("db", "db.setWatermark", { ledger: newLedger });
            },
          );
        }
        indexerWatermarkLedger.set(newLedger);

        await verifyPendingEvents(rootSpan, signal);
        markHealthy("indexer");
        serviceLastRunTime.set({ service: "indexer" }, Date.now() / 1000);
        return newLedger;
      },
    );
  } finally {
    stopTimer();
    const fixture = capturing ? stopRecording() : null;
    if (fixture) persistReplayFixture(fixture);
  }
}

function handlePollError(error: Error): void {
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

  let lastLedger = db.getMetadata<number>("lastLedger") ?? 0;

  log("info", "indexer_started", {
    contracts: contracts.length,
    pollInterval: pollIntervalMs,
    startLedger: lastLedger,
  });

  const initialController = new AbortController();
  try {
    lastLedger = await runPollingCycle(
      rpcServer,
      contracts,
      lastLedger,
      initialController.signal,
    );
  } catch (error) {
    handlePollError(error instanceof Error ? error : new Error(String(error)));
  }

  activeScheduler = new WatermarkScheduler({
    intervalMs: pollIntervalMs,
    maxQueueDepth: MAX_VERIFICATION_BACKLOG,
    getQueueDepth: () => verificationBacklog,
    runCycle: async (signal) => {
      lastLedger = await runPollingCycle(
        rpcServer!,
        contracts,
        lastLedger,
        signal,
      );
      indexerCyclesTotal.inc({ result: "completed" });
    },
    onOverrun: (skippedPolls, reason) => {
      indexerOverrunSkips.inc(skippedPolls);
      if (reason === "queue_full") indexerShedPolls.inc(skippedPolls);
      log("warn", "indexer_poll_overrun", {
        skippedPolls,
        reason,
        backlog: verificationBacklog,
      });
    },
    onBackpressure: (stats) => {
      indexerBackpressureLevel.set(stats.backpressureLevel);
      indexerPollIntervalSeconds.set(stats.currentIntervalMs / 1000);
      log("warn", "indexer_backpressure_changed", {
        level: stats.backpressureLevel,
        intervalMs: stats.currentIntervalMs,
        skippedPolls: stats.skippedPolls,
        shedPolls: stats.shedPolls,
        backlog: verificationBacklog,
      });
    },
    onError: (error) => {
      indexerCyclesTotal.inc({ result: "failed" });
      handlePollError(error);
    },
  });
  indexerBackpressureLevel.set(0);
  indexerPollIntervalSeconds.set(pollIntervalMs / 1000);
  activeScheduler.start();
}

/**
 * Stop the indexer
 */
export function stopIndexer(): Promise<void> {
  isPolling = false;
  serviceRunning.set({ service: "indexer" }, 0);
  rpcServer = null;
  verificationBacklog = 0;

  const scheduler = activeScheduler;
  activeScheduler = null;

  // The returned promise settles only once the in-flight cycle has unwound and
  // the database is closed, so a caller that awaits it — shutdown, or a test —
  // is guaranteed no poll is still touching the connection (#323).
  const stopped = scheduler ? scheduler.stop() : Promise.resolve();

  return stopped
    .catch(() => undefined)
    .then(() => {
      if (!isPolling) db.closeDb();
      log("info", "indexer_stopped");
    });
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
 * Ingest an event through the backpressure queue
 */
export async function pushStreamEvent(eventInput: EventInput): Promise<boolean> {
  eventQueue.push(eventInput);
  indexerQueueDepth.set(eventQueue.length);

  // If queue exceeds high watermark, apply backpressure by awaiting drain
  if (eventQueue.length >= HIGH_WATERMARK) {
    log("warn", "indexer_backpressure_engaged", {
      queueLength: eventQueue.length,
      highWatermark: HIGH_WATERMARK,
    });
    await drainEventQueue();
  } else if (!isDrainingQueue) {
    void drainEventQueue();
  }

  return true;
}

/**
 * Drain queued stream events to persistent storage
 */
export async function drainEventQueue(): Promise<number> {
  if (isDrainingQueue || eventQueue.length === 0) return 0;
  isDrainingQueue = true;
  let processed = 0;

  try {
    while (eventQueue.length > 0) {
      const batch = eventQueue.splice(0, 50);
      for (const item of batch) {
        if (db.addEvent(item)) {
          processed++;
          indexerEventsProcessed.inc({ event_type: "stream_indexed" }, 1);
        }
      }
      indexerQueueDepth.set(eventQueue.length);
      if (eventQueue.length <= LOW_WATERMARK) {
        // Backpressure relieved
      }
    }
  } finally {
    isDrainingQueue = false;
  }
  return processed;
}

/**
 * Start indexer in streaming mode with automatic gap detection and backpressure
 */
export async function startStreamingIndexer(
  server: StellarSdk.rpc.Server,
  contracts: string[],
  pollIntervalMs = 2000,
): Promise<void> {
  isStreamingMode = true;
  indexerRpcStreamReconnectsTotal.inc();
  await startIndexer(server, contracts, pollIntervalMs);
}

/**
 * Get indexer status
 */
export function getIndexerStatus(): IndexerStatus {
  db.initDb();
  const status = db.getDbStatus();
  return {
    isRunning: isPolling,
    isStreaming: isStreamingMode,
    queueDepth: eventQueue.length,
    indexerLag,
    hasGap,
    catchUpMode,
    checkpoint: db.getMetadata<string>("indexerCheckpoint") ?? null,
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
