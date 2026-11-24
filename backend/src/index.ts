// @ts-nocheck
/**
 * ZKVote Backend - Main Entry Point
 *
 * TypeScript backend relayer for anonymous voting on Stellar/Soroban.
 * Provides vote submission, IPFS integration, event indexing, and DAO caching.
 * Supports backend process clustering for multi-core utilization.
 */

import cluster from "node:cluster";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import helmet from "helmet";

import {
  config,
  validateEnv,
  validateStartupConfig,
} from "./config.js";
// Composition root (#358) — explicit construction/wiring of service deps.
import {
  buildAppServices,
  setMemoryThresholdHandler,
} from "./composition-root.js";
// Startup phases and declarative routes (#358 follow-up).
import { createStartupPhases } from "./startup-phases.js";
import { mountRoutes } from "./routes/index.js";
import { initializeTelemetry } from "./services/tracing.js";
import swaggerUi from "swagger-ui-express";
import { ServiceSupervisor } from "./services/supervisor.js";
import { closeDb } from "./services/db.js";
import { buildOpenApiDocument } from "./openapi.js";
import { priorityMiddleware } from "./priority/priorityMiddleware.js";

import {
  startClusterMaster,
  initWorkerIpc,
  isLeaderWorker,
  onLeaderChange,
  registerWorkerShutdownHandler,
} from "./services/cluster.js";

import { log, logger } from "./services/logger.js";
import {
  getPendingSequenceLockOps,
  waitForSequenceLockIdle,
  stopCoverTraffic,
} from "./services/stellar.js";
import {
  startConfirmationWorker,
  stopConfirmationWorker,
} from "./services/confirmation-queue.js";
import {
  startEndpointHealthMonitor,
  stopEndpointHealthMonitor,
} from "./services/endpoint-pool.js";
import {
  attachConfirmationHub,
  closeConfirmationHub,
} from "./services/confirmation-hub.js";
import {
  startDaoSync,
  stopDaoSync,
  startMembershipSync,
  stopMembershipSync,
  triggerDaoMembershipSync,
} from "./services/sync.js";
import { startIndexer, stopIndexer } from "./services/indexer.js";
import { startNotificationWorker } from "./services/notifications/index.js";
import { startRelay, stopRelay } from "./services/bridge.js";
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

// Middleware
import {
  csrfGuard,
  csrfTokenMiddleware,
  requestLogger,
  errorHandler,
  auditMiddleware,
  graduatedSlowDown,
  degradationContext,
  metricsMiddleware,
  sharedRateLimiter,
} from "./middleware/index.js";

import {
  initHealthRoutes,
  initIndexerRoutes,
  bridgeRoutes,
  circuitRoutes,
  transactionRoutes,
  authRoutes,
  quadraticRoutes,
  metricsRoutes,
  remediationRoutes,
  novaRoutes,
  adminRoutes,
  thresholdRoutes,
  auditRoutes,
  randomnessRoutes,
  factoryRoutes,
  payRoutes,
  swapRoutes,
  rampRoutes,
  onboardingRoutes,
  notificationRoutes,
  proverRoutes,
  eventsRoutes,
} from "./routes/index.js";
import { registerShutdownHandler } from "./routes/admin.js";

/** Set once the notification worker starts; called on shutdown. */
let stopNotificationWorker: (() => void) | null = null;
import openApiSpec from "./openapi.js";

// ============================================
// STARTUP PHASES
// ============================================
// config -> infrastructure -> services -> routes -> workers -> ready
// A failed phase is terminal: no later phase may be entered.

const startupPhases = createStartupPhases();

await startupPhases.run("config", () => {
  validateEnv();
  // Fail-closed production validation (throwable counterpart of validateEnv).
  validateStartupConfig();
  initializeTelemetry();
});

// ============================================
// INFRASTRUCTURE PHASE — EXPRESS APP SETUP
// ============================================

// CORS origins must be parsed before helmet's CSP is configured; the
// frameAncestors directive depends on whether a wildcard origin is allowed.
function parseCorsOrigins(value: string | string[]): string[] {
  if (Array.isArray(value)) return value;
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const allowedCorsOrigins = parseCorsOrigins(
  config.corsOrigins as unknown as string | string[],
);
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

const app: Express = express();

const isProduction = process.env.NODE_ENV === "production";

// Security: CORS configuration
function parseCorsOrigins(value: string | string[]): string[] {
  if (Array.isArray(value)) return value;
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const allowedCorsOrigins = parseCorsOrigins(config.corsOrigins as unknown as string | string[]);

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
        frameAncestors: allowedCorsOrigins.includes("*") ? ["'none'"] : allowedCorsOrigins,
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

// CRITICAL (#661): Cross-origin isolation headers for timing-masking to be effective.
// Timing masking in proof generation only works when the page is crossOriginIsolated,
// which requires COOP + COEP headers from the server (dev/preview server has these
// in vite.config.ts, but production must send them too).
app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

// Per-route `Cache-Control: no-store` is applied by mountRoutes() in the
// declarative route registry (see routes/index.ts).

// Metrics middleware (before other middleware to capture all requests)
app.use(metricsMiddleware);

// Reserve per-tier capacity (vote, admin/dispute, payment, comment) before
// global throttling or any route mount (ZV-110). The classifier normalizes
// /, /api/v1, and /api/v2 so every public mount gets the same scheduling
// guarantee, and each tier has its own worker pool: a payment burst can
// fill the NORMAL pool but can never occupy an admin/dispute (HIGH) worker
// or a vote (CRITICAL) worker, regardless of arrival order.
app.use(priorityMiddleware());

// Request-scoped degradation tracking (#204)
app.use(degradationContext);

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
    // Wallet-session binding for /vote (#750)
    "X-Vote-Session",
    "X-Vote-Session-Mac",
    "X-Vote-Network",
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

// Shared, cross-replica bucket for privileged auth/admin key endpoints (#511).
// Keyed by signed membership token / client id with IP as a weak fallback.
const authBucketLimiter = sharedRateLimiter("auth");
app.use((req, res, next) => {
  if (/^\/(api\/v[12]\/)?(auth|admin|factory)(\/|$)/.test(req.path)) {
    return authBucketLimiter(req, res, next);
  }
  next();
});

// Audit middleware - must be after body parsing and requestLogger, before routes
// Audits every mutating route (POST/PUT/PATCH/DELETE) with PII redaction, append-only
app.use(auditMiddleware);

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

// Infrastructure setup above is complete.
startupPhases.checkpoint("infrastructure");

// ============================================
// SERVICES PHASE — COMPOSITION ROOT (#358)
// ============================================
// Build and wire every service's dependencies explicitly. Consumer services
// get their deps from this container, not from module-level globals.

// Initialize routes that need dependencies
initHealthRoutes(
  services.stellar.server,
  services.stellar.relayerKeypair.publicKey(),
);
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
app.use(transactionRoutes);
app.use(authRoutes);
app.use(quadraticRoutes);
app.use("/api/v1/nova", novaRoutes);
app.use(noStore, adminRoutes);
app.use(noStore, thresholdRoutes);
app.use(auditRoutes);
app.use(noStore, randomnessRoutes);
app.use(noStore, factoryRoutes);
app.use(payRoutes);
app.use(swapRoutes);
app.use(rampRoutes);
app.use(onboardingRoutes);
app.use(noStore, notificationRoutes);
app.use(proverRoutes);
app.use(eventsRoutes);

// ============================================
// ROUTES PHASE — DECLARATIVE REGISTRY
// ============================================

const v1Router = express.Router();

function mountV1(): void {
  v1Router.use(metricsRoutes);
  v1Router.use(healthRoutes);
  v1Router.use(analyticsRoutes);
  v1Router.use(remediationRoutes);
  v1Router.use(noStore, votingRoutes);
  v1Router.use(daoRoutes);
  v1Router.use(ipfsRoutes);
  v1Router.use(commentsRoutes);
  v1Router.use(claimRoutes);
  v1Router.use(indexerRoutes);
  v1Router.use(bridgeRoutes);
  v1Router.use(circuitRoutes);
  v1Router.use(transactionRoutes);
  v1Router.use(authRoutes);
  v1Router.use(quadraticRoutes);
  v1Router.use(noStore, adminRoutes);
  v1Router.use(noStore, thresholdRoutes);
  v1Router.use(auditRoutes);
  v1Router.use(noStore, randomnessRoutes);
  v1Router.use(noStore, factoryRoutes);
  v1Router.use(payRoutes);
  v1Router.use(swapRoutes);
  v1Router.use(rampRoutes);
  v1Router.use(onboardingRoutes);
  v1Router.use(noStore, notificationRoutes);
}

  // The registry validates required services before mounting anything.
  mountRoutes(app, services, services.profile, { variant: "unversioned" });

  // Response header advertising the default (unversioned) API version (#139).
  app.use((_req, res, next) => {
    res.setHeader("API-Version", "v1");
    next();
  });

function mountV2(): void {
  v2Router.use(metricsRoutes);
  v2Router.use(healthRoutes);
  v2Router.use(analyticsRoutes);
  v2Router.use(remediationRoutes);
  v2Router.use(noStore, votingRoutes);
  v2Router.use(daoRoutes);
  v2Router.use(ipfsRoutes);
  v2Router.use(commentsRoutes);
  v2Router.use(claimRoutes);
  v2Router.use(indexerRoutes);
  v2Router.use(bridgeRoutes);
  v2Router.use(circuitRoutes);
  v2Router.use(transactionRoutes);
  v2Router.use(authRoutes);
  v2Router.use(quadraticRoutes);
  v2Router.use(noStore, adminRoutes);
  v2Router.use(noStore, thresholdRoutes);
  v2Router.use(auditRoutes);
  v2Router.use(noStore, randomnessRoutes);
  v2Router.use(noStore, factoryRoutes);
  v2Router.use(payRoutes);
  v2Router.use(swapRoutes);
  v2Router.use(rampRoutes);
}

  // API v2 Router with explicit multi-tenant isolation (#307)
  const v2Router = express.Router();
  v2Router.use((_req, res, next) => {
    res.setHeader("API-Version", "v2");
    next();
  });
  mountRoutes(v2Router, services, services.profile, { variant: "v2" });
  app.use("/api/v2", v2Router);
});

// OpenAPI spec + interactive docs
const openApiDocument = buildOpenApiDocument();
app.get("/openapi.json", (_req, res) => res.json(openApiSpec));
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
  stopCoverTraffic();

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
  await stopBackgroundServices();
  closeConfirmationHub();
  log("info", "shutdown_component_stopped", {
    component: "background_services",
  });

  await httpClosed;

  // Drain in-flight sequence-locked chain submissions before closing the DB,
  // so a proof is never accepted but left unsubmitted.
  const pendingSequenceOps = getPendingSequenceLockOps();
  if (pendingSequenceOps > 0) {
    log("info", "shutdown_draining_sequence_lock", {
      pending: pendingSequenceOps,
      pid: process.pid,
    });
  }
  const drained = await waitForSequenceLockIdle(DRAIN_TIMEOUT_MS);
  log(drained ? "info" : "warn", "shutdown_sequence_lock_drained", {
    drained,
    remaining: getPendingSequenceLockOps(),
    pid: process.pid,
  });

  // Close the SQLite connection cleanly (checkpoints WAL, avoids corruption
  // on restart).
  try {
    closeDb();
    log("info", "shutdown_component_stopped", { component: "database" });
  } catch (err) {
    log("error", "shutdown_db_close_error", {
      error: (err as Error).message,
      pid: process.pid,
    });
  }

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
    profile: services.profile,
    workers: services.workers.list().length,
  });

  // Supervisor crash recovery (#176) wraps the same worker definitions that
  // the composition root declared. `createWorker` makes start/stop idempotent.
  void supervisor.startAll();

  // Cosmetic banner retained from the original DAO-sync startup path.
  if (services.enableRelayer && config.daoRegistryContractId) {
    console.log("\nDAO Cache Endpoints:");
    console.log("  GET  /daos                - Get all DAOs (cached)");
    console.log("  GET  /daos?user=ADDRESS   - Get DAOs with membership info");
    console.log("  GET  /dao/:daoId          - Get single DAO (cached)");
    console.log("  POST /daos/sync           - Trigger DAO sync (admin)");
  }

  startTTLRenewal();

  ensureLegacyTokenMigrated();
  startAuthScheduler();
  services.scheduler.start();
  // Drains the notification outbox (#886); independent of SSE connections.
  stopNotificationWorker = startNotificationWorker();
  // EVM → Soroban vote relay (#887); a no-op unless Bridge.sol is configured.
  if (!config.testMode) startRelay();

  try {
    await services.workers.startAll();
  } catch (err) {
    log("error", "background_services_start_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Triggers a graceful restart if usage crosses the critical threshold (#191).
  startMemoryMonitor(() => {
    log("warn", "memory_threshold_exceeded_triggering_shutdown", {
      pid: process.pid,
    });
    void gracefulShutdown("memory_threshold");
  });

  // Dedicated confirmation worker (#172): single poller for all outstanding
  // transaction-confirmation waits, with exponential backoff + jitter.
  startConfirmationWorker();

  // Probe Horizon, Soroban RPC and anchor pools on one cadence so routing,
  // finality-lag bounds and /health reflect live endpoint state (#745).
  if (!config.testMode) {
    startEndpointHealthMonitor(config.endpointHealthIntervalMs);
  }
  // Closes relayer drain windows on time even when no admin call polls (#746).
  relayerRotation.startTicker();
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
  log("info", "stopping_background_services", {
    pid: process.pid,
    started: backgroundServicesStarted,
  });
  backgroundServicesStarted = false;

  // Stop supervised services first, then drain every worker in reverse order
  // with a bounded timeout (WorkerRegistry handles both).
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
  services.scheduler.stop();
  stopAuthScheduler();
  stopNotificationWorker?.();
  stopRelay();
  stopEndpointHealthMonitor();

  // Drain any outstanding confirmation waits so callers never hang on exit.
  void stopConfirmationWorker();
  relayerRotation.stopTicker();
}

/**
 * Register background services with the supervisor for crash recovery (#176).
 * The supervisor wraps each service with automatic restart on failure,
 * exponential backoff, and dependency-aware shutdown ordering.
 */
function registerSupervisorServices(): void {
  // Supervisor service name -> composition-root worker name. The supervisor
  // delegates start/stop to the same idempotent worker instances that the
  // registry drains, so crash recovery and graceful shutdown cannot diverge.
  const supervised: ReadonlyArray<{
    service: Parameters<typeof supervisor.register>[0]["name"];
    worker: string;
    dependencies?: Parameters<typeof supervisor.register>[0]["dependencies"];
  }> = [
    { service: "ttl_renewal", worker: "ttl-renewal" },
    { service: "sbt_transfer_watch", worker: "sbt-transfer-watch" },
    { service: "indexer", worker: "indexer" },
    { service: "dao_sync", worker: "dao-sync" },
    {
      service: "membership_sync",
      worker: "membership-sync",
      dependencies: ["dao_sync"],
    },
  ];

  for (const entry of supervised) {
    const worker = services.workers.get(entry.worker);
    if (!worker) continue;
    supervisor.register({
      name: entry.service,
      start: () => worker.start(),
      stop: () => worker.stop(),
      enabled: worker.enabled,
      ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
    });
  }
}

// Workers are wired (not started) by the composition root during the services
// phase; registering them with the supervisor is the workers phase.
registerSupervisorServices();
startupPhases.checkpoint("workers");

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
      if (!startupPhases.isReady) startupPhases.checkpoint("ready");

      logger.info("server_started", {
        port: PORT,
        pid: process.pid,
        isCluster: config.clusterEnabled,
        isLeader: isLeaderWorker(),
        network: config.networkPassphrase,
        rpcUrl: config.rpcUrl,
        relayer: services.stellar.relayerKeypair.publicKey(),
        startupProfile: services.profile,
        startupDurationMs: startupPhases.report().totalDurationMs,
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
        threshold: [
          "/threshold/init",
          "/threshold/authority/register",
          "/threshold/dkg/finalize",
          "/threshold/vote/encrypt",
          "/threshold/tally/compute",
          "/threshold/decrypt/share",
          "/threshold/tally/decrypt",
          "/threshold/state/:daoId/:proposalId",
          "/threshold/status",
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

      // Attach the confirmation WebSocket hub (#172) so frontends receive
      // push notifications the moment a transaction confirms. `httpServer` is
      // assigned synchronously by app.listen() before this callback fires.
      attachConfirmationHub(httpServer!);
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

export {
  app,
  // Startup observability / independently testable lifecycle hooks. Existing
  // `app` export is preserved; everything else is additive.
  services,
  startupPhases,
  startBackgroundServices,
  stopBackgroundServices,
  gracefulShutdown,
};
