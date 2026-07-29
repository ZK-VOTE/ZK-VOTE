/**
 * DAO Routes
 *
 * Handles DAO listing, retrieval, and sync operations.
 */

import { Router, type Request, type Response } from "express";

import { log } from "../services/logger.js";
import * as dbService from "../services/db.js";
import {
  syncDaosFromContract,
  daoMembersCache,
  daoAdminsCache,
} from "../services/sync.js";
import {
  authGuard,
  auditLog,
  queryLimiter,
  validateParams,
  noteDegraded,
} from "../middleware/index.js";
import { getServiceHealth } from "../services/service-health.js";
import { daoParamsSchema } from "../validation/schemas.js";
  validateQuery,
} from "../middleware/index.js";
import { daoParamsSchema, daosQuerySchema } from "../validation/schemas.js";
import type { AsyncHandler, DaoWithRole } from "../types/index.js";

const router = Router();

/**
 * GET /daos - Get all DAOs with limit/offset pagination
 */
router.get("/daos", queryLimiter, validateQuery(daosQuerySchema), (async (req: Request, res: Response) => {
  const { limit, offset, user } = (req as any).validatedQuery;

  try {
    const allDaos = dbService.getAllCachedDaos();
    let filteredDaos = allDaos;

    if (!userAddress) {
      const syncHealth = getServiceHealth("dao_sync") as { state: string };
      if (syncHealth.state !== "healthy") {
        noteDegraded("dao_sync");
      }
      return res.json({
        daos,
        total: daos.length,
        lastSync,
        cached: true,
      if (user) {
      if (!/^[GC][A-Z2-7]{55}$/.test(user)) {
        return res.status(400).json({ error: "Invalid Stellar address format" });
      }
      filteredDaos = allDaos.map((dao) => {
        const adminAddr = daoAdminsCache.get(dao.id) || dao.creator;
        if (adminAddr === user) {
          return { ...dao, role: "admin" as const };
        }
        const members = daoMembersCache.get(dao.id);
        if (members && members.has(user)) {
          return { ...dao, role: "member" as const };
        }
        return { ...dao, role: null };
      });
    }

    const total = filteredDaos.length;
    const paginatedDaos = filteredDaos.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    log("info", "get_daos_paginated", {
      user: user?.slice(0, 8) + "...",
      count: paginatedDaos.length,
      total,
      offset,
      limit,
    });

    res.json({
      data: paginatedDaos,
      pagination: {
        cursor: hasMore ? String(offset + limit) : undefined,
        hasMore,
        total,
      },
      lastSync: dbService.getDaosSyncTime(),
      cached: true,
    });
  } catch (err) {
    log("error", "get_daos_failed", { error: (err as Error).message });
    res.status(500).json({ error: "Failed to get DAOs" });
  }
}) as AsyncHandler);

/**
 * GET /dao/:daoId - Get specific DAO from cache
 */
router.get("/dao/:daoId", queryLimiter, validateParams(daoParamsSchema), (req: Request, res: Response) => {
  const { daoId } = (req as any).validatedParams;
  try {
    const dao = dbService.getCachedDao(daoId);
    if (!dao) {
      return res.status(404).json({ error: "DAO not found in cache" });
    }
    res.json({ dao, cached: true });
  } catch (err) {
    log("error", "get_dao_failed", { daoId, error: (err as Error).message });
    res.status(500).json({ error: "Failed to get DAO" });
  }
});

/**
 * POST /daos/sync - Trigger manual DAO sync (admin only)
 */
router.post("/daos/sync", authGuard, auditLog("daos_sync"), (async (req: Request, res: Response) => {
  try {
    const synced = await syncDaosFromContract();
    res.json({ success: true, synced });
  } catch (err) {
    log("error", "dao_sync_failed", { error: (err as Error).message });
    res.status(500).json({ error: "Failed to sync DAOs" });
  }
}) as AsyncHandler);

export default router;
