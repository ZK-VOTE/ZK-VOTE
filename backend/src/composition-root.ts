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
import { LedgerService } from "./services/ledger.js";
import { bootDualWrite } from "./services/dualWriteBoot.js";
import { initHaltStatus } from "./services/haltStatus.js";
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
import { createEvmRpc } from "./services/bridge-evm.js";
import { initOnboardingFunnel } from "./services/onboardingFunnel.js";
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
  /** Double-entry ledger. Uses the shared Kysely handle; previously unwired. */
  ledger: LedgerService;
}

/**
 * Construct and wire every service. Must be called after `validateEnv()`.
 * This is the only place that reaches for the module singletons of the
 * foundational services (logger/stellar/db); consumer services get their
 * dependencies from here instead.
 */
export function buildAppServices(): AppServices {
  // Attach the shadow writer once, at boot. Off by default; a missing URL or a
  // failed pool construction leaves the primary store untouched.
  void bootDualWrite();

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

  // Tiered emergency halt status (ZV-114 / #954): read-only, same DI
  // convention as circuit-registry above.
  initHaltStatus({
    server,
    relayerKeypair,
    callWithTimeout,
    votingContractId: config.votingContractId,
    networkPassphrase: config.networkPassphrase,
    logger,
  });

  // Wire the anti-spam service with explicit dependencies (#358): the write
  // DB handle, the Kysely query builder and the structured logger.
  initAntiSpam({ getDb: dbService.getWriteDb, kysely, logger });

  // Wire the onboarding funnel metrics service (ZV-108) with the shared
  // Kysely query builder.
  initOnboardingFunnel({ kysely });

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
    // EVM side of the relayer (#887): only when Bridge.sol is configured.
    evm:
      config.bridgeEvm.rpcUrl && config.bridgeEvm.contractAddress
        ? {
            rpc: createEvmRpc(config.bridgeEvm.rpcUrl),
            contractAddress: config.bridgeEvm.contractAddress,
            confirmations: config.bridgeEvm.confirmations,
            startBlock: config.bridgeEvm.startBlock,
            maxBlockRange: config.bridgeEvm.maxBlockRange,
            maxAttempts: config.bridgeEvm.relayMaxAttempts,
          }
        : undefined,
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

  // The ledger is Kysely-native; routing it through the shared handle makes
  // its writes use the same dialect as every other repository-backed path.
  const ledger = new LedgerService(kysely as unknown as ConstructorParameters<typeof LedgerService>[0]);

  return { config, logger, stellar, scheduler: defaultJobScheduler, ledger };
}
