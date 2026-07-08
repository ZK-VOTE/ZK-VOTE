/**
 * DAO Routes
 *
 * Handles DAO listing, retrieval, and sync operations.
 */
import { Router } from "express";
import { log } from "../services/logger.js";
import * as dbService from "../services/db.js";
import { syncDaosFromContract, daoMembersCache, daoAdminsCache, } from "../services/sync.js";
import { authGuard, queryLimiter } from "../middleware/index.js";
const router = Router();
/**
 * GET /daos - Get all DAOs (with optional user membership info)
 */
router.get("/daos", queryLimiter, (async (req, res) => {
    try {
        const daos = dbService.getAllCachedDaos();
        const lastSync = dbService.getDaosSyncTime();
        const userAddress = req.query.user;
        if (!userAddress) {
            return res.json({
                daos,
                total: daos.length,
                lastSync,
                cached: true,
            });
        }
        // Validate address
        if (!/^[GC][A-Z2-7]{55}$/.test(userAddress)) {
            return res.status(400).json({ error: "Invalid Stellar address format" });
        }
        // Use global membership cache
        const daosWithRoles = daos.map((dao) => {
            const adminAddr = daoAdminsCache.get(dao.id) || dao.creator;
            if (adminAddr === userAddress) {
                return { ...dao, role: "admin" };
            }
            const members = daoMembersCache.get(dao.id);
            if (members && members.has(userAddress)) {
                return { ...dao, role: "member" };
            }
            return { ...dao, role: null };
        });
        log("info", "get_daos_with_membership", {
            user: userAddress.slice(0, 8) + "...",
            count: daos.length,
            cachedDaos: daoMembersCache.size,
        });
        res.json({
            daos: daosWithRoles,
            total: daosWithRoles.length,
            lastSync,
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
router.get("/dao/:daoId", queryLimiter, (req, res) => {
    const { daoId } = req.params;
    try {
        const dao = dbService.getCachedDao(parseInt(daoId));
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
router.post("/daos/sync", authGuard, (async (req, res) => {
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