/**
 * Health Check Routes
 *
 * Provides health, readiness, and configuration endpoints.
 */

import { Router, Request, Response } from "express";
import type * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { extractAuthToken } from "../middleware/auth.js";
import { getRateLimitMetrics } from "../middleware/rateLimit.js";
import { bodyLimit } from "../middleware/index.js";
import { getMembershipVerificationMetrics } from "../services/sync.js";
import { log } from "../services/logger.js";
import {
  getDbDiagnostics,
  getDbStatus,
  getDb,
  getCachedDaoCount,
} from "../services/db.js";
import { getBackupStatus } from "../services/backup.js";
import { getWalHealth } from "../services/walResilience.js";

import { rpcPoolManager } from "../services/stellar.js";
import { getAllCircuitBreakerMetrics } from "../services/circuit-breaker.js";
import { getMemorySnapshot } from "../services/memory-monitor.js";
import {
  getOverallHealth,
  markDegraded,
  markHealthy,
  markUnavailable,
} from "../services/service-health.js";
import v8 from "node:v8";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const router = Router();
const PUBLIC_STATS_CACHE_TTL_MS = 60_000;

let publicStatsCache: { expiresAt: number; stats: Record<string, number | string> } | null = null;

function getPublicProtocolStats(): Record<string, number | string> {
  const now = Date.now();
  if (!publicStatsCache || now >= publicStatsCache.expiresAt) {
    let totalEvents = 0;
    let lastLedger = 0;

    try {
      const dbStatus = getDbStatus();
      totalEvents = Number(dbStatus.totalEvents ?? 0);
      lastLedger = Number(dbStatus.lastLedger ?? 0);
    } catch {
      // Database may not be initialized yet in early startup or test bootstrap.
    }

    publicStatsCache = {
      expiresAt: now + PUBLIC_STATS_CACHE_TTL_MS,
      stats: {
        totalDaos: getCachedDaoCount(),
        totalEvents,
        lastLedger,
        lastUpdated: new Date().toISOString(),
      },
    };
  }

  return publicStatsCache.stats;
}

// Dependencies injected during setup
let server: StellarSdk.rpc.Server | null = null;
let relayerPublicKey: string = "";

/**
 * Initialize health routes with dependencies
 */
export function initHealthRoutes(
  rpcServer:
    | StellarSdk.rpc.Server
    | { getHealth: () => Promise<{ status: string }> },
  relayerPubKey: string,
): void {
  server = rpcServer as StellarSdk.rpc.Server;
  relayerPublicKey = relayerPubKey;
}

/**
 * Check RPC health status
 */
async function rpcHealth(): Promise<{
  ok: boolean;
  info?: unknown;
  error?: string;
}> {
  if (!server) {
    return { ok: false, error: "RPC server not initialized" };
  }

  try {
    const info = await server.getHealth();
    // Soroban SDK returns 'healthy', but we check for both to be safe
    const status = info?.status as string;
    return { ok: status === "healthy" || status === "online", info };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * GET /healthz
 * Kubernetes liveness probe (process is alive)
 * Returns 200 if process is running, 503 if critically degraded
 */
router.get("/healthz", async (req: Request, res: Response) => {
  const memory = getMemorySnapshot();
  const services = getOverallHealth();

  const rpc = config.healthcheckPing ? await rpcHealth() : { ok: true };
  if (rpc.ok) {
    markHealthy("soroban_rpc");
  } else {
    markUnavailable("soroban_rpc", rpc.error ?? "RPC unhealthy");
  }

  const httpStatus = services.status === "ok" ? 200 : 503;

  const response: Record<string, unknown> = {
    status: services.status,
    timestamp: new Date().toISOString(),
  };

  if (config.healthExposeDetails) {
    const token = extractAuthToken(req);
    if (token === config.relayerAuthToken) {
      response.services = services;
      response.memory = {
        rssMb: Math.round(memory.rss / 1024 / 1024),
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      };
    }
  }

  return res.status(httpStatus).json(response);
});

/**
 * GET /health
 * Basic health check
 */
router.get("/public-stats", async (_req: Request, res: Response) => {
  try {
    const data = getPublicProtocolStats();
    return res.json({
      status: "ok",
      data,
      cached: true,
    });
  } catch (err) {
    return res.status(500).json({
      status: "error",
      message: (err as Error).message,
    });
  }
});

router.get("/health", async (req: Request, res: Response) => {
  const rpc = config.healthcheckPing ? await rpcHealth() : { ok: true };
  if (rpc.ok) {
    markHealthy("soroban_rpc");
  } else {
    markUnavailable("soroban_rpc", rpc.error ?? "RPC unhealthy");
  }

  const memory = getMemorySnapshot();
  const services = getOverallHealth();

  // Overall status is degraded when any tracked service is degraded/unavailable,
  // even if the process itself is up (graceful degradation #204).
  const base: Record<string, unknown> = {
    status: services.status,
    rpc: {
      ...rpc,
      pool: rpcPoolManager.getMetrics(),
    },
    circuitBreakers: getAllCircuitBreakerMetrics(),
    services,
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      limitMb: memory.limitMb,
      usageRatio: Math.round(memory.usageRatio * 1000) / 1000,
    },
  };

  // Only expose details if auth token provided
  if (config.healthExposeDetails) {
    const token = extractAuthToken(req);
    if (token === config.relayerAuthToken) {
      base.relayer = relayerPublicKey;
      base.votingContract = config.votingContractId;
      base.treeContract = config.treeContractId;
      base.vkVersion = config.staticVkVersion;
      base.rateLimits = getRateLimitMetrics();
      base.membershipVerification = getMembershipVerificationMetrics();
    }
  }

  // Always include basic DB status (no auth needed for aggregate stats)
  try {
    base.db = getDbStatus();
    base.backup = getBackupStatus();
    markHealthy("sqlite");
  } catch (err) {
    base.db = { error: (err as Error).message };
    markDegraded("sqlite", (err as Error).message);
  }

  res.json(base);
});

/**
 * GET /readyz
 * Kubernetes readiness probe (verifies RPC and DB connectivity)
 * Returns 200 if ready to accept traffic, 503 if degraded
 */
router.get("/readyz", async (req: Request, res: Response) => {
  try {
    const rpcStatus = await rpcHealth();
    let dbHealth: Record<string, unknown> = { available: false };

    try {
      const database = getDb();
      dbHealth = {
        ...getWalHealth(database, ""),
        status: getDbStatus(),
      };
    } catch (dbErr) {
      dbHealth = { available: false, error: (dbErr as Error).message };
    }

    const isRpcOk = rpcStatus.ok;
    const isDbOk = dbHealth.available !== false;

    const overallStatus = isRpcOk && isDbOk ? "ready" : "not_ready";
    const httpStatus = isRpcOk && isDbOk ? 200 : 503;

    const base: Record<string, unknown> = {
      status: overallStatus,
      dependencies: {
        rpc: isRpcOk ? "ok" : "unavailable",
        db: isDbOk ? "ok" : "unavailable",
      },
    };

    if (config.healthExposeDetails) {
      const token = extractAuthToken(req);
      if (token === config.relayerAuthToken) {
        base.details = {
          rpc: rpcStatus,
          db: dbHealth,
        };
      }
    }

    return res.status(httpStatus).json(base);
  } catch (err) {
    log("error", "readyz_check_failed", { error: (err as Error).message });
    return res
      .status(503)
      .json({ status: "error", message: (err as Error).message });
  }
});

/**
 * GET /ready
 * Readiness check (verifies RPC connectivity)
 */
router.get("/ready", async (req: Request, res: Response) => {
  try {
    const rpcStatus = await rpcHealth();
    let dbHealth: Record<string, unknown> = { available: false };

    try {
      const database = getDb();
      dbHealth = {
        ...getWalHealth(database, ""),
        status: getDbStatus(),
      };
    } catch (dbErr) {
      dbHealth = { available: false, error: (dbErr as Error).message };
    }

    const isRpcOk = rpcStatus.ok;
    const isDbOk = dbHealth.available !== false;

    const overallStatus = isRpcOk && isDbOk ? "ready" : "degraded";
    const httpStatus = isRpcOk && isDbOk ? 200 : 503;

    const base: Record<string, unknown> = {
      status: overallStatus,
      rpc: rpcStatus,
      db: dbHealth,
    };

    if (config.healthExposeDetails) {
      const token = extractAuthToken(req);
      if (token === config.relayerAuthToken) {
        base.relayer = relayerPublicKey;
        base.votingContract = config.votingContractId;
        base.treeContract = config.treeContractId;
        base.vkVersion = config.staticVkVersion;
      }
    }

    return res.status(httpStatus).json(base);
  } catch (err) {
    log("error", "ready_check_failed", { error: (err as Error).message });
    return res
      .status(503)
      .json({ status: "error", message: (err as Error).message });
  }
});

/**
 * GET /config
 * Returns public configuration (for frontend)
 */
router.get("/config", (_req: Request, res: Response) => {
  res.json({
    votingContract: config.votingContractId,
    treeContract: config.treeContractId,
    commentsContract: config.commentsContractId,
    daoRegistryContract: config.daoRegistryContractId,
    membershipSbtContract: config.membershipSbtContractId,
    networkPassphrase: config.networkPassphrase,
    rpcUrl: config.rpcUrl,
    ipfsEnabled: config.ipfsEnabled,
    pinataGateway: config.pinataGateway,
  });
});

/**
 * GET /db/stats
 * Database diagnostics endpoint (admin only)
 */
router.get("/db/stats", async (req: Request, res: Response) => {
  // Require auth token for detailed diagnostics
  if (config.healthExposeDetails) {
    const token = extractAuthToken(req);
    if (token !== config.relayerAuthToken) {
      // Return basic stats without diagnostics
      try {
        const dbStatus = getDbStatus();
        return res.json({ status: "unauthorized", db: dbStatus });
      } catch (err) {
        return res.status(500).json({ error: (err as Error).message });
      }
    }
  }

  try {
    const diagnostics = getDbDiagnostics();
    res.json(diagnostics);
  } catch (err) {
    log("error", "db_stats_failed", { error: (err as Error).message });
    res.status(500).json({ error: "Failed to get database statistics" });
  }
});

/**
 * POST /csp-report
 * Content Security Policy violation reporting endpoint
 * Receives CSP violation reports from browsers and logs them for monitoring
 */
router.post(
  "/csp-report",
  bodyLimit("100kb"),
  (req: Request, res: Response) => {
    try {
      const report = req.body;
      log("warn", "csp_violation", {
        "csp-report": report["csp-report"] || report,
        userAgent: req.get("user-agent"),
        ip: req.ip,
      });
      res.status(204).send();
    } catch (err) {
      log("error", "csp_report_failed", { error: (err as Error).message });
      res.status(400).json({ error: "Invalid CSP report" });
    }
  },
);

/**
 * GET /debug/heap
 * Writes a V8 heap snapshot and returns it for download (admin only).
 * Used to diagnose memory leaks in the long-running relayer process.
 */
router.get("/debug/heap", async (req: Request, res: Response) => {
  const token = extractAuthToken(req);
  if (!config.relayerAuthToken || token !== config.relayerAuthToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const snapshotPath = path.join(
    os.tmpdir(),
    `zkvote-heap-${Date.now()}.heapsnapshot`,
  );

  try {
    log("info", "heap_snapshot_requested", { path: snapshotPath });
    v8.writeHeapSnapshot(snapshotPath);

    res.download(snapshotPath, path.basename(snapshotPath), (err) => {
      fs.unlink(snapshotPath, () => {});
      if (err) {
        log("error", "heap_snapshot_send_failed", { error: err.message });
      }
    });
  } catch (err) {
    log("error", "heap_snapshot_failed", { error: (err as Error).message });
    fs.unlink(snapshotPath, () => {});
    res.status(500).json({ error: "Failed to generate heap snapshot" });
  }
});

/**
 * GET /relay-test
 * Relay self-test / smoke endpoint
 * Tests core relay functionality: RPC connectivity, account status, and contract IDs
 * Issue #387
 */
router.get("/relay-test", async (req: Request, res: Response) => {
  const startTime = Date.now();
  const results: {
    timestamp: string;
    tests: Record<string, unknown>;
    summary?: unknown;
    [key: string]: unknown;
  } = {
    timestamp: new Date().toISOString(),
    tests: {},
  };

  try {
    // Test 1: RPC Health Check
    const rpcTest = await rpcHealth();
    results.tests = {
      ...(results.tests as Record<string, unknown>),
      rpc_health: {
        passed: rpcTest.ok,
        message: rpcTest.ok ? "RPC is healthy" : rpcTest.error,
        info: rpcTest.info,
      },
    };

    // Test 2: Relayer Account Status
    if (server && relayerPublicKey) {
      try {
        const account = await server.getAccount(relayerPublicKey);
        results.tests = {
          ...(results.tests as Record<string, unknown>),
          relayer_account: {
            passed: true,
            publicKey: relayerPublicKey,
            sequence: account.sequenceNumber(),
            message: "Relayer account exists and is accessible",
          },
        };
      } catch (err) {
        results.tests = {
          ...(results.tests as Record<string, unknown>),
          relayer_account: {
            passed: false,
            publicKey: relayerPublicKey,
            error: (err as Error).message,
            message: "Failed to fetch relayer account",
          },
        };
      }
    } else {
      results.tests = {
        ...(results.tests as Record<string, unknown>),
        relayer_account: {
          passed: false,
          message: "Relayer not initialized",
        },
      };
    }

    // Test 3: Contract IDs Validation
    const contractsValid =
      config.votingContractId?.length === 56 &&
      config.treeContractId?.length === 56;
    results.tests = {
      ...(results.tests as Record<string, unknown>),
      contract_ids: {
        passed: contractsValid,
        voting: config.votingContractId,
        tree: config.treeContractId,
        comments: config.commentsContractId,
        message: contractsValid
          ? "Contract IDs are valid"
          : "Invalid contract ID format",
      },
    };

    // Test 4: Database Connectivity
    try {
      const dbStatus = getDbStatus();
      results.tests = {
        ...(results.tests as Record<string, unknown>),
        database: {
          passed: true,
          message: "Database is accessible",
          status: dbStatus,
        },
      };
    } catch (err) {
      results.tests = {
        ...(results.tests as Record<string, unknown>),
        database: {
          passed: false,
          error: (err as Error).message,
          message: "Database connectivity failed",
        },
      };
    }

    // Test 5: RPC Pool Status
    const poolMetrics = rpcPoolManager.getMetrics();
    const poolHealthy = poolMetrics.healthyEndpoints > 0;
    results.tests = {
      ...(results.tests as Record<string, unknown>),
      rpc_pool: {
        passed: poolHealthy,
        message: poolHealthy
          ? "RPC pool has available endpoints"
          : "No available RPC endpoints",
        metrics: poolMetrics,
      },
    };

    // Overall result
    const allTests = Object.values(
      results.tests as Record<string, { passed: boolean }>,
    );
    const passedCount = allTests.filter((t) => t.passed).length;
    const totalCount = allTests.length;
    const allPassed = passedCount === totalCount;

    results.summary = {
      passed: passedCount,
      total: totalCount,
      success: allPassed,
      duration_ms: Date.now() - startTime,
    };

    const statusCode = allPassed ? 200 : 503;
    log("info", "relay_smoke_test", {
      success: allPassed,
      passed: passedCount,
      total: totalCount,
      duration_ms: Date.now() - startTime,
    });

    return res.status(statusCode).json(results);
  } catch (err) {
    log("error", "relay_smoke_test_failed", {
      error: (err as Error).message,
      duration_ms: Date.now() - startTime,
    });
    return res.status(500).json({
      timestamp: new Date().toISOString(),
      summary: {
        success: false,
        error: (err as Error).message,
        duration_ms: Date.now() - startTime,
      },
      tests: results.tests,
    });
  }
});

export default router;
