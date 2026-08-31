/**
 * Transaction Status Routes (#172)
 *
 * `GET /tx/:hash` returns the current confirmation status of a transaction,
 * serving as the polling fallback for frontends that do not (or cannot) use
 * the WebSocket confirmation feed. The queue answers from its in-memory state
 * (pending / cached outcome) and falls back to a single `getTransaction`
 * lookup for hashes it has never seen.
 */

import { Router, Request, Response } from "express";
import { queryLimiter } from "../middleware/index.js";
import {
  getConfirmationStatus,
  getConfirmationQueueStats,
} from "../services/confirmation-queue.js";
import { getConfirmationHubStats } from "../services/confirmation-hub.js";

const router = Router();

// Stellar transaction hashes are 64 lowercase hex characters.
const TX_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * GET /tx/:hash
 * Confirmation status for a single transaction hash.
 *
 * Response:
 *   { hash, state, status?, attempts, elapsedMs, result?, error?, enqueuedAt?, confirmedAt? }
 *
 * state is one of: PENDING | CONFIRMED | FAILED | EXPIRED | UNKNOWN.
 */
router.get("/tx/:hash", queryLimiter, async (req: Request, res: Response) => {
  const hash = (req.params.hash ?? "").toLowerCase();
  if (!TX_HASH_RE.test(hash)) {
    return res
      .status(400)
      .json({ error: "Invalid transaction hash (expected 64 hex characters)" });
  }

  try {
    const status = await getConfirmationStatus(hash);
    res.json(status);
  } catch (err) {
    res.status(500).json({
      error: "Failed to resolve transaction status",
      message: (err as Error).message,
    });
  }
});

/**
 * GET /tx/stats
 * Diagnostics for the confirmation queue and WebSocket hub (no auth: only
 * aggregate counters are exposed, matching the /health pattern).
 */
router.get("/tx/stats", queryLimiter, (_req: Request, res: Response) => {
  res.json({
    queue: getConfirmationQueueStats(),
    websocket: getConfirmationHubStats(),
  });
});

export default router;
