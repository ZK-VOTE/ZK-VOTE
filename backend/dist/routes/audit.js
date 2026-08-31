/**
 * Audit Routes - Query & Export for accountability
 *
 * Provides:
 * - GET /audit/logs - query audit trail with filters
 * - GET /audit/export - export audit logs (json/csv)
 * - GET /audit/stats - summary stats
 *
 * All endpoints require authentication (authGuard) to prevent leaking audit metadata.
 * Logs themselves are already redacted, but access control adds defense in depth.
 */
import { Router } from "express";
import { authGuard, queryLimiter } from "../middleware/index.js";
import { queryAuditLogs, exportAuditLogs, getAllAuditLogs } from "../middleware/audit.js";
const router = Router();
/**
 * GET /audit/logs - Query audit logs
 * Query params: action, actor, method, path, from, to, limit, offset
 */
router.get("/audit/logs", authGuard, queryLimiter, (req, res) => {
    const { action, actor, method, path, from, to, limit, offset } = req.query;
    const q = {};
    if (action)
        q.action = String(action);
    if (actor)
        q.actor = String(actor);
    if (method)
        q.method = String(method);
    if (path)
        q.path = String(path);
    if (from)
        q.from = String(from);
    if (to)
        q.to = String(to);
    if (limit)
        q.limit = parseInt(String(limit), 10);
    if (offset)
        q.offset = parseInt(String(offset), 10);
    // Validate limit/offset
    if (q.limit !== undefined && (isNaN(q.limit) || q.limit < 1 || q.limit > 100)) {
        return res.status(400).json({ error: "limit must be between 1 and 100" });
    }
    if (q.offset !== undefined && (isNaN(q.offset) || q.offset < 0)) {
        return res.status(400).json({ error: "offset must be >= 0" });
    }
    if (q.from && isNaN(new Date(String(q.from)).getTime())) {
        return res.status(400).json({ error: "from must be ISO date" });
    }
    if (q.to && isNaN(new Date(String(q.to)).getTime())) {
        return res.status(400).json({ error: "to must be ISO date" });
    }
    const result = queryAuditLogs(q);
    res.json({
        entries: result.entries,
        total: result.total,
        limit: q.limit || 50,
        offset: q.offset || 0,
    });
});
/**
 * GET /audit/export - Export audit logs
 * Query params: format=json|csv
 * Returns downloadable file with redacted logs.
 */
router.get("/audit/export", authGuard, queryLimiter, (req, res) => {
    const format = req.query.format || "json";
    if (format !== "json" && format !== "csv") {
        return res.status(400).json({ error: "format must be json or csv" });
    }
    const exported = exportAuditLogs(format);
    if (format === "csv") {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", "attachment; filename=audit-export.csv");
        return res.send(exported);
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=audit-export.json");
    return res.send(exported);
});
/**
 * GET /audit/stats - Audit statistics (counts by action)
 */
router.get("/audit/stats", authGuard, queryLimiter, (req, res) => {
    const logs = getAllAuditLogs();
    const byAction = {};
    const byMethod = {};
    for (const e of logs) {
        byAction[e.action] = (byAction[e.action] || 0) + 1;
        byMethod[e.method] = (byMethod[e.method] || 0) + 1;
    }
    res.json({
        total: logs.length,
        byAction,
        byMethod,
        oldest: logs[0]?.timestamp || null,
        newest: logs[logs.length - 1]?.timestamp || null,
    });
});
export default router;
//# sourceMappingURL=audit.js.map