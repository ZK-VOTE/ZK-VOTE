/**
 * Admin Routes
 *
 * Read-only review of the audit log (append-only, hash-chained trail of
 * privileged actions recorded by middleware/audit.ts), plus a
 * privileged graceful-shutdown trigger for controlled restarts.
 */
import { Router } from "express";
import { authGuard, queryLimiter, bodyLimit } from "../middleware/index.js";
import { getAuditLogs, verifyAuditChain, formatAsCef, } from "../services/audit.js";
import { getEventsForDao } from "../services/db.js";
import { log } from "../services/logger.js";
const router = Router();
let shutdownHandler = null;
/**
 * Wire the server's graceful-shutdown function to the /admin/shutdown
 * route. Called once at startup from index.ts.
 */
export function registerShutdownHandler(handler) {
    shutdownHandler = handler;
}
/**
 * POST /admin/shutdown - trigger a graceful shutdown (admin only).
 *
 * Drains in-flight requests and sequence-locked chain submissions, stops
 * background services, and closes the database before exiting. Responds
 * 202 before draining begins, since the process exits once drain completes.
 *
 * Body (optional): { "reason": "<string>" }
 */
router.post("/admin/shutdown", bodyLimit("100kb"), authGuard, queryLimiter, (async (req, res) => {
    if (!shutdownHandler) {
        res.status(503).json({ error: "Shutdown handler not available" });
        return;
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "admin_request";
    log("warn", "admin_shutdown_requested", { reason });
    res.status(202).json({ status: "shutting_down", reason });
    // Defer so the 202 flushes before the server stops accepting connections.
    setTimeout(() => {
        void shutdownHandler(reason);
    }, 100);
}));
// ============================================
// AUDIT LOG REVIEW
// ============================================
/**
 * GET /admin/audit-log - Paginated audit log review (admin only).
 *
 * Query params:
 *   limit    - max rows (default 50, max 500)
 *   offset   - pagination offset (default 0)
 *   action   - filter by action name
 *   format   - "json" (default) or "cef"
 *   verify   - "true" to include a hash-chain integrity check
 */
router.get("/admin/audit-log", authGuard, queryLimiter, (async (req, res) => {
    try {
        const limit = req.query.limit ? Number(req.query.limit) : 50;
        const offset = req.query.offset ? Number(req.query.offset) : 0;
        const action = typeof req.query.action === "string" ? req.query.action : undefined;
        const format = req.query.format === "cef" ? "cef" : "json";
        const includeVerification = req.query.verify === "true";
        const { logs, total } = getAuditLogs({ limit, offset, action });
        if (format === "cef") {
            res.type("text/plain").send(formatAsCef(logs));
            return;
        }
        const body = { logs, total, limit, offset };
        if (includeVerification) {
            body.chainVerification = verifyAuditChain();
        }
        res.json(body);
    }
    catch (err) {
        log("error", "admin_audit_log_failed", { error: err.message });
        res.status(500).json({ error: "Failed to fetch audit log" });
    }
}));
// ============================================
// SBT TRANSFER-ATTEMPT REVIEW (#357)
// ============================================
/**
 * GET /admin/sbt-transfer-attempts - Review flagged membership-SBT
 * transfer/approval attempts for one DAO (admin only).
 *
 * The membership-sbt contract always rejects transfer/transfer_from/approve
 * (soulbound); services/sbt-guard.ts detects the attempt from the
 * transaction envelope regardless of on-chain success/failure and records
 * it here as an `sbt_transfer_attempt` event.
 *
 * Query params:
 *   daoId  - required, the DAO to review
 *   limit  - max rows (default 50, max 500)
 *   offset - pagination offset (default 0)
 */
router.get("/admin/sbt-transfer-attempts", authGuard, queryLimiter, (async (req, res) => {
    const daoId = Number(req.query.daoId);
    if (!Number.isInteger(daoId) || daoId < 1) {
        res
            .status(400)
            .json({ error: "daoId is required and must be a positive integer" });
        return;
    }
    try {
        const limit = req.query.limit
            ? Math.max(1, Math.min(Number(req.query.limit), 500))
            : 50;
        const offset = req.query.offset ? Math.max(0, Number(req.query.offset)) : 0;
        const { events, total } = getEventsForDao(daoId, {
            types: ["sbt_transfer_attempt"],
            limit,
            offset,
        });
        res.json({ daoId, attempts: events, total, limit, offset });
    }
    catch (err) {
        log("error", "admin_sbt_transfer_attempts_failed", {
            daoId,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to fetch SBT transfer attempts" });
    }
}));
export default router;
//# sourceMappingURL=admin.js.map