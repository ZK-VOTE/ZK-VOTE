// @ts-nocheck
/**
 * Composition Root (#358)
 *
 * The single place that explicitly constructs and wires service dependencies
 * at startup. Refactored services receive their dependencies via `init*`
 * functions (or constructor arguments); they never import `stellar.js`'s or
 * `db.js`'s module-level singletons to get what they need.
 *
 * `buildAppServices()` is called once from `index.ts` after environment
 * validation; the returned container is passed to the app wiring.
 */

import {
  config,
  isValidContractId,
  resolveStartupProfile,
  type ResolvedStartupProfile,
  type StartupProfile,
  type StartupProfileInput,
} from "./config.js";
import { log, logger } from "./services/logger.js";
import {
  server,
  relayerKeypair,
  callWithTimeout,
  simulateWithBackoff,
  sequenceManager,
  waitForTransaction,
  withSequenceLock,
  waitForSequenceLockIdle,
  getPendingSequenceLockOps,
  u256ToScVal,
  proofToScVal,
} from "./services/stellar.js";
import type { StellarContext } from "./services/interfaces.js";
import { initCircuitRegistry } from "./services/circuit-registry.js";
import { initAntiSpam } from "./services/anti-spam.js";
import { initTtlService } from "./services/ttl.js";
import { initSbtGuard } from "./services/sbt-guard.js";
import { initExclusionProof } from "./services/exclusion-proof.js";
// Settlement / double-entry ledger (#516 follow-up): the composition root is
// the only place these singleton-style services get their stores wired.
import {
  initLedger,
  createInMemoryLedgerStore,
  createSqliteLedgerStore,
  type LedgerStore,
} from "./services/ledger.js";
import {
  initSettlementReconciliation,
  createInMemorySettlementStore,
  createSqliteSettlementStore,
  handleAnchorCallback,
  systemTimers,
  type SettlementStore,
} from "./services/settlementReconciliation.js";
import { initAnchor } from "./services/anchor.js";
import { initTtlChecker } from "./services/ttl-checker.js";
import { initSyncService } from "./services/sync.js";
import { initBridgeRelay } from "./services/bridge.js";
import * as indexer from "./services/indexer.js";
import { kysely } from "./services/kysely.js";
import * as dbService from "./services/db.js";
import {
  queryInstanceTTLWithFallback,
  queryPersistentTTLWithFallback,
  needsRenewal,
  isInGracePeriod,
  formatRemaining,
} from "./services/ttl-checker.js";
import { markDegraded, markHealthy } from "./services/service-health.js";
import { JobScheduler, defaultJobScheduler } from "./services/job-scheduler.js";
import {
  createWorker,
  WorkerRegistry,
  type BackgroundWorker,
} from "./services/worker.js";

// Background loops/timers are declared here (the composition root) so the
// entry point does not own service lifecycles. The service implementations
// themselves remain untouched.
import * as ipfsService from "./services/ipfs.js";
import { initPinManager } from "./services/ipfs-pin-manager.js";
import {
  startMonitor as startPinMonitor,
  stopMonitor as stopPinMonitor,
} from "./services/ipfs-monitor.js";
import {
  startConfirmationWorker,
  stopConfirmationWorker,
} from "./services/confirmation-queue.js";
import {
  startDaoSync,
  stopDaoSync,
  startMembershipSync,
  stopMembershipSync,
} from "./services/sync.js";
import { startTTLRenewal, stopTTLRenewal } from "./services/ttl.js";
import {
  startSbtTransferWatch,
  stopSbtTransferWatch,
} from "./services/sbt-guard.js";
import {
  startAuthScheduler,
  stopAuthScheduler,
  ensureLegacyTokenMigrated,
} from "./services/authScheduler.js";
import {
  startMemoryMonitor,
  stopMemoryMonitor,
} from "./services/memory-monitor.js";
import {
  startWalCheckpointing,
  stopWalResilience,
  startWalMonitor,
  startPeriodicBackups,
  performInitialCheckpoint,
  detectAndHandleWalIssue,
} from "./services/walResilience.js";
import {
  startScheduledBackups,
  stopScheduledBackups,
} from "./services/backup.js";

/** DI services whose `init*` functions the root has called. */
export const ROOT_INITIALIZED_SERVICES = [
  "circuit-registry",
  "anti-spam",
  "ttl",
  "ttl-checker",
  "sync",
  "bridge",
  "sbt-guard",
  "exclusion-proof",
  "job-scheduler",
  "ledger",
  "settlement-reconciliation",
  "anchor",
] as const;

export type InitializedServiceName =
  (typeof ROOT_INITIALIZED_SERVICES)[number];

/** The explicitly-wired service container. */
export interface AppServices {
  /** Immutable app configuration (validated before construction). */
  config: typeof config;
  /** Structured logger. */
  logger: typeof logger;
  /** The Stellar/Soroban surface, injected into consumer services. */
  stellar: StellarContext;
  /** Background job scheduler for maintenance and session cleanup. */
  scheduler: JobScheduler;
  /** Resolved startup profile (role flags). */
  startup: ResolvedStartupProfile;
  /** Alias for `startup.profile`, convenient for route/worker gating. */
  profile: StartupProfile;
  enableRelayer: boolean;
  enableIndexer: boolean;
  enableApi: boolean;
  /** Names of DI services initialized by this root instance. */
  initializedServices: readonly InitializedServiceName[];
  /** All background workers, wired but NOT started. */
  workers: WorkerRegistry;
}

/**
 * Construct and wire every service. Must be called after `validateEnv()`.
 * This is the only place that reaches for the module singletons of the
 * foundational services (logger/stellar/db); consumer services get their
 * dependencies from here instead.
 */
export function buildAppServices(
  profile?: StartupProfileInput | StartupProfile,
): AppServices {
  // Resolve the startup profile first so every downstream wiring decision
  // (routes, workers) can be tagged with the enabled roles.
  const startup = resolveStartupProfile(
    profile ?? {
      profile: config.startupProfile,
      enableRelayer: config.enableRelayer,
      enableIndexer: config.enableIndexer,
      enableApi: config.enableApi,
    },
  );

  const stellar: StellarContext = {
    server,
    relayerKeypair,
    callWithTimeout,
    simulateWithBackoff,
    waitForTransaction,
    withSequenceLock,
    waitForSequenceLockIdle,
    u256ToScVal,
    proofToScVal,
    getPendingSequenceLockOps,
  };

  // Wire refactored services with their explicit dependencies (#358).
  initCircuitRegistry({
    server,
    relayerKeypair,
    callWithTimeout,
    circuitRegistryContractId: config.circuitRegistryContractId,
    networkPassphrase: config.networkPassphrase,
    logger,
  });

  // Wire the anti-spam service with explicit dependencies (#358): the write
  // DB handle, the Kysely query builder and the structured logger.
  initAntiSpam({ getDb: dbService.getWriteDb, kysely, logger });

  // Wire the TTL renewal service with explicit dependencies (#358): the RPC
  // surface, config flags, contract IDs, persistence, TTL introspection,
  // health reporting and the logger.
  initTtlService({
    server,
    relayerKeypair,
    callWithTimeout,
    withSequenceLock,
    waitForTransaction,
    testMode: config.testMode,
    networkPassphrase: config.networkPassphrase,
    ttlMaxFee: config.ttlMaxFee,
    ttlCheckEnabled: config.ttlCheckEnabled,
    ttlCostTrackingEnabled: config.ttlCostTrackingEnabled,
    ttlBatchSize: config.ttlBatchSize,
    ttlRenewalIntervalMs: config.ttlRenewalIntervalMs,
    contractIds: {
      votingContractId: config.votingContractId,
      treeContractId: config.treeContractId,
      commentsContractId: config.commentsContractId,
      daoRegistryContractId: config.daoRegistryContractId,
      membershipSbtContractId: config.membershipSbtContractId,
    },
    db: {
      getAllCachedDaos: dbService.getAllCachedDaos,
      upsertTTLTracking: dbService.upsertTTLTracking,
      createTTLCostLog: dbService.createTTLCostLog,
      updateTTLCostLog: dbService.updateTTLCostLog,
    },
    checker: {
      queryInstanceTTLWithFallback,
      queryPersistentTTLWithFallback,
      needsRenewal,
      isInGracePeriod,
      formatRemaining,
    },
    health: { markHealthy, markDegraded },
    log: logger.log.bind(logger),
  });

  // Wire the TTL checker with explicit dependencies (#358).
  initTtlChecker({
    server,
    ttlGracePeriodMs: config.ttlGracePeriodMs,
    ttlRenewalThresholdMs: config.ttlRenewalThresholdMs,
    testMode: config.testMode,
    getTTLTracking: dbService.getTTLTracking,
    upsertTTLTracking: dbService.upsertTTLTracking,
    log: logger.log.bind(logger),
  });

  // Wire the cache-sync service with explicit dependencies (#358). Prometheus
  // metrics stay module-scoped by design (process-global counters, outside
  // the #358 singleton-import scope).
  initSyncService({
    server,
    relayerKeypair,
    callWithTimeout,
    simulateWithBackoff,
    sequenceManager,
    maxCachedDaos: config.maxCachedDaos,
    daoRegistryContractId: config.daoRegistryContractId,
    membershipSbtContractId: config.membershipSbtContractId,
    networkPassphrase: config.networkPassphrase,
    daoSyncIntervalMs: config.daoSyncIntervalMs,
    membershipSyncIntervalMs: config.membershipSyncIntervalMs,
    dbService: {
      getAllCachedDaos: dbService.getAllCachedDaos,
      upsertDaos: dbService.upsertDaos,
      setDaosSyncTime: dbService.setDaosSyncTime,
    },
    ensureDaoCreateEvent: indexer.ensureDaoCreateEvent,
    markHealthy,
    markDegraded,
    log: logger.log.bind(logger),
  });

  // Wire the bridge relay service with explicit dependencies (#358).
  initBridgeRelay({
    server,
    relayerKeypair,
    testMode: config.testMode,
    bridgeContractId: config.bridgeContractId,
    networkPassphrase: config.networkPassphrase,
    callWithTimeout,
    simulateWithBackoff,
    waitForTransaction,
    withSequenceLock,
    u256ToScVal,
    log: logger.log.bind(logger),
  });

  // Wire the SBT transfer-watch service with explicit dependencies (#358):
  // the RPC surface, config flags, event persistence, health and the logger.
  initSbtGuard({
    server,
    testMode: config.testMode,
    membershipSbtContractId: config.membershipSbtContractId,
    sbtTransferWatchIntervalMs: config.sbtTransferWatchIntervalMs,
    adminAlertWebhookUrl: config.adminAlertWebhookUrl,
    addEvent: dbService.addEvent,
    health: { markHealthy, markDegraded },
    log: logger.log.bind(logger),
  });

  // Wire the exclusion-proof service with explicit dependencies (#358).
  initExclusionProof({ getDb: dbService.getDb, log: logger.log.bind(logger) });

  // Wire the double-entry ledger and settlement reconciliation. Both prefer a
  // SQLite-backed store so evidence survives restarts; when no database is
  // available (unit tests, early bootstrap) we fall back to an in-memory store
  // rather than silently dropping postings.
  let ledgerStore: LedgerStore;
  let settlementStore: SettlementStore;
  try {
    const writeDb = dbService.getWriteDb();
    ledgerStore = createSqliteLedgerStore(writeDb);
    settlementStore = createSqliteSettlementStore(writeDb);
  } catch (error) {
    log("warn", "composition_root_ledger_memory_fallback", {
      error: (error as Error).message,
    });
    ledgerStore = createInMemoryLedgerStore();
    settlementStore = createInMemorySettlementStore();
  }
  initLedger({ store: ledgerStore, logger });
  initSettlementReconciliation({
    store: settlementStore,
    ledgerStore,
    logger,
    timers: systemTimers,
  });
  initAnchor({
    logger,
    onCallback: (event) => handleAnchorCallback(event),
  });

  const services: AppServices = {
    config,
    logger,
    stellar,
    scheduler: defaultJobScheduler,
    startup,
    profile: startup.profile,
    enableRelayer: startup.enableRelayer,
    enableIndexer: startup.enableIndexer,
    enableApi: startup.enableApi,
    initializedServices: ROOT_INITIALIZED_SERVICES,
    // Assigned immediately below; the worker definitions close over `services`
    // lazily so this two-step construction is safe.
    workers: null as unknown as WorkerRegistry,
  };
  services.workers = buildWorkerRegistry(services);

  log("info", "composition_root_wired", {
    services: ROOT_INITIALIZED_SERVICES,
    profile: startup.profile,
    enabled: {
      relayer: startup.enableRelayer,
      indexer: startup.enableIndexer,
      api: startup.enableApi,
    },
    workers: services.workers.list().map((worker: BackgroundWorker) => worker.name),
  });

  return services;
}

/**
 * Optional callback used by the memory-monitor worker. The composition root
 * defaults to a no-op; `index.ts` injects `gracefulShutdown` into it to avoid a
 * circular import between the entry point and the composition root.
 */
let onMemoryThreshold: () => void = () => undefined;

export function setMemoryThresholdHandler(handler: () => void): void {
  onMemoryThreshold = handler;
}

/**
 * Declare every background loop/timer as a worker. Nothing is started here —
 * the entry point starts the registry (or a subset, per profile) in its
 * `workers` startup phase. Extracting these from `index.ts` keeps their exact
 * start/stop behavior while making them individually testable.
 */
export function buildWorkerRegistry(services: AppServices): WorkerRegistry {
  const registry = new WorkerRegistry({
    drainTimeoutMs: config.shutdownDrainTimeoutMs,
    onEvent: (event) => {
      if (event.type === "error" || event.type === "timeout") {
        log("warn", "worker_registry_event", {
          type: event.type,
          worker: event.worker,
          error: event.error instanceof Error ? event.error.message : event.error,
        });
      }
    },
  });

  const hasContractId = (id: string | undefined): boolean =>
    !!id && isValidContractId(id);
  const contractIdsForIndexer = (): string[] => {
    const ids = [config.votingContractId!, config.treeContractId!];
    if (hasContractId(config.daoRegistryContractId))
      ids.push(config.daoRegistryContractId!);
    if (hasContractId(config.membershipSbtContractId))
      ids.push(config.membershipSbtContractId!);
    return ids;
  };

  const pinMonitorEnabled =
    services.enableApi && config.ipfsEnabled && !!config.pinataJwt;
  const indexerWorkerEnabled = services.enableIndexer && config.indexerEnabled;
  const daoRegistryEnabled = hasContractId(config.daoRegistryContractId);
  const membershipEnabled = hasContractId(config.membershipSbtContractId);

  registry.registerAll([
    createWorker({
      name: "ipfs-pin-monitor",
      enabled: pinMonitorEnabled,
      start: () => {
        ipfsService.initPinata(config.pinataJwt!, config.pinataGateway);
        initPinManager(config.ipfsBackupDir, config.web3StorageToken);
        startPinMonitor({
          scanIntervalMs: config.pinVerifyIntervalMs,
          alertThreshold: config.pinAlertThreshold,
          autoRepin: config.pinAutoRepin,
          repinFn: ipfsService.repinCallback,
        });
      },
      stop: () => stopPinMonitor(),
    }),
    createWorker({
      name: "indexer",
      enabled: indexerWorkerEnabled,
      start: async () => {
        await indexer.startIndexer(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          services.stellar.server as any,
          contractIdsForIndexer(),
          config.indexerPollIntervalMs,
        );
      },
      stop: () => indexer.stopIndexer(),
    }),
    createWorker({
      name: "dao-sync",
      enabled: services.enableRelayer && daoRegistryEnabled,
      start: () => startDaoSync(),
      stop: () => stopDaoSync(),
    }),
    createWorker({
      name: "membership-sync",
      enabled: services.enableRelayer && membershipEnabled,
      start: () => startMembershipSync(),
      stop: () => stopMembershipSync(),
    }),
    createWorker({
      name: "sbt-transfer-watch",
      enabled: services.enableRelayer && membershipEnabled,
      start: () => startSbtTransferWatch(),
      stop: () => stopSbtTransferWatch(),
    }),
    createWorker({
      name: "ttl-renewal",
      enabled: services.enableRelayer,
      start: () => startTTLRenewal(),
      stop: () => stopTTLRenewal(),
    }),
    createWorker({
      name: "auth-scheduler",
      enabled: services.enableApi,
      start: () => {
        ensureLegacyTokenMigrated();
        startAuthScheduler();
      },
      stop: () => stopAuthScheduler(),
    }),
    createWorker({
      name: "job-scheduler",
      enabled: services.enableRelayer,
      start: () => services.scheduler.start(),
      stop: () => services.scheduler.stop(),
    }),
    createWorker({
      name: "wal-resilience",
      enabled: services.enableApi,
      start: () => {
        const database = dbService.getDb();
        const dbPath = database.name;
        performInitialCheckpoint(database);
        detectAndHandleWalIssue(database, dbPath);
        startWalCheckpointing(database);
        startWalMonitor(database, dbPath);
        startPeriodicBackups(database, dbPath);
        if (config.backupEncryptionEnabled) {
          startScheduledBackups(config.backupIntervalMs);
        }
      },
      stop: () => {
        stopWalResilience();
        stopScheduledBackups();
      },
    }),
    createWorker({
      name: "memory-monitor",
      enabled: services.enableRelayer,
      start: () => {
        startMemoryMonitor(() => {
          log("warn", "memory_threshold_exceeded_triggering_shutdown", {
            pid: process.pid,
          });
          // The entry point injects the shutdown callback (see index.ts) so
          // this worker keeps the original behavior without importing it.
          onMemoryThreshold();
        });
      },
      stop: () => stopMemoryMonitor(),
    }),
    createWorker({
      name: "confirmation-worker",
      enabled: services.enableApi,
      start: () => startConfirmationWorker(),
      stop: () => stopConfirmationWorker(),
      health: () => ({ queue: "confirmation" }),
    }),
  ]);

  return registry;
}
