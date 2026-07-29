/**
 * ZKVote Backend - Main Entry Point
 *
 * TypeScript backend relayer for anonymous voting on Stellar/Soroban.
 * Provides vote submission, IPFS integration, event indexing, and DAO caching.
 * Supports backend process clustering for multi-core utilization.
 */

import cluster from "node:cluster";
import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";

import { buildOpenApiDocument } from "./openapi.js";

// Configuration and types
import { config, validateEnv, isValidContractId } from "./config.js";

// Cluster Service
import {
  startClusterMaster,
  initWorkerIpc,
  isLeaderWorker,
  onLeaderChange,
  registerWorkerShutdownHandler,
} from "./services/cluster.js";

// Services
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
  startMonitor as startPinMonitor,
  stopMonitor as stopPinMonitor,
} from "./services/ipfs-monitor.js";
import {
  server,
  relayerKeypair,
  getPendingSequenceLockOps,
  waitForSequenceLockIdle,
} from "./services/stellar.js";
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
  startAuthScheduler,
  stopAuthScheduler,
  ensureLegacyTokenMigrated,
} from "./services/authScheduler.js";
import { startMemoryMonitor, stopMemoryMonitor } from "./services/memory-monitor.js";
import { closeDb } from "./services/db.js";

// Middleware
import {
  csrfGuard,
  csrfTokenMiddleware,
  requestLogger,
  errorHandler,
  graduatedSlowDown,
  degradationContext,
  metricsMiddleware,
} from "./middleware/index.js";
import { metricsMiddleware } from "./middleware/metrics.js";

// Routes
import {
  healthRoutes,
  initHealthRoutes,
  votingRoutes,
  daoRoutes,
  ipfsRoutes,
  commentsRoutes,
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
  metricsRoutes,
  remediationRoutes,
  thresholdRoutes,
} from "./routes/index.js";
import metricsRoutes from "./routes/metrics.js";
import remediationRoutes from "./routes/remediation.js";
import { registerShutdownHandler } from "./routes/admin.js";

// ============================================
// ENVIRONMENT VALIDATION
// ============================================

validateEnv();

// ============================================
// EXPRESS APP SETUP
// ============================================

const app: Express = express();
app.set("trust proxy", 1);

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
const noStore = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

// Metrics middleware (before other middleware to capture all requests)
app.use(metricsMiddleware);

// Request-scoped degradation tracking (#204)
app.use(degradationContext);

// Security: CORS configuration
const corsOrigins = config.corsOrigins === "*" ? "*" : config.corsOrigins;
const corsOptions: cors.CorsOptions = {
  origin: corsOrigins,
  methods: ["GET", "POST"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Relayer-Auth",
    "X-Client-Id",
    "X-Master-Key",
  ],
  exposedHeaders: ["X-Token-Id", "X-Client-Id"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Relayer-Auth"],
  exposedHeaders: ["X-Service-Degraded", "X-Service-Status"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Relayer-Auth", "X-CSRF-Token"],
  maxAge: 86400, // 24 hours
};
app.use(cors(corsOptions));

// Security: Request body size limit
app.use(express.json({ limit: "100kb" }));

// Logging middleware
app.use(requestLogger);

// Graduated throttling (delays before a client is hard rate-limited)
app.use(graduatedSlowDown);

// CSRF token generation for safe methods (GET, HEAD, OPTIONS)
app.use(csrfTokenMiddleware);

// CSRF protection (applied globally for write methods)
app.use(csrfGuard);

// ============================================
// ROUTE INITIALIZATION
// ============================================

// Initialize routes that need dependencies
initHealthRoutes(server, relayerKeypair.publicKey());
initIndexerRoutes(triggerDaoMembershipSync);

// Mount route handlers (metrics first, before CSRF/auth middleware)
app.use(metricsRoutes);
app.use(healthRoutes);
app.use(remediationRoutes);
app.use(noStore, votingRoutes);
app.use(daoRoutes);
app.use(ipfsRoutes);
app.use(commentsRoutes);
app.use(indexerRoutes);
app.use(bridgeRoutes);
app.use(circuitRoutes);
app.use(authRoutes);
app.use(quadraticRoutes);
app.use("/api/v1/nova", novaRoutes);
app.use(noStore, adminRoutes);
app.use(noStore, thresholdRoutes);

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

    // Keep the startup banner on stdout for human-readable output
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
        "/events/:daoId",
        "/events/notify",
        "/indexer/status",
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
async function startBackgroundServices(): Promise<void> {
  if (backgroundServicesStarted) return;
  backgroundServicesStarted = true;

  log("info", "starting_background_services", { pid: process.pid, isLeader: isLeaderWorker() });

  // Initialize Pinata and IPFS redundancy layer
  if (config.ipfsEnabled && config.pinataJwt) {
    try {
      ipfsService.initPinata(config.pinataJwt, config.pinataGateway);
      log("info", "pinata_initialized");

      // Initialize pin manager (local backup + secondary pinning)
      try {
        initPinManager(config.ipfsBackupDir, config.web3StorageToken);
        log("info", "pin_manager_initialized", {
          backupDir: config.ipfsBackupDir,
          hasWeb3Storage: !!config.web3StorageToken,
        });

        // Start pin verification monitor
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
        await startIndexer(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          server as any,
          contractIds,
          config.indexerPollIntervalMs,
        );
        log("info", "indexer_enabled", { contracts: contractIds.length });
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
        server as any,
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
    console.log(
      "  GET  /daos?user=ADDRESS   - Get DAOs with membership info",
    );
    console.log("  GET  /dao/:daoId          - Get single DAO (cached)");
    console.log("  POST /daos/sync           - Trigger DAO sync (admin)");
    startDaoSync();

    // Start membership sync
    if (
      config.membershipSbtContractId &&
      isValidContractId(config.membershipSbtContractId)
    ) {
      startMembershipSync();
    }
  }

  // Start TTL renewal service (prevents contract data from expiring)
  startTTLRenewal();

    // Start TTL renewal service (prevents contract data from expiring)
    startTTLRenewal();

    // Initialize auth: migrate legacy token and start rotation scheduler
    ensureLegacyTokenMigrated();
    startAuthScheduler();
  // Start periodic memory monitoring
  startMemoryMonitor(() => {
    log("warn", "memory_threshold_exceeded_triggering_shutdown", { pid: process.pid });
    if (config.clusterEnabled && process.exit) {
      process.exit(1); // Master will restart worker automatically
    }
    // Start WAL resilience services (checkpointing, monitoring, backups)
    try {
      const database = getDb();
      const dbPath = database.name;
      performInitialCheckpoint(database);
      detectAndHandleWalIssue(database, dbPath);
      startWalCheckpointing(database);
      startWalMonitor(database, dbPath);
      startPeriodicBackups(database, dbPath);
    } catch (err) {
      log("warn", "wal_resilience_start_failed", { error: (err as Error).message });
    }

    // Start periodic memory monitoring; triggers a graceful restart if
    // usage crosses the critical threshold (see #191).
    startMemoryMonitor(() => {
      void gracefulShutdown("memory_threshold");
    });
  });
}

function stopBackgroundServices(): void {
  if (!backgroundServicesStarted) return;
  backgroundServicesStarted = false;

  log("info", "stopping_background_services", { pid: process.pid });

  stopIndexer();
  stopDaoSync();
  stopMembershipSync();
  stopTTLRenewal();
  stopPinMonitor();
  stopMemoryMonitor();
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

    const httpServer = app.listen(PORT, async () => {
      logger.info("server_started", {
        port: PORT,
        pid: process.pid,
        isCluster: config.clusterEnabled,
        isLeader: isLeaderWorker(),
        network: config.networkPassphrase,
        rpcUrl: config.rpcUrl,
        relayer: relayerKeypair.publicKey(),
      });

      console.log(`\nZKVote Relayer worker (${process.pid}) running on http://localhost:${PORT}`);

      if (config.clusterEnabled) {
        onLeaderChange(async (isLeader) => {
          if (isLeader) {
            log("info", "worker_elected_as_primary_starting_background_services", { pid: process.pid });
            await startBackgroundServices();
          } else {
            log("info", "worker_demoted_stopping_background_services", { pid: process.pid });
            stopBackgroundServices();
          }
        });

        if (isLeaderWorker()) {
          await startBackgroundServices();
        }
      } else {
        // Single process mode - start background services directly
        await startBackgroundServices();
      }
    });

    const DRAIN_TIMEOUT_MS = 25_000;
    let shuttingDown = false;

    function gracefulShutdown(reason: string): void {
      if (shuttingDown) return;
      shuttingDown = true;

      log("info", "shutdown_start", { reason, pid: process.pid });

      stopBackgroundServices();

      const forceExitTimer = setTimeout(() => {
        log("warn", "shutdown_forced", { reason, timeoutMs: DRAIN_TIMEOUT_MS, pid: process.pid });
        process.exit(1);
      }, DRAIN_TIMEOUT_MS);
      forceExitTimer.unref();

      httpServer.close((err) => {
        if (err) {
          log("error", "shutdown_close_error", { error: err.message, pid: process.pid });
        } else {
          log("info", "shutdown_complete", { reason, pid: process.pid });
        }
        clearTimeout(forceExitTimer);
        process.exit(0);
      });
    }

    registerWorkerShutdownHandler((reason) => gracefulShutdown(reason));

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  }
  // ============================================
  // GRACEFUL SHUTDOWN (zero-downtime deploys, see #190)
  // ============================================
  //
  // Stops accepting new connections and lets in-flight requests finish
  // (draining) before exiting, instead of killing the process immediately.
  // A vote submission holds a sequence lock across build+simulate+send+
  // confirm, which can outlive its HTTP response, so we also wait for the
  // sequence lock to go idle -- otherwise a proof could be accepted but
  // never submitted to the chain.
  //
  // Fly.io's [http_service.checks] fail the instance out of rotation before
  // SIGTERM is sent, so no new traffic should arrive during drain; this
  // still protects work already in flight. `kill_timeout` in fly.toml must
  // be >= SHUTDOWN_DRAIN_TIMEOUT_MS or the platform will SIGKILL before the
  // drain completes.
  const DRAIN_TIMEOUT_MS = config.shutdownDrainTimeoutMs;
  let shuttingDown = false;

  async function gracefulShutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log("info", "shutdown_start", { reason, drainTimeoutMs: DRAIN_TIMEOUT_MS });

    // Hard deadline: if drain overruns, exit non-zero so the platform knows
    // the shutdown was not clean. unref() so this timer can't keep us alive.
    const forceExitTimer = setTimeout(() => {
      log("warn", "shutdown_forced", {
        reason,
        timeoutMs: DRAIN_TIMEOUT_MS,
        pendingSequenceLockOps: getPendingSequenceLockOps(),
      });
      process.exit(1);
    }, DRAIN_TIMEOUT_MS);
    forceExitTimer.unref();

    // 1. Stop accepting new connections; existing sockets keep draining.
    const httpClosed = new Promise<void>((resolve) => {
      httpServer.close((err) => {
        if (err) {
          log("error", "shutdown_http_close_error", { error: err.message });
        } else {
          log("info", "shutdown_component_stopped", { component: "http_server" });
        }
        resolve();
      });
    });

    // 2. Stop background interval services. They don't need to finish a
    //    cycle, and stopping them releases timers/handles.
    stopIndexer();
    log("info", "shutdown_component_stopped", { component: "indexer" });
    stopDaoSync();
    log("info", "shutdown_component_stopped", { component: "dao_sync" });
    stopMembershipSync();
    log("info", "shutdown_component_stopped", { component: "membership_sync" });
    stopTTLRenewal();
    log("info", "shutdown_component_stopped", { component: "ttl_renewal" });
    stopPinMonitor();
    stopAuthScheduler();
    process.exit(0);
  });
    log("info", "shutdown_component_stopped", { component: "pin_monitor" });
    stopMemoryMonitor();
    stopWalResilience();
    log("info", "shutdown_component_stopped", { component: "memory_monitor" });

    // 3. Drain in-flight HTTP requests and any sequence-locked chain
    //    submissions. Both must settle before we close the DB and exit.
    await httpClosed;

    const pending = getPendingSequenceLockOps();
    if (pending > 0) {
      log("info", "shutdown_draining_sequence_lock", { pending });
    }
    const drained = await waitForSequenceLockIdle(DRAIN_TIMEOUT_MS);
    log(drained ? "info" : "warn", "shutdown_sequence_lock_drained", {
      drained,
      remaining: getPendingSequenceLockOps(),
    });

    // 4. Close the SQLite connection cleanly (checkpoints WAL, avoids
    //    corruption on restart).
    try {
      closeDb();
      log("info", "shutdown_component_stopped", { component: "database" });
    } catch (err) {
      log("error", "shutdown_db_close_error", {
        error: (err as Error).message,
      });
    }

    clearTimeout(forceExitTimer);
    log("info", "shutdown_complete", { reason, cleanDrain: drained });
    process.exit(drained ? 0 : 1);
  }

  // Wire the /admin/shutdown route to the shutdown routine.
  registerShutdownHandler(gracefulShutdown);

  process.on("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    log("info", "shutdown_signal");
    stopIndexer();
    stopDaoSync();
    stopMembershipSync();
    stopTTLRenewal();
    stopPinMonitor();
    stopAuthScheduler();
    process.exit(0);
    void gracefulShutdown("SIGINT");
  });
}

export { app };
