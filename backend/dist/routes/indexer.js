/**
 * Event Indexer Routes
 *
 * Handles event retrieval, indexer status, and event notifications.
 */
import { Router } from "express";
import { log } from "../services/logger.js";
import { getEventsForDao, getIndexedDaos, getIndexerStatus, addManualEvent, notifyEvent, } from "../services/indexer.js";
import { getArchiveIndex, readArchivedEvents } from "../services/archival.js";
import { getPendingEventsCountForDao } from "../services/db.js";
import { authGuard, auditLog, queryLimiter, validateParams, validateQuery, bodyLimit, } from "../middleware/index.js";
import { daoParamsSchema, eventsQuerySchema, archiveParamsSchema, } from "../validation/schemas.js";
function encodeCursor(event, cursorField) {
    const payload = cursorField === "ledger"
        ? { l: event.ledger }
        : cursorField === "timestamp"
            ? { t: event.timestamp }
            : { i: event.id };
    return Buffer.from(JSON.stringify(payload)).toString("base64");
}
const router = Router();
// Function to be set from main app for triggering membership sync
let triggerMembershipSync = null;
/**
 * Initialize the indexer routes with optional membership sync callback
 */
export function initIndexerRoutes(membershipSyncFn) {
    if (membershipSyncFn) {
        triggerMembershipSync = membershipSyncFn;
    }
}
/**
 * GET /events/archived - List historical event archives
 */
router.get("/events/archived", queryLimiter, (req, res) => {
    const { daoId } = req.query;
    try {
        const id = daoId ? parseInt(daoId) : undefined;
        const archives = getArchiveIndex(id);
        res.json({ archives, total: archives.length });
    }
    catch (err) {
        log("error", "get_archived_events_index_failed", {
            error: err.message,
        });
        res.status(500).json({ error: "Failed to get archived events index" });
    }
});
/**
 * GET /events/archived/:archiveId - Retrieve historical archived events
 */
router.get("/events/archived/:archiveId", queryLimiter, validateParams(archiveParamsSchema), (req, res) => {
    const { archiveId } = req.validatedParams;
    try {
        const events = readArchivedEvents(archiveId.toString());
        res.json({ archiveId, events, total: events.length });
    }
    catch (err) {
        log("error", "read_archived_events_failed", {
            archiveId,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to read archived events" });
    }
});
/**
 * GET /events/:daoId - Get events for a DAO (cursor-based pagination)
 */
router.get("/events/:daoId", queryLimiter, validateParams(daoParamsSchema), validateQuery(eventsQuerySchema), (async (req, res) => {
    const { daoId } = req.validatedParams;
    const { limit, cursor, types, orderBy, orderDirection, cursorField } = req.validatedQuery;
    try {
        const options = {
            limit,
            types,
            orderBy,
            orderDirection,
            cursor,
            cursorField,
        };
        const result = getEventsForDao(daoId, options);
        const hasMore = result.events.length === limit && result.total > result.events.length;
        const nextCursor = hasMore && result.events.length > 0
            ? encodeCursor(result.events[result.events.length - 1], cursorField)
            : undefined;
        res.json({
            data: result.events,
            pagination: {
                cursor: nextCursor,
                hasMore,
                total: result.total,
            },
        });
    }
    catch (err) {
        log("error", "get_events_failed", {
            daoId,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to get events" });
    }
}));
/**
 * GET /indexer/status - Get indexer status
 */
router.get("/indexer/status", queryLimiter, (req, res) => {
    try {
        const status = getIndexerStatus();
        res.json(status);
    }
    catch {
        res.status(500).json({ error: "Failed to get indexer status" });
    }
});
/**
 * GET /indexer/daos - List all indexed DAOs
 */
router.get("/indexer/daos", queryLimiter, (req, res) => {
    try {
        const daos = getIndexedDaos();
        res.json({ daos });
    }
    catch {
        res.status(500).json({ error: "Failed to get indexed DAOs" });
    }
});
/**
 * POST /events - Manual event submission (admin only)
 */
router.post("/events", bodyLimit("2kb"), authGuard, auditLog("events_manual_insert"), (req, res) => {
    const { daoId, type, data } = req.body;
    if (!daoId || !type) {
        return res.status(400).json({ error: "daoId and type are required" });
    }
    try {
        addManualEvent(daoId, type, data || {});
        res.json({ success: true });
    }
    catch {
        res.status(500).json({ error: "Failed to add event" });
    }
});
/**
 * POST /events/notify - Frontend event notification
 */
// N4 hardening: was unauthenticated. Inbound events fan out into Soroban RPC
// reads (sync_membership) — unauthenticated callers could amplify into a
// downstream-RPC DoS.
router.post("/events/notify", bodyLimit("2kb"), authGuard, auditLog("events_notify"), queryLimiter, (async (req, res) => {
    const { daoId, type, data, txHash } = req.body;
    if (!daoId || !type || !txHash) {
        return res
            .status(400)
            .json({ error: "daoId, type, and txHash are required" });
    }
    if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
        return res.status(400).json({ error: "Invalid txHash format" });
    }
    // Prevent accumulation by limiting pending unverified events per DAO
    const pendingCount = getPendingEventsCountForDao(Number(daoId));
    if (pendingCount >= 50) {
        log("warn", "pending_events_limit_exceeded", { daoId, pendingCount });
        return res
            .status(429)
            .json({ error: "Pending event limit exceeded for this DAO" });
    }
    try {
        notifyEvent(Number(daoId), type, data || {}, txHash);
        // Trigger membership cache refresh for membership events
        const membershipEvents = [
            "sbt_mint",
            "sbt_revoke",
            "member_join",
            "member_leave",
            "self_join",
        ];
        if (membershipEvents.includes(type) && triggerMembershipSync) {
            triggerMembershipSync(Number(daoId)).catch((err) => {
                log("warn", "triggered_membership_sync_failed", {
                    daoId,
                    error: err.message,
                });
            });
        }
        res.json({ success: true, message: "Event queued for verification" });
    }
    catch (err) {
        log("error", "notify_event_failed", {
            daoId,
            type,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to notify event" });
    }
}));
export default router;
//# sourceMappingURL=indexer.js.map