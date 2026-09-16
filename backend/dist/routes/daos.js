// @ts-nocheck
/**
 * DAO Routes
 *
 * Handles DAO listing, retrieval, and sync operations.
 */
import { Router } from "express";
import { log } from "../services/logger.js";
import * as dbService from "../services/db.js";
import { syncDaosFromContract, daoMembersCache, daoAdminsCache, } from "../services/sync.js";
import { authGuard, auditLog, queryLimiter, validateParams, noteDegraded, validateQuery, bodyLimit, } from "../middleware/index.js";
import { getServiceHealth, } from "../services/service-health.js";
import { daoParamsSchema, daosQuerySchema, proposalsQuerySchema, } from "../validation/schemas.js";
const router = Router();
/**
 * GET /daos - Get all DAOs with limit/offset pagination
 */
router.get("/daos", queryLimiter, validateQuery(daosQuerySchema), (async (req, res) => {
    const { limit, offset, user } = req.validatedQuery;
    const pageOffset = offset;
    try {
        // The DAO list is served from the sync cache whether or not a user was
        // supplied, so the degradation note applies to both cases.
        const syncHealth = getServiceHealth("dao_sync");
        if (syncHealth.state !== "healthy") {
            noteDegraded("dao_sync");
        }
        let filteredDaos = dbService.getAllCachedDaos();
        // Apply free-text search on DAO name (case-insensitive substring)
        if (search) {
            const lowerSearch = search.toLowerCase();
            filteredDaos = filteredDaos.filter((dao) => dao.name.toLowerCase().includes(lowerSearch));
        }
        // Apply membership type filter
        if (membershipType === "open") {
            filteredDaos = filteredDaos.filter((dao) => dao.membership_open);
        }
        else if (membershipType === "closed") {
            filteredDaos = filteredDaos.filter((dao) => !dao.membership_open);
        }
        // `user` is already format-checked by daosQuerySchema, so an invalid
        // address never reaches this handler; it is only used to annotate roles.
        const allDaos = filteredDaos;
        const annotatedDaos = user
            ? filteredDaos.map((dao) => {
                const adminAddr = daoAdminsCache.get(dao.id) || dao.creator;
                if (adminAddr === user) {
                    return { ...dao, role: "admin" };
                }
                const members = daoMembersCache.get(dao.id);
                if (members && members.has(user)) {
                    return { ...dao, role: "member" };
                }
                return { ...dao, role: null };
            })
            : allDaos;
        const total = annotatedDaos.length;
        const paginatedDaos = annotatedDaos.slice(pageOffset, pageOffset + limit);
        const hasMore = pageOffset + limit < total;
        log("info", "get_daos_paginated", {
            user: user ? `${user.slice(0, 8)}...` : null,
            count: paginatedDaos.length,
            total,
            offset: pageOffset,
            limit,
            search: search ?? null,
            membershipType: membershipType ?? null,
        });
        // `pagination.cursor` is the *next* page cursor (echoed back as ?cursor=
        // by the frontend, which `daosQuerySchema` folds into offset); it is
        // undefined on the last page so clients stop auto-paginating.
        res.json({
            data: paginatedDaos,
            pagination: {
                cursor: hasMore ? String(offset + limit) : undefined,
                hasMore,
                limit,
                offset,
                total,
            },
            lastSync: dbService.getDaosSyncTime(),
            cached: true,
        });
    }
    catch (err) {
        log("error", "get_daos_failed", { error: err.message });
        res.status(500).json({ error: "Failed to get DAOs" });
    }
}));
/**
 * GET /dao/:daoId - Get specific DAO from cache
 */
router.get("/dao/:daoId", queryLimiter, validateParams(daoParamsSchema), (req, res) => {
    const { daoId } = req.validatedParams;
    try {
        const dao = dbService.getCachedDao(daoId);
        if (!dao) {
            return res.status(404).json({ error: "DAO not found in cache" });
        }
        res.json({ dao, cached: true });
    }
    catch (err) {
        log("error", "get_dao_failed", { daoId, error: err.message });
        res.status(500).json({ error: "Failed to get DAO" });
    }
});
/**
 * POST /daos/sync - Trigger manual DAO sync (admin only)
 */
router.post("/daos/sync", bodyLimit("1kb"), authGuard, auditLog("daos_sync"), (async (req, res) => {
    try {
        const synced = await syncDaosFromContract();
        res.json({ success: true, synced });
    }
    catch (err) {
        log("error", "dao_sync_failed", { error: err.message });
        res.status(500).json({ error: "Failed to sync DAOs" });
    }
}));
router.post("/dao/:daoId/notifications/subscribe", bodyLimit("1kb"), authGuard, auditLog("dao_notifications_subscribe"), validateParams(daoParamsSchema), (req, res) => {
    try {
        const { daoId } = req.validatedParams;
        const { walletAddress } = req.body ?? {};
        if (typeof walletAddress !== "string" || walletAddress.trim().length === 0) {
            return res.status(400).json({ error: "walletAddress is required" });
        }
        const result = dbService.subscribeToDaoProposalLifecycle(daoId, walletAddress);
        return res.json({
            success: true,
            active: result.active,
            walletAddressHash: result.walletAddressHash,
        });
    }
    catch (err) {
        log("error", "dao_notifications_subscribe_failed", {
            error: err.message,
        });
        return res.status(500).json({ error: "Failed to subscribe to DAO notifications" });
    }
});
router.post("/dao/:daoId/notifications/unsubscribe", bodyLimit("1kb"), authGuard, auditLog("dao_notifications_unsubscribe"), validateParams(daoParamsSchema), (req, res) => {
    try {
        const { daoId } = req.validatedParams;
        const { walletAddress } = req.body ?? {};
        if (typeof walletAddress !== "string" || walletAddress.trim().length === 0) {
            return res.status(400).json({ error: "walletAddress is required" });
        }
        const result = dbService.unsubscribeFromDaoProposalLifecycle(daoId, walletAddress);
        return res.json({
            success: result.success,
            active: result.active,
            walletAddressHash: result.walletAddressHash,
        });
    }
    catch (err) {
        log("error", "dao_notifications_unsubscribe_failed", {
            error: err.message,
        });
        return res.status(500).json({ error: "Failed to unsubscribe from DAO notifications" });
    }
});
router.get("/dao/:daoId/notifications/subscriptions", queryLimiter, validateParams(daoParamsSchema), (req, res) => {
    try {
        const { daoId } = req.validatedParams;
        const subscriptions = dbService.listDaoProposalLifecycleSubscriptions(daoId);
        res.json({ data: subscriptions });
    }
    catch (err) {
        log("error", "dao_notifications_list_failed", {
            daoId: req.validatedParams?.daoId,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to list DAO notifications" });
    }
});
router.get("/dao/:daoId/notifications", queryLimiter, validateParams(daoParamsSchema), (req, res) => {
    try {
        const { daoId } = req.validatedParams;
        const eventType = req.query.eventType;
        const notifications = dbService.getDaoProposalLifecycleNotifications(daoId, {
            eventType,
        });
        res.json({ data: notifications });
    }
    catch (err) {
        log("error", "dao_notifications_history_failed", {
            daoId: req.validatedParams?.daoId,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to load DAO notification history" });
    }
});
/**
 * GET /proposals/:daoId - Search and filter proposals for a DAO
 *
 * Query params:
 *  - status    : active | closed | all (default all)
 *  - search    : free-text substring match on proposal title
 *  - limit     : page size (1 – 500, default 100)
 *  - offset    : zero-based page start
 *
 * Authorization: public (queryLimiter rate-limited)
 */
router.get("/proposals/:daoId", queryLimiter, validateParams(daoParamsSchema), validateQuery(proposalsQuerySchema), (async (req, res) => {
    const { daoId } = req.validatedParams;
    const { limit, offset, status, search } = req
        .validatedQuery;
    try {
        // Pull proposal_created events from the per-DAO partition table
        const now = Date.now();
        const { events } = dbService.getEventsForDao(daoId, {
            types: ["proposal_created"],
            limit: 1000, // Fetch a broad window; we filter in memory
            offset: 0,
            orderBy: "timestamp",
            orderDirection: "DESC",
        });
        // Shape raw events into lightweight proposal summaries
        let proposals = events.map((evt) => {
            const data = (evt.data ?? {});
            const endTime = data.end_time ?? 0;
            const isClosed = !!data.closed || (endTime > 0 && endTime * 1000 < now);
            return {
                proposalId: data.proposal_id ?? null,
                title: data.title ?? "",
                endTime,
                closed: isClosed,
                txHash: evt.tx_hash ?? null,
                timestamp: evt.timestamp,
            };
        });
        // Apply status filter
        if (status === "active") {
            proposals = proposals.filter((p) => !p.closed);
        }
        else if (status === "closed") {
            proposals = proposals.filter((p) => p.closed);
        }
        // Apply free-text search on title
        if (search) {
            const lowerSearch = search.toLowerCase();
            proposals = proposals.filter((p) => p.title.toLowerCase().includes(lowerSearch));
        }
        const total = proposals.length;
        const paginated = proposals.slice(offset, offset + limit);
        const hasMore = offset + limit < total;
        log("info", "get_proposals_filtered", {
            daoId,
            status,
            search: search ?? null,
            total,
            offset,
            limit,
        });
        res.json({
            data: paginated,
            pagination: {
                cursor: hasMore ? String(offset + limit) : undefined,
                hasMore,
                total,
            },
            filters: { status, search: search ?? null },
        });
    }
    catch (err) {
        log("error", "get_proposals_failed", {
            daoId,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to get proposals" });
    }
}));
export default router;
//# sourceMappingURL=daos.js.map