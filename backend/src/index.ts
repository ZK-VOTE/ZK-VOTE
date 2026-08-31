/**
 * ZKVote Backend - Main Entry Point
 *
 * TypeScript backend relayer for anonymous voting on Stellar/Soroban.
 * Provides vote submission, IPFS integration, event indexing, and DAO caching.
 * Supports backend process clustering for multi-core utilization.
 */

import cluster from "node:cluster";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";

import { config, validateEnv, isValidContractId } from "./config.js";
// Composition root (#358) — explicit construction/wiring of service deps.
import { buildAppServices } from "./composition-root.js";

import {
  startClusterMaster,
  initWorkerIpc,
  isLeaderWorker,
  onLeaderChange,
  registerWorkerShutdownHandler,
} from "./services/cluster.js";

import { log, logger } from "./services/logger.js";
import * as ipfsService from "./services/ipfs.js";
import { initPinManager } from "./services/ipfs-pin-manager.js";
import { getDb } from "./services/db.js";
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
import {
  startMonitor as startPinMonitor,
  stopMonitor as stopPinMonitor,
} from "./services/ipfs-monitor.js";
import {
  startDaoSync,
  stopDaoSync,
  startMembershipSync,
  stopMembershipSync,
  triggerDaoMembershipSync,
} from "./services/sync.js";
import { startIndexer, stopIndexer } from "./services/indexer.js";
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
  csrfGuard,
  requestLogger,
  errorHandler,
  auditMiddleware,
  metricsMiddleware,
  degradationContext,
} from "./middleware/index.js";

import {
  healthRoutes,
  initHealthRoutes,
  analyticsRoutes,
  votingRoutes,
  daoRoutes,
  ipfsRoutes,
  commentsRoutes,
  claimRoutes,
  indexerRoutes,
  initIndexerRoutes,
  bridgeRoutes,
  circuitRoutes,
  authRoutes,
  quadraticRoutes,
  metricsRoutes,
  remediationRoutes,
  novaRoutes,
  adminRoutes,
  thresholdRoutes,
  randomnessRoutes,
} from "./routes/index.js";

// ============================================
// ENVIRONMENT VALIDATION
// ============================================

validateEnv();
initializeTelemetry();

// ============================================
// COMPOSITION ROOT (#358)
// ============================================
// Build and wire every service's dependencies explicitly. Consumer services
// get their deps from this container, not from module-level globals.

const services = buildAppServices();

// ============================================
// EXPRESS APP SETUP
// ============================================

const app: Express = express();

// Security: HTTP headers with CSP
// This is a pure JSON API (no HTML is served outside /api-docs), so the CSP
// defaults everything to 'none' and only opens the handful of directives
// still needed (e.g. the Swagger UI docs route explicitly relaxes CSP for
// itself further down). See #140.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'none'"],
        styleSrc: ["'none'"],
        imgSrc: ["'none'"],
        connectSrc: ["'none'"],
        fontSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
        blockAllMixedContent: [],
        upgradeInsecureRequests: [],
      },
    },
    // Explicit HSTS (helmet enables this by default, but pin the values so
    // the policy is documented and doesn't silently change with a helmet
    // upgrade). Browsers ignore this header over plain HTTP.
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    // helmet.noSniff() (X-Content-Type-Options: nosniff) and
    // helmet.frameguard() (X-Frame-Options: DENY) are both on by default;
    // kept implicit here but verified via the header-presence test added
    // alongside this change.
  }),
);

// Restrict powerful browser features. Not part of helmet's own defaults
// (no bundled Permissions-Policy middleware as of helmet v8), so it's set
// directly. This is a JSON API with no UI, so every feature is denied.
app.use((_req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  next();
});

// Prevent caching of sensitive, non-static API responses. Kept scoped to the
// routes that return per-user or per-vote data rather than applied globally,
// since some routes (e.g. /api-docs, /ipfs/image/:cid) are fine to cache.
// See #140 — per-route CSP exceptions for the IPFS image endpoint are left
// as follow-up (needs its own directive design, not a 2-3 line change).
const noStore = (
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

// Metrics middleware (before other middleware to capture all requests)
app.use(metricsMiddleware);

// Request-scoped degradation tracking (#204)
app.use(degradationContext);

// Security: CORS configuration
function parseCorsOrigins(value: string): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const allowedCorsOrigins = parseCorsOrigins(config.corsOrigins);
const isProduction = process.env.NODE_ENV === "production";

if (allowedCorsOrigins.length === 0) {
  throw new Error("CORS_ORIGIN must specify at least one origin");
}

if (isProduction && allowedCorsOrigins.includes("*")) {
  throw new Error(
    "CORS_ORIGIN must not be '*' in production; configure exact origins",
  );
}

for (const origin of allowedCorsOrigins) {
  if (origin !== "*" && /[*?]/.test(origin)) {
    throw new Error(
      "CORS_ORIGIN origins must be exact URLs, not wildcard patterns",
    );
  }
}

const allowAllCors = !isProduction && allowedCorsOrigins.includes("*");

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowAllCors || allowedCorsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    log("warn", "cors_origin_rejected", {
      origin,
      allowedOrigins: allowedCorsOrigins,
    });
    callback(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Relayer-Auth",
    "X-Client-Id",
    "X-Master-Key",
    "X-CSRF-Token",
  ],
  exposedHeaders: [
    "X-Token-Id",
    "X-Client-Id",
    "X-Service-Degraded",
    "X-Service-Status",
  ],
  maxAge: 3600,
  credentials: !allowAllCors,
};
app.use(cors(corsOptions));

// Security: request body size limits are applied per-route (#69) via the
// `bodyLimit` middleware in each router, sized to that endpoint's actual
// payload instead of one global cap shared by every endpoint.

// Logging middleware
app.use(requestLogger);

// Graduated throttling (delays before a client is hard rate-limited)
app.use(graduatedSlowDown);

// CSRF token generation for safe methods (GET, HEAD, OPTIONS)
app.use(csrfTokenMiddleware);

// CSRF protection (applied globally for write methods)
app.use(csrfGuard);

// ============================================
// CSRF TOKEN ENDPOINT
// ============================================

// Dedicated endpoint for CSRF token issuance.
// The SPA calls GET /csrf-token on startup and stores the X-CSRF-Token
// response header value.  The csrfTokenMiddleware (applied globally above)
// handles the actual token generation for all GET requests; this route
// just provides a predictable, documented URL for the frontend to target.
app.get("/csrf-token", (_req, res) => {
  // Token is already set in the response header by csrfTokenMiddleware.
  res.json({ ok: true });
});

// ============================================
// ROUTE INITIALIZATION
// ============================================

// Initialize routes that need dependencies
initHealthRoutes(services.stellar.server, services.stellar.relayerKeypair.publicKey());
initIndexerRoutes(triggerDaoMembershipSync);

// Mount route handlers (metrics first, before CSRF/auth middleware)
app.use(metricsRoutes);
app.use(healthRoutes);
app.use(analyticsRoutes);
app.use(remediationRoutes);
app.use(adminRoutes);
app.use(noStore, votingRoutes);
app.use(daoRoutes);
app.use(ipfsRoutes);
app.use(commentsRoutes);
app.use(claimRoutes);
app.use(indexerRoutes);
app.use(bridgeRoutes);
app.use(circuitRoutes);
app.use(authRoutes);
app.use(quadraticRoutes);
app.use("/api/v1/nova", novaRoutes);
app.use(noStore, adminRoutes);
app.use(noStore, thresholdRoutes);
app.use(noStore, randomnessRoutes);

// ============================================
// API VERSIONING (#139)
// ============================================
// URL-based versioning: mount the same routers under /api/v1 in addition to
// the existing unversioned paths, so existing clients keep working while new
// clients can opt into the explicit, cache-friendly versioned path. A
// response header also advertises which version served the request.
//
// Deliberately out of scope for this pass (see PR body): deprecation/Sunset
// headers for the unversioned routes, a version-lifecycle policy doc, and
// updating the frontend to call /api/v1.
app.use((_req, res, next) => {
  res.setHeader("API-Version", "v1");
  next();
});

const v1Router = express.Router();
v1Router.use(metricsRoutes);
v1Router.use(healthRoutes);
v1Router.use(remediationRoutes);
v1Router.use(noStore, votingRoutes);
v1Router.use(daoRoutes);
v1Router.use(ipfsRoutes);
v1Router.use(commentsRoutes);
v1Router.use(indexerRoutes);
v1Router.use(bridgeRoutes);
v1Router.use(circuitRoutes);
v1Router.use(quadraticRoutes);
v1Router.use(noStore, adminRoutes);
v1Router.use(noStore, thresholdRoutes);
v1Router.use(noStore, randomnessRoutes);
app.use("/api/v1", v1Router);

// OpenAPI spec + interactive docs
const openApiDocument = buildOpenApiDocument();
app.get("/api-docs/openapi.json", (_req, res) => res.json(openApiDocument));
app.use(
  "/api-docs",
  // helmet's default CSP blocks the inline scripts/styles Swagger UI's
  // bundled assets need; relax it for this documentation-only route.
  (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    res.removeHeader("Content-Security-Policy");
    next();
  },
  swaggerUi.serve,
  swaggerUi.setup(openApiDocument),
);

// Global error handler (must be last)
app.use(errorHandler);

// ============================================
// BACKGROUND SERVICES MANAGEMENT
// ============================================

let backgroundServicesStarted = false;
/** Set when the worker/single-process HTTP server starts listening. */
let httpServer: ReturnType<Express["listen"]> | null = null;
let shuttingDown = false;

// Supervisor for background services with crash recovery (#176)
const supervisor = new ServiceSupervisor();

/**
 * Drain in-flight work and exit cleanly (zero-downtime deploys, see #190).
 * A vote submission holds a sequence lock across build+simulate+send+confirm,
 * which can outlive its HTTP response — wait for that lock to go idle so a
 * proof is not accepted but never submitted on-chain.
 */
async function gracefulShutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const DRAIN_TIMEOUT_MS = config.shutdownDrainTimeoutMs;
  log("info", "shutdown_start", {
    reason,
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
    pid: process.pid,
  });

  const forceExitTimer = setTimeout(() => {
    log("warn", "shutdown_forced", {
      reason,
      timeoutMs: DRAIN_TIMEOUT_MS,
      pendingSequenceLockOps: services.stellar.getPendingSequenceLockOps(),
      pid: process.pid,
    });
    process.exit(1);
  }, DRAIN_TIMEOUT_MS);
  forceExitTimer.unref();

  const httpClosed = new Promise<void>((resolve) => {
    if (!httpServer) {
      resolve();
      return;
    }
    httpServer.close((err: Error | undefined) => {
      if (err) {
        log("error", "shutdown_http_close_error", {
          error: err.message,
          pid: process.pid,
        });
      } else {
        log("info", "shutdown_component_stopped", { component: "http_server" });
      }
      resolve();
    });
  });

  await supervisor.stopAll();
  stopBackgroundServices();
  stopAuthScheduler();
  stopWalResilience();
  log("info", "shutdown_component_stopped", {
    component: "background_services",
  });

  await httpClosed;

  const drained = await waitForSequenceLockIdle(DRAIN_TIMEOUT_MS);

  clearTimeout(forceExitTimer);
  log("info", "shutdown_complete", {
    reason,
    pid: process.pid,
  });
  process.exit(0);
}

async function startBackgroundServices(): Promise<void> {
  if (backgroundServicesStarted) return;
  backgroundServicesStarted = true;

  log("info", "starting_background_services", {
    pid: process.pid,
    isLeader: isLeaderWorker(),
  });

  // Register background services with supervisor for crash recovery (#176)
  registerSupervisorServices();

  // Initialize Pinata and IPFS redundancy layer
  if (config.ipfsEnabled && config.pinataJwt) {
    try {
      ipfsService.initPinata(config.pinataJwt, config.pinataGateway);
      log("info", "pinata_initialized");

      try {
        initPinManager(config.ipfsBackupDir, config.web3StorageToken);
        log("info", "pin_manager_initialized", {
          backupDir: config.ipfsBackupDir,
          hasWeb3Storage: !!config.web3StorageToken,
        });

        startPinMonitor({
          scanIntervalMs: config.pinVerifyIntervalMs,
          alertThreshold: config.pinAlertThreshold,
          autoRepin: config.pinAutoRepin,
          repinFn: ipfsService.repinCallback,
        });
        log("info", "pin_monitor_started", {
          intervalMs: config.pinVerifyIntervalMs,
          alertThreshold: config.pinAlertThreshold,
          autoRepin: config.pinAutoRepin,
        });
      } catch (err) {
        log("warn", "pin_manager_init_failed", {
          error: (err as Error).message,
        });
      }
    } catch (err) {
      log("error", "pinata_init_failed", { error: (err as Error).message });
    }
  }

  // Start event indexer
  if (config.indexerEnabled) {
    const contractIds = [config.votingContractId!, config.treeContractId!];
    if (
      config.daoRegistryContractId &&
      isValidContractId(config.daoRegistryContractId)
    ) {
      contractIds.push(config.daoRegistryContractId);
    }
    if (
      config.membershipSbtContractId &&
      isValidContractId(config.membershipSbtContractId)
    ) {
      contractIds.push(config.membershipSbtContractId);
    }

    try {
      await startIndexer(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        services.stellar.server as any,
        contractIds,
        config.indexerPollIntervalMs,
      );
      log("info", "indexer_enabled", { contracts: contractIds.length });
    } catch (err) {
      log("warn", "indexer_start_failed", { error: (err as Error).message });
    }
  }

  // Start DAO sync
  if (
    config.daoRegistryContractId &&
    isValidContractId(config.daoRegistryContractId)
  ) {
    console.log("\nDAO Cache Endpoints:");
    console.log("  GET  /daos                - Get all DAOs (cached)");
    console.log("  GET  /daos?user=ADDRESS   - Get DAOs with membership info");
    console.log("  GET  /dao/:daoId          - Get single DAO (cached)");
    console.log("  POST /daos/sync           - Trigger DAO sync (admin)");
    startDaoSync();

    if (
      config.membershipSbtContractId &&
      isValidContractId(config.membershipSbtContractId)
    ) {
      startMembershipSync();
      startSbtTransferWatch();
    }
  }

  startTTLRenewal();

  ensureLegacyTokenMigrated();
  startAuthScheduler();

  try {
    const database = getDb();
    const dbPath = database.name;
    performInitialCheckpoint(database);
    detectAndHandleWalIssue(database, dbPath);
    startWalCheckpointing(database);
    startWalMonitor(database, dbPath);
    startPeriodicBackups(database, dbPath);
    // Encrypted snapshot backups (#359) — opt-in via BACKUP_ENCRYPTION_ENABLED.
    if (config.backupEncryptionEnabled) {
      startScheduledBackups(config.backupIntervalMs);
    }
  } catch (err) {
    log("warn", "wal_resilience_start_failed", {
      error: (err as Error).message,
    });
  }

  // Triggers a graceful restart if usage crosses the critical threshold (#191).
  startMemoryMonitor(() => {
    log("warn", "memory_threshold_exceeded_triggering_shutdown", {
      pid: process.pid,
    });
    void gracefulShutdown("memory_threshold");
  });
}

/**
 * Stop every background loop.
 *
 * Awaits the indexer specifically: its scheduler cancels an in-flight poll
 * cycle and closes the database only once that cycle has unwound (#323), so a
 * shutdown that did not await it could close the HTTP server while a poll was
 * still writing.
 */
async function stopBackgroundServices(): Promise<void> {
  if (!backgroundServicesStarted) return;
  backgroundServicesStarted = false;

  log("info", "stopping_background_services", { pid: process.pid });

  // Stop supervised services first
  void supervisor.stopAll();

  // Legacy stop calls (kept for services not yet fully migrated to supervisor)
  stopIndexer();
  stopDaoSync();
  stopMembershipSync();
  stopTTLRenewal();
  stopSbtTransferWatch();
  stopPinMonitor();
  stopMemoryMonitor();
  stopScheduledBackups();
}

/**
 * Register background services with the supervisor for crash recovery (#176).
 * The supervisor wraps each service with automatic restart on failure,
 * exponential backoff, and dependency-aware shutdown ordering.
 */
function registerSupervisorServices(): void {
  // TTL Renewal - most critical (contract storage expiry risk)
  supervisor.register({
    name: "ttl_renewal",
    start: () => startTTLRenewal(),
    stop: () => stopTTLRenewal(),
  });

  // SBT Transfer Watch
  supervisor.register({
    name: "sbt_transfer_watch",
    start: () => startSbtTransferWatch(),
    stop: () => stopSbtTransferWatch(),
  });

  // Indexer - critical for frontend data freshness
  supervisor.register({
    name: "indexer",
    start: async () => {
      if (!config.indexerEnabled) return;
      const contractIds = [config.votingContractId!, config.treeContractId!];
      if (
        config.daoRegistryContractId &&
        isValidContractId(config.daoRegistryContractId)
      ) {
        contractIds.push(config.daoRegistryContractId);
      }
      if (
        config.membershipSbtContractId &&
        isValidContractId(config.membershipSbtContractId)
      ) {
        contractIds.push(config.membershipSbtContractId);
      }
      await startIndexer(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server as any,
        contractIds,
        config.indexerPollIntervalMs,
      );
    },
    stop: () => stopIndexer(),
  });

  // DAO Sync
  supervisor.register({
    name: "dao_sync",
    start: () => {
      if (
        config.daoRegistryContractId &&
        isValidContractId(config.daoRegistryContractId)
      ) {
        startDaoSync();
      }
    },
    stop: () => stopDaoSync(),
  });

  // Membership Sync - depends on DAO Sync being active
  supervisor.register({
    name: "membership_sync",
    start: () => {
      if (
        config.membershipSbtContractId &&
        isValidContractId(config.membershipSbtContractId)
      ) {
        startMembershipSync();
      }
    },
    stop: () => stopMembershipSync(),
    dependencies: ["dao_sync"],
  });

  // Fire-and-forget: startAll resolves failures internally
  void supervisor.startAll();
}

// ============================================
// SERVER STARTUP & CLUSTER CONTROLLER
// ============================================

if (import.meta.url === `file://${process.argv[1]}`) {
  if (config.clusterEnabled && cluster.isPrimary) {
    startClusterMaster();
  } else {
    initWorkerIpc();
    const PORT = config.port;

    httpServer = app.listen(PORT, async () => {
      logger.info("server_started", {
        port: PORT,
        pid: process.pid,
        isCluster: config.clusterEnabled,
        isLeader: isLeaderWorker(),
        network: config.networkPassphrase,
        rpcUrl: config.rpcUrl,
        relayer: services.stellar.relayerKeypair.publicKey(),
      });

      console.log(`\nZKVote Relayer running on http://localhost:${PORT}`);

      logger.info("endpoints_registered", {
        core: [
          "/health",
          "/ready",
          "/config",
          "/vote",
          "/proposal/:dao/:prop",
          "/nullifier/:daoId/:proposalId/:nullifier",
          "/root/:dao",
          "/root-history/:daoId/:proposalId",
          "/events/:daoId",
          "/events/notify",
          "/indexer/status",
        ],
        claim: [
          "/api/v1/claim",
          "/api/v1/claim/status/:dao/:prop/:nullifier",
          "/api/v1/claim/treasury/:dao",
          "/claim",
        ],
        comments: [
          "/comment/anonymous",
          "/comments/:dao/:prop",
          "/comments/:dao/:prop/nonce",
          "/comment/:dao/:prop/:id",
          "/comment/edit",
          "/comment/delete",
        ],
        bridge: [
          "/bridge/vote",
          "/bridge/nullifier/:daoId/:proposalId/:nullifier",
          "/bridge/relay",
        ],
        ipfs: config.ipfsEnabled
          ? [
              "/ipfs/image",
              "/ipfs/metadata",
              "/ipfs/:cid",
              "/ipfs/image/:cid",
              "/ipfs/health",
            ]
          : [],
      });

      if (config.clusterEnabled) {
        onLeaderChange(async (isLeader) => {
          if (isLeader) {
            log(
              "info",
              "worker_elected_as_primary_starting_background_services",
              { pid: process.pid },
            );
            await startBackgroundServices();
          } else {
            log("info", "worker_demoted_stopping_background_services", {
              pid: process.pid,
            });
            await stopBackgroundServices();
          }
        });

        if (isLeaderWorker()) {
          await startBackgroundServices();
        }
      } else {
        await startBackgroundServices();
      }
    });

    registerWorkerShutdownHandler((reason) => {
      void gracefulShutdown(reason);
    });

    process.on("SIGTERM", () => {
      void gracefulShutdown("SIGTERM");
    });
    process.on("SIGINT", () => {
      void gracefulShutdown("SIGINT");
    });
  }
}

export { app };
