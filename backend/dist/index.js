/**
 * ZKVote Backend - Main Entry Point
 *
 * TypeScript backend relayer for anonymous voting on Stellar/Soroban.
 * Provides vote submission, IPFS integration, event indexing, and DAO caching.
 * Supports backend process clustering for multi-core utilization.
 */
import cluster from "node:cluster";
import express from "express";
import cors from "cors";
import helmet from "helmet";
// Configuration and types
import { config, validateEnv, isValidContractId } from "./config.js";
// Cluster Service
import { startClusterMaster, initWorkerIpc, isLeaderWorker, onLeaderChange, registerWorkerShutdownHandler, } from "./services/cluster.js";
// Services
import { log, logger } from "./services/logger.js";
import * as ipfsService from "./services/ipfs.js";
import { initPinManager } from "./services/ipfs-pin-manager.js";
import { getDb } from "./services/db.js";
import { startWalCheckpointing, stopWalResilience, startWalMonitor, startPeriodicBackups, performInitialCheckpoint, detectAndHandleWalIssue, } from "./services/walResilience.js";
import { startMonitor as startPinMonitor, stopMonitor as stopPinMonitor, } from "./services/ipfs-monitor.js";
import { server, relayerKeypair, getPendingSequenceLockOps, } from "./services/stellar.js";
import { startDaoSync, stopDaoSync, startMembershipSync, stopMembershipSync, triggerDaoMembershipSync, } from "./services/sync.js";
import { startIndexer, stopIndexer } from "./services/indexer.js";
import { startTTLRenewal, stopTTLRenewal } from "./services/ttl.js";
import { startSbtTransferWatch, stopSbtTransferWatch, } from "./services/sbt-guard.js";
import { startAuthScheduler, stopAuthScheduler, ensureLegacyTokenMigrated, } from "./services/authScheduler.js";
import { startMemoryMonitor, stopMemoryMonitor, } from "./services/memory-monitor.js";
// Middleware
import { csrfGuard, requestLogger, errorHandler, auditMiddleware } from "./middleware/index.js";
// Routes
import { healthRoutes, initHealthRoutes, votingRoutes, daoRoutes, ipfsRoutes, commentsRoutes, claimRoutes, indexerRoutes, initIndexerRoutes, bridgeRoutes, circuitRoutes, eventsRoutes, } from "./routes/index.js";
// ============================================
// ENVIRONMENT VALIDATION
// ============================================
validateEnv();
// ============================================
// EXPRESS APP SETUP
// ============================================
const app = express();
// Security: HTTP headers with CSP
// This is a pure JSON API (no HTML is served outside /api-docs), so the CSP
// defaults everything to 'none' and only opens the handful of directives
// still needed (e.g. the Swagger UI docs route explicitly relaxes CSP for
// itself further down). See #140.
app.use(helmet({
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
}));
// Restrict powerful browser features. Not part of helmet's own defaults
// (no bundled Permissions-Policy middleware as of helmet v8), so it's set
// directly. This is a JSON API with no UI, so every feature is denied.
app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    next();
});
// Prevent caching of sensitive, non-static API responses. Kept scoped to the
// routes that return per-user or per-vote data rather than applied globally,
// since some routes (e.g. /api-docs, /ipfs/image/:cid) are fine to cache.
// See #140 — per-route CSP exceptions for the IPFS image endpoint are left
// as follow-up (needs its own directive design, not a 2-3 line change).
const noStore = (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
};
// Metrics middleware (before other middleware to capture all requests)
app.use(metricsMiddleware);
// Request-scoped degradation tracking (#204)
app.use(degradationContext);
// Security: CORS configuration
const corsOrigins = config.corsOrigins === "*" ? "*" : config.corsOrigins;
const corsOptions = {
    origin: corsOrigins,
    methods: ["GET", "POST"],
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
    maxAge: 86400, // 24 hours
};
app.use(cors(corsOptions));
// Security: request body size limits are applied per-route (#69) via the
// `bodyLimit` middleware in each router, sized to that endpoint's actual
// payload instead of one global cap shared by every endpoint.
// Logging middleware
app.use(requestLogger);
// Audit middleware - must be after body parsing and requestLogger, before routes
// Audits every mutating route (POST/PUT/PATCH/DELETE) with PII redaction, append-only
app.use(auditMiddleware);
// CSRF protection (applied globally)
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
app.use(claimRoutes);
app.use(indexerRoutes);
app.use(bridgeRoutes);
app.use(circuitRoutes);
app.use(eventsRoutes);
// Global error handler (must be last)
app.use(errorHandler);
// ============================================
// BACKGROUND SERVICES MANAGEMENT
// ============================================
let backgroundServicesStarted = false;
/** Set when the worker/single-process HTTP server starts listening. */
let httpServer = null;
let shuttingDown = false;
/**
 * Drain in-flight work and exit cleanly (zero-downtime deploys, see #190).
 * A vote submission holds a sequence lock across build+simulate+send+confirm,
 * which can outlive its HTTP response — wait for that lock to go idle so a
 * proof is not accepted but never submitted on-chain.
 */
async function gracefulShutdown(reason) {
    if (shuttingDown)
        return;
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
            pendingSequenceLockOps: getPendingSequenceLockOps(),
            pid: process.pid,
        });
        process.exit(1);
    }, DRAIN_TIMEOUT_MS);
    forceExitTimer.unref();
    const httpClosed = new Promise((resolve) => {
        if (!httpServer) {
            resolve();
            return;
        }
        httpServer.close((err) => {
            if (err) {
                log("error", "shutdown_http_close_error", {
                    error: err.message,
                    pid: process.pid,
                });
            }
            else {
                log("info", "shutdown_component_stopped", { component: "http_server" });
            }
            resolve();
        });
    });
    stopBackgroundServices();
    stopAuthScheduler();
    stopWalResilience();
    log("info", "shutdown_component_stopped", {
        component: "background_services",
    });
    await httpClosed;
    clearTimeout(forceExitTimer);
    log("info", "shutdown_complete", {
        reason,
        pid: process.pid,
    });
    process.exit(0);
}
async function startBackgroundServices() {
    if (backgroundServicesStarted)
        return;
    backgroundServicesStarted = true;
    log("info", "starting_background_services", {
        pid: process.pid,
        isLeader: isLeaderWorker(),
    });
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
            }
            catch (err) {
                log("warn", "pin_manager_init_failed", {
                    error: err.message,
                });
            }
        }
        catch (err) {
            log("error", "pinata_init_failed", { error: err.message });
        }
    }
    // Start event indexer
    if (config.indexerEnabled) {
        const contractIds = [config.votingContractId, config.treeContractId];
        if (config.daoRegistryContractId &&
            isValidContractId(config.daoRegistryContractId)) {
            contractIds.push(config.daoRegistryContractId);
        }
        if (config.membershipSbtContractId &&
            isValidContractId(config.membershipSbtContractId)) {
            contractIds.push(config.membershipSbtContractId);
        }
        try {
            await startIndexer(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            server, contractIds, config.indexerPollIntervalMs);
            log("info", "indexer_enabled", { contracts: contractIds.length });
        }
        catch (err) {
            log("warn", "indexer_start_failed", { error: err.message });
        }
    }
    // Start DAO sync
    if (config.daoRegistryContractId &&
        isValidContractId(config.daoRegistryContractId)) {
        console.log("\nDAO Cache Endpoints:");
        console.log("  GET  /daos                - Get all DAOs (cached)");
        console.log("  GET  /daos?user=ADDRESS   - Get DAOs with membership info");
        console.log("  GET  /dao/:daoId          - Get single DAO (cached)");
        console.log("  POST /daos/sync           - Trigger DAO sync (admin)");
        startDaoSync();
        if (config.membershipSbtContractId &&
            isValidContractId(config.membershipSbtContractId)) {
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
    }
    catch (err) {
        log("warn", "wal_resilience_start_failed", {
            error: err.message,
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
function stopBackgroundServices() {
    if (!backgroundServicesStarted)
        return;
    backgroundServicesStarted = false;
    log("info", "stopping_background_services", { pid: process.pid });
    stopIndexer();
    stopDaoSync();
    stopMembershipSync();
    stopTTLRenewal();
    stopSbtTransferWatch();
    stopPinMonitor();
    stopMemoryMonitor();
}
// ============================================
// SERVER STARTUP & CLUSTER CONTROLLER
// ============================================
if (import.meta.url === `file://${process.argv[1]}`) {
    if (config.clusterEnabled && cluster.isPrimary) {
        startClusterMaster();
    }
    else {
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
                relayer: relayerKeypair.publicKey(),
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
                        log("info", "worker_elected_as_primary_starting_background_services", { pid: process.pid });
                        await startBackgroundServices();
                    }
                    else {
                        log("info", "worker_demoted_stopping_background_services", {
                            pid: process.pid,
                        });
                        stopBackgroundServices();
                    }
                });
                if (isLeaderWorker()) {
                    await startBackgroundServices();
                }
            }
            else {
                await startBackgroundServices();
            }
        });
        registerWorkerShutdownHandler((reason) => {
            void gracefulShutdown(reason);
        });
        registerShutdownHandler(gracefulShutdown);
        process.on("SIGTERM", () => {
            void gracefulShutdown("SIGTERM");
        });
        process.on("SIGINT", () => {
            void gracefulShutdown("SIGINT");
        });
    }
}
export { app };
//# sourceMappingURL=index.js.map