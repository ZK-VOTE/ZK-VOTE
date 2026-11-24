/**
 * Prometheus Metrics Endpoint
 *
 * Exposes /metrics in Prometheus text exposition format.
 */

import { Router, Request, Response } from "express";
import { extractAuthToken } from "../middleware/auth.js";
import { config } from "../config.js";
import { timingSafeEqual } from "node:crypto";
import { register } from "../services/metrics.js";
import {
  dbConnectionsActive,
  dbWalSizeBytes,
  dbReadLagMs,
  dbWriteHealthy,
  dbWriteFailoverTotal,
} from "../services/metrics.js";
import { rpcPoolManager } from "../services/stellar.js";
import { getDbStatus, setDbMetricsSink } from "../services/db.js";

setDbMetricsSink({
  setConnectionsActive: (n) => dbConnectionsActive.set(n),
  setWalSizeBytes: (n) => dbWalSizeBytes.set(n),
  setReadLagMs: (n) => dbReadLagMs.set(n),
  setWriteHealthy: (healthy) => dbWriteHealthy.set(healthy ? 1 : 0),
  incWriteFailover: (result) => dbWriteFailoverTotal.inc({ result }),
});

const router = Router();

/**
 * GET /metrics
 * Prometheus-compatible metrics endpoint
 */
router.get("/metrics", async (req: Request, res: Response) => {
  // Auth-gate: metrics can reveal operational details (queue depths,
  // error rates, sequence numbers). Require the relayer auth token.
  const token = extractAuthToken(req);
  const expected = config.relayerAuthToken;
  if (!token || !expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const bufA = Buffer.from(token);
  const bufB = Buffer.from(expected);
  if (bufA.length !== bufB.length || !timingSafeEqual(new Uint8Array(bufA), new Uint8Array(bufB))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    // Update RPC pool gauges before collecting
    const poolMetrics = rpcPoolManager.getMetrics();

    // Use collect functions on existing metrics rather than registerMetric
    const healthyEp = register.getSingleMetric(
      "zkvote_rpc_pool_healthy_endpoints",
    );
    const totalEp = register.getSingleMetric("zkvote_rpc_pool_total_endpoints");

    if (healthyEp && "set" in healthyEp) {
      (healthyEp as any).set(poolMetrics.healthyEndpoints);
    }
    if (totalEp && "set" in totalEp) {
      (totalEp as any).set(poolMetrics.totalEndpoints);
    }

    // Update DB gauges (WAL, lag, connections)
    try {
      const dbStatus = getDbStatus() as unknown as Record<string, unknown>;
      if (dbStatus && typeof dbStatus === "object") {
        const walSize = dbStatus.walSizeBytes;
        if (typeof walSize === "number") {
          const walMetric = register.getSingleMetric(
            "zkvote_db_wal_size_bytes",
          );
          if (walMetric && "set" in walMetric) {
            (walMetric as any).set(walSize);
          }
        }
        const lag = dbStatus.readLagMs;
        if (typeof lag === "number") {
          const lagMetric = register.getSingleMetric("zkvote_db_read_lag_ms");
          if (lagMetric && "set" in lagMetric) {
            (lagMetric as any).set(lag);
          }
        }
        const conns = dbStatus.connectionsActive;
        if (typeof conns === "number") {
          const connMetric = register.getSingleMetric(
            "zkvote_db_connections_active",
          );
          if (connMetric && "set" in connMetric) {
            (connMetric as any).set(conns);
          }
        }
        const healthy = dbStatus.writeHealthy;
        if (typeof healthy === "boolean") {
          const healthyMetric = register.getSingleMetric(
            "zkvote_db_write_healthy",
          );
          if (healthyMetric && "set" in healthyMetric) {
            (healthyMetric as any).set(healthy ? 1 : 0);
          }
        }
      }
    } catch {
      // DB not initialized yet — skip
    }

    const metrics = await register.metrics();
    res.set("Content-Type", register.contentType);
    res.end(metrics);
  } catch (err) {
    res.status(500).end(`Error collecting metrics: ${(err as Error).message}`);
  }
});

export default router;
