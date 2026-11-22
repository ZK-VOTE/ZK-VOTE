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

import { config } from "./config.js";
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
import { initHaltStatus } from "./services/haltStatus.js";
import { initAntiSpam } from "./services/anti-spam.js";
import { initTtlService } from "./services/ttl.js";
import { initSbtGuard } from "./services/sbt-guard.js";
import { initExclusionProof } from "./services/exclusion-proof.js";
import { initTtlChecker } from "./services/ttl-checker.js";
import { initSyncService } from "./services/sync.js";
import { initBridgeRelay } from "./services/bridge.js";
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
}

/**
 * Construct and wire every service. Must be called after `validateEnv()`.
 * This is the only place that reaches for the module singletons of the
 * foundational services (logger/stellar/db); consumer services get their
 * dependencies from here instead.
 */
export function buildAppServices(): AppServices {
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

  log("info", "composition_root_wired", {
    services: [
      "circuit-registry",
      "anti-spam",
      "ttl",
      "ttl-checker",
      "sbt-guard",
      "exclusion-proof",
      "sync",
      "bridge",
      "job-scheduler",
    ],
  });

  return { config, logger, stellar, scheduler: defaultJobScheduler };
}
