/**
 * Admin Routes
 *
 * Read-only review of the audit log (append-only, hash-chained trail of
 * privileged actions recorded by middleware/audit.ts), plus a
 * privileged graceful-shutdown trigger for controlled restarts.
 */
import { Router, type Request, type Response } from "express";
import {
  authGuard,
  queryLimiter,
  bodyLimit,
  validateBody,
  validateQuery,
} from "../middleware/index.js";
import {
  getAuditLogs,
  verifyAuditChain,
  formatAsCef,
} from "../services/audit.js";
import { getEventsForDao } from "../services/db.js";
import { log } from "../services/logger.js";
import type { AsyncHandler } from "../types/index.js";
import {
  adminShutdownSchema,
  adminAuditLogQuerySchema,
  adminSbtTransferAttemptsQuerySchema,
} from "../validation/schemas.js";

const router = Router();

// ============================================
// GRACEFUL SHUTDOWN TRIGGER
// ============================================

type ShutdownHandler = (reason: string) => void | Promise<void>;

let shutdownHandler: ShutdownHandler | null = null;

/**
 * Wire the server's graceful-shutdown function to the /admin/shutdown
 * route. Called once at startup from index.ts.
 */
export function registerShutdownHandler(handler: ShutdownHandler): void {
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
router.post(
  "/admin/shutdown",
  bodyLimit("100kb"),
  authGuard,
  queryLimiter,
  validateBody(adminShutdownSchema),
  (async (req: Request, res: Response) => {
    if (!shutdownHandler) {
      res.status(503).json({ error: "Shutdown handler not available" });
      return;
    }

    const reason =
      typeof req.body?.reason === "string" ? req.body.reason : "admin_request";

    log("warn", "admin_shutdown_requested", { reason });

    res.status(202).json({ status: "shutting_down", reason });

    // Defer so the 202 flushes before the server stops accepting connections.
    setTimeout(() => {
      void shutdownHandler!(reason);
    }, 100);
  }) as AsyncHandler,
);

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
router.get(
  "/admin/audit-log",
  authGuard,
  queryLimiter,
  validateQuery(adminAuditLogQuerySchema),
  (async (req: Request, res: Response) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { limit, offset, action, format, verify } = (req as any)
        .validatedQuery;
      const includeVerification = verify === "true";
      const { logs, total } = getAuditLogs({ limit, offset, action });
      if (format === "cef") {
        res.type("text/plain").send(formatAsCef(logs));
        return;
      }
      const body: Record<string, unknown> = { logs, total, limit, offset };
      if (includeVerification) {
        body.chainVerification = verifyAuditChain();
      }
      res.json(body);
    } catch (err) {
      log("error", "admin_audit_log_failed", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to fetch audit log" });
    }
  }) as AsyncHandler,
);

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
router.get(
  "/admin/sbt-transfer-attempts",
  authGuard,
  queryLimiter,
  validateQuery(adminSbtTransferAttemptsQuerySchema),
  (async (req: Request, res: Response) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { daoId, limit, offset } = (req as any).validatedQuery;

    try {
      const { events, total } = getEventsForDao(daoId, {
        types: ["sbt_transfer_attempt"],
        limit,
        offset,
      });

      res.json({ daoId, attempts: events, total, limit, offset });
    } catch (err) {
      log("error", "admin_sbt_transfer_attempts_failed", {
        daoId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to fetch SBT transfer attempts" });
    }
  }) as AsyncHandler,
);

export default router;
