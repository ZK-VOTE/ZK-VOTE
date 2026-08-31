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
import { daoParamsSchema, daosQuerySchema } from "../validation/schemas.js";
const router = Router();
/**
 * GET /daos - Get all DAOs with limit/offset pagination
 */
router.get("/daos", queryLimiter, validateQuery(daosQuerySchema), (async (req, res) => {
    const { limit, offset, user } = req.validatedQuery;
    try {
        // The DAO list is served from the sync cache whether or not a user was
        // supplied, so the degradation note applies to both cases.
        const syncHealth = getServiceHealth("dao_sync");
        if (syncHealth.state !== "healthy") {
            noteDegraded("dao_sync");
        }
        const allDaos = dbService.getAllCachedDaos();
        // `user` is already format-checked by daosQuerySchema, so an invalid
        // address never reaches this handler; it is only used to annotate roles.
        const annotatedDaos = user
            ? allDaos.map((dao) => {
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
        const paginatedDaos = annotatedDaos.slice(offset, offset + limit);
        const hasMore = offset + limit < total;
        log("info", "get_daos_paginated", {
            user: user ? `${user.slice(0, 8)}...` : null,
            count: paginatedDaos.length,
            total,
            offset,
            limit,
        });
        res.json({
            data: paginatedDaos,
            pagination: {
                cursor: String(offset),
                nextCursor: hasMore ? String(offset + limit) : null,
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
export default router;
//# sourceMappingURL=daos.js.map