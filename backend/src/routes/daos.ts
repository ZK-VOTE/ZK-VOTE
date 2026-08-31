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
  validateQuery,
  bodyLimit,
} from "../middleware/index.js";
import {
  getServiceHealth,
  type ServiceHealthEntry,
} from "../services/service-health.js";
import { daoParamsSchema, daosQuerySchema } from "../validation/schemas.js";
import type { AsyncHandler } from "../types/index.js";

const router = Router();

/**
 * GET /daos - Get all DAOs with limit/offset pagination
 */
router.get("/daos", queryLimiter, validateQuery(daosQuerySchema), (async (
  req: Request,
  res: Response,
) => {
  const { limit, offset, user } = (req as any).validatedQuery;
    const pageOffset = offset;

  try {
    // The DAO list is served from the sync cache whether or not a user was
    // supplied, so the degradation note applies to both cases.
    const syncHealth = getServiceHealth("dao_sync") as ServiceHealthEntry;
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
            return { ...dao, role: "admin" as const };
          }
          const members = daoMembersCache.get(dao.id);
          if (members && members.has(user)) {
            return { ...dao, role: "member" as const };
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
  } catch (err) {
    log("error", "get_daos_failed", { error: (err as Error).message });
    res.status(500).json({ error: "Failed to get DAOs" });
  }
}) as AsyncHandler);

/**
 * GET /dao/:daoId - Get specific DAO from cache
 */
router.get(
  "/dao/:daoId",
  queryLimiter,
  validateParams(daoParamsSchema),
  (req: Request, res: Response) => {
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
  },
);

/**
 * POST /daos/sync - Trigger manual DAO sync (admin only)
 */
router.post(
  "/daos/sync",
  bodyLimit("1kb"),
  authGuard,
  auditLog("daos_sync"),
  (async (req: Request, res: Response) => {
    try {
      const synced = await syncDaosFromContract();
      res.json({ success: true, synced });
    } catch (err) {
      log("error", "dao_sync_failed", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to sync DAOs" });
    }
  }) as AsyncHandler,
);

router.post(
  "/dao/:daoId/notifications/subscribe",
  bodyLimit("1kb"),
  authGuard,
  auditLog("dao_notifications_subscribe"),
  validateParams(daoParamsSchema),
  (req: Request, res: Response) => {
    try {
      const { daoId } = (req as any).validatedParams;
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
    } catch (err) {
      log("error", "dao_notifications_subscribe_failed", {
        error: (err as Error).message,
      });
      return res.status(500).json({ error: "Failed to subscribe to DAO notifications" });
    }
  },
);

router.post(
  "/dao/:daoId/notifications/unsubscribe",
  bodyLimit("1kb"),
  authGuard,
  auditLog("dao_notifications_unsubscribe"),
  validateParams(daoParamsSchema),
  (req: Request, res: Response) => {
    try {
      const { daoId } = (req as any).validatedParams;
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
    } catch (err) {
      log("error", "dao_notifications_unsubscribe_failed", {
        error: (err as Error).message,
      });
      return res.status(500).json({ error: "Failed to unsubscribe from DAO notifications" });
    }
  },
);

router.get(
  "/dao/:daoId/notifications/subscriptions",
  queryLimiter,
  validateParams(daoParamsSchema),
  (req: Request, res: Response) => {
    try {
      const { daoId } = (req as any).validatedParams;
      const subscriptions = dbService.listDaoProposalLifecycleSubscriptions(daoId);
      res.json({ data: subscriptions });
    } catch (err) {
      log("error", "dao_notifications_list_failed", {
        daoId: (req as any).validatedParams?.daoId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to list DAO notifications" });
    }
  },
);

router.get(
  "/dao/:daoId/notifications",
  queryLimiter,
  validateParams(daoParamsSchema),
  (req: Request, res: Response) => {
    try {
      const { daoId } = (req as any).validatedParams;
      const eventType = req.query.eventType as string | undefined;
      const notifications = dbService.getDaoProposalLifecycleNotifications(daoId, {
        eventType,
      });
      res.json({ data: notifications });
    } catch (err) {
      log("error", "dao_notifications_history_failed", {
        daoId: (req as any).validatedParams?.daoId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to load DAO notification history" });
    }
  },
);

export default router;
