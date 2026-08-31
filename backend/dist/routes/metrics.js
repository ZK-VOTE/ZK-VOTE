/**
 * Prometheus Metrics Endpoint
 *
 * Exposes /metrics in Prometheus text exposition format.
 */
import { Router } from "express";
import { register } from "../services/metrics.js";
import { dbConnectionsActive, dbWalSizeBytes, dbReadLagMs, dbWriteHealthy, dbWriteFailoverTotal, } from "../services/metrics.js";
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
router.get("/metrics", async (_req, res) => {
    try {
        // Update RPC pool gauges before collecting
        const poolMetrics = rpcPoolManager.getMetrics();
        // Use collect functions on existing metrics rather than registerMetric
        const healthyEp = register.getSingleMetric("zkvote_rpc_pool_healthy_endpoints");
        const totalEp = register.getSingleMetric("zkvote_rpc_pool_total_endpoints");
        if (healthyEp && "set" in healthyEp) {
            healthyEp.set(poolMetrics.healthyEndpoints);
        }
        if (totalEp && "set" in totalEp) {
            totalEp.set(poolMetrics.totalEndpoints);
        }
        // Update DB gauges (WAL, lag, connections)
        try {
            const dbStatus = getDbStatus();
            if (dbStatus && typeof dbStatus === "object") {
                const walSize = dbStatus.walSizeBytes;
                if (typeof walSize === "number") {
                    const walMetric = register.getSingleMetric("zkvote_db_wal_size_bytes");
                    if (walMetric && "set" in walMetric) {
                        walMetric.set(walSize);
                    }
                }
                const lag = dbStatus.readLagMs;
                if (typeof lag === "number") {
                    const lagMetric = register.getSingleMetric("zkvote_db_read_lag_ms");
                    if (lagMetric && "set" in lagMetric) {
                        lagMetric.set(lag);
                    }
                }
                const conns = dbStatus.connectionsActive;
                if (typeof conns === "number") {
                    const connMetric = register.getSingleMetric("zkvote_db_connections_active");
                    if (connMetric && "set" in connMetric) {
                        connMetric.set(conns);
                    }
                }
                const healthy = dbStatus.writeHealthy;
                if (typeof healthy === "boolean") {
                    const healthyMetric = register.getSingleMetric("zkvote_db_write_healthy");
                    if (healthyMetric && "set" in healthyMetric) {
                        healthyMetric.set(healthy ? 1 : 0);
                    }
                }
            }
        }
        catch {
            // DB not initialized yet — skip
        }
        const metrics = await register.metrics();
        res.set("Content-Type", register.contentType);
        res.end(metrics);
    }
    catch (err) {
        res.status(500).end(`Error collecting metrics: ${err.message}`);
    }
});
export default router;
//# sourceMappingURL=metrics.js.map