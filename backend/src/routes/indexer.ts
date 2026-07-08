/**
 * Event Indexer Routes
 *
 * Handles event retrieval, indexer status, and event notifications.
 */

import { Router, type Request, type Response } from "express";

import { log } from "../services/logger.js";
import {
  getEventsForDao,
  getIndexedDaos,
  getIndexerStatus,
  addManualEvent,
  notifyEvent,
} from "../services/indexer.js";
import { authGuard, queryLimiter } from "../middleware/index.js";
import type { AsyncHandler } from "../types/index.js";

const router = Router();

// Function to be set from main app for triggering membership sync
let triggerMembershipSync: ((daoId: number) => Promise<void>) | null = null;

/**
 * Initialize the indexer routes with optional membership sync callback
 */
export function initIndexerRoutes(
  membershipSyncFn?: (daoId: number) => Promise<void>,
): void {
  if (membershipSyncFn) {
    triggerMembershipSync = membershipSyncFn;
  }
}

/**
 * GET /events/:daoId - Get events for a DAO
 */
router.get("/events/:daoId", queryLimiter, (req: Request, res: Response) => {
  const { daoId } = req.params;
  const { limit = "50", offset = "0", types } = req.query;

  try {
    const options = {
      limit: Math.min(parseInt(limit as string) || 50, 100),
      offset: parseInt(offset as string) || 0,
      types: types ? (types as string).split(",") : null,
    };

    const result = getEventsForDao(parseInt(daoId), options);
    res.json(result);
  } catch (err) {
    log("error", "get_events_failed", { daoId, error: (err as Error).message });
    res.status(500).json({ error: "Failed to get events" });
  }
});

/**
 * GET /indexer/status - Get indexer status
 */
router.get("/indexer/status", queryLimiter, (req: Request, res: Response) => {
  try {
    const status = getIndexerStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: "Failed to get indexer status" });
  }
});

/**
 * GET /indexer/daos - List all indexed DAOs
 */
router.get("/indexer/daos", queryLimiter, (req: Request, res: Response) => {
  try {
    const daos = getIndexedDaos();
    res.json({ daos });
  } catch (err) {
    res.status(500).json({ error: "Failed to get indexed DAOs" });
  }
});

/**
 * POST /events - Manual event submission (admin only)
 */
router.post("/events", authGuard, (req: Request, res: Response) => {
  const { daoId, type, data } = req.body;

  if (!daoId || !type) {
    return res.status(400).json({ error: "daoId and type are required" });
  }

  try {
    addManualEvent(daoId, type, data || {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to add event" });
  }
});

/**
 * POST /events/notify - Frontend event notification
 */
// N4 hardening: was unauthenticated. Inbound events fan out into Soroban RPC
// reads (sync_membership) — unauthenticated callers could amplify into a
// downstream-RPC DoS.
router.post("/events/notify", authGuard, queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { daoId, type, data, txHash } = req.body;

  if (!daoId || !type || !txHash) {
    return res
      .status(400)
      .json({ error: "daoId, type, and txHash are required" });
  }

  if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ error: "Invalid txHash format" });
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
          error: (err as Error).message,
        });
      });
    }

    res.json({ success: true, message: "Event queued for verification" });
  } catch (err) {
    log("error", "notify_event_failed", {
      daoId,
      type,
      error: (err as Error).message,
    });
    res.status(500).json({ error: "Failed to notify event" });
  }
}) as AsyncHandler);

export default router;
