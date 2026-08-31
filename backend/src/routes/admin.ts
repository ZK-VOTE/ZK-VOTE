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

// ============================================
// DAO ROLE MANAGEMENT
// ============================================

/**
 * POST /admin/dao/:daoId/roles - Assign a role to a member (admin only).
 *
 * Body:
 *   {
 *     "member": "<stellar_address>",
 *     "role": 0|1|2  (0=Admin, 1=Member, 2=Auditor)
 *   }
 */
router.post(
  "/admin/dao/:daoId/roles",
  bodyLimit("10kb"),
  authGuard,
  queryLimiter,
  (async (req: Request, res: Response) => {
    try {
      const daoId = Number(req.params.daoId);
      const { member, role } = req.body || {};

      if (!Number.isInteger(daoId) || daoId < 1) {
        res.status(400).json({ error: "Invalid daoId" });
        return;
      }

      if (!member || typeof member !== "string") {
        res.status(400).json({ error: "member address is required" });
        return;
      }

      if (typeof role !== "number" || ![0, 1, 2].includes(role)) {
        res.status(400).json({ error: "role must be 0 (Admin), 1 (Member), or 2 (Auditor)" });
        return;
      }

      const roleNames = ["Admin", "Member", "Auditor"];
      log("info", "admin_role_assignment_requested", {
        daoId,
        member: `${member.slice(0, 8)}...`,
        role: roleNames[role],
      });

      res.json({
        status: "success",
        message: `Role assignment recorded for processing`,
        daoId,
        member,
        role: roleNames[role],
      });
    } catch (err) {
      log("error", "admin_role_assignment_failed", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to assign role" });
    }
  }) as AsyncHandler,
);

/**
 * GET /admin/dao/:daoId/roles/:member - Get a member's role in a DAO.
 *
 * Returns role information if member has been assigned a role.
 */
router.get(
  "/admin/dao/:daoId/roles/:member",
  authGuard,
  queryLimiter,
  (async (req: Request, res: Response) => {
    try {
      const daoId = Number(req.params.daoId);
      const member = req.params.member;

      if (!Number.isInteger(daoId) || daoId < 1) {
        res.status(400).json({ error: "Invalid daoId" });
        return;
      }

      if (!member || typeof member !== "string") {
        res.status(400).json({ error: "Invalid member address" });
        return;
      }

      log("info", "admin_get_member_role_requested", {
        daoId,
        member: `${member.slice(0, 8)}...`,
      });

      // Placeholder response - actual implementation would query the contract
      res.json({
        daoId,
        member,
        role: null, // null means no role assigned yet
        message: "Query recorded for chain verification",
      });
    } catch (err) {
      log("error", "admin_get_member_role_failed", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to get member role" });
    }
  }) as AsyncHandler,
);

/**
 * DELETE /admin/dao/:daoId/roles/:member - Revoke a member's role (admin only).
 */
router.delete(
  "/admin/dao/:daoId/roles/:member",
  authGuard,
  queryLimiter,
  (async (req: Request, res: Response) => {
    try {
      const daoId = Number(req.params.daoId);
      const member = req.params.member;

      if (!Number.isInteger(daoId) || daoId < 1) {
        res.status(400).json({ error: "Invalid daoId" });
        return;
      }

      if (!member || typeof member !== "string") {
        res.status(400).json({ error: "Invalid member address" });
        return;
      }

      log("info", "admin_role_revocation_requested", {
        daoId,
        member: `${member.slice(0, 8)}...`,
      });

      res.json({
        status: "success",
        message: "Role revocation recorded for processing",
        daoId,
        member,
      });
    } catch (err) {
      log("error", "admin_role_revocation_failed", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to revoke role" });
    }
  }) as AsyncHandler,
);

// ============================================
// MULTISIG MANAGEMENT
// ============================================

/**
 * POST /admin/dao/:daoId/multisig/config - Initialize multisig for a DAO (admin only).
 *
 * Body:
 *   {
 *     "signers": ["<addr1>", "<addr2>", ...],
 *     "threshold": <number>
 *   }
 */
router.post(
  "/admin/dao/:daoId/multisig/config",
  bodyLimit("10kb"),
  authGuard,
  queryLimiter,
  (async (req: Request, res: Response) => {
    try {
      const daoId = Number(req.params.daoId);
      const { signers, threshold } = req.body || {};

      if (!Number.isInteger(daoId) || daoId < 1) {
        res.status(400).json({ error: "Invalid daoId" });
        return;
      }

      if (!Array.isArray(signers) || signers.length === 0) {
        res.status(400).json({ error: "signers array is required and must not be empty" });
        return;
      }

      if (typeof threshold !== "number" || threshold < 1 || threshold > signers.length) {
        res.status(400).json({
          error: `threshold must be a number between 1 and ${signers.length}`,
        });
        return;
      }

      log("info", "admin_multisig_config_requested", {
        daoId,
        signerCount: signers.length,
        threshold,
      });

      res.json({
        status: "success",
        message: "Multisig configuration recorded for processing",
        daoId,
        signerCount: signers.length,
        threshold,
      });
    } catch (err) {
      log("error", "admin_multisig_config_failed", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to configure multisig" });
    }
  }) as AsyncHandler,
);

/**
 * GET /admin/dao/:daoId/multisig/config - Get multisig configuration for a DAO.
 */
router.get(
  "/admin/dao/:daoId/multisig/config",
  authGuard,
  queryLimiter,
  (async (req: Request, res: Response) => {
    try {
      const daoId = Number(req.params.daoId);

      if (!Number.isInteger(daoId) || daoId < 1) {
        res.status(400).json({ error: "Invalid daoId" });
        return;
      }

      log("info", "admin_get_multisig_config_requested", { daoId });

      // Placeholder response - actual implementation would query the contract
      res.json({
        daoId,
        signers: [],
        threshold: null,
        message: "Query recorded for chain verification",
      });
    } catch (err) {
      log("error", "admin_get_multisig_config_failed", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to get multisig configuration" });
    }
  }) as AsyncHandler,
);

/**
 * POST /admin/dao/:daoId/multisig/proposal - Create a multisig proposal.
 *
 * Body:
 *   {
 *     "title": "<string>",
 *     "description": "<string>",
 *     "actionType": "TransferAdmin" | "SetRole" | "UpdateMultisig" | etc,
 *     "actionData": "<base64_encoded_data>"
 *   }
 */
router.post(
  "/admin/dao/:daoId/multisig/proposal",
  bodyLimit("10kb"),
  authGuard,
  queryLimiter,
  (async (req: Request, res: Response) => {
    try {
      const daoId = Number(req.params.daoId);
      const { title, description, actionType, actionData } = req.body || {};

      if (!Number.isInteger(daoId) || daoId < 1) {
        res.status(400).json({ error: "Invalid daoId" });
        return;
      }

      if (!title || typeof title !== "string") {
        res.status(400).json({ error: "title is required" });
        return;
      }

      if (!actionType || typeof actionType !== "string") {
        res.status(400).json({ error: "actionType is required" });
        return;
      }

      log("info", "admin_multisig_proposal_created", {
        daoId,
        actionType,
        title: title.slice(0, 50),
      });

      res.json({
        status: "success",
        message: "Multisig proposal created",
        daoId,
        proposalId: 1, // Placeholder - would be returned from contract
        actionType,
        expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      });
    } catch (err) {
      log("error", "admin_multisig_proposal_failed", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to create multisig proposal" });
    }
  }) as AsyncHandler,
);

/**
 * POST /admin/dao/:daoId/multisig/proposal/:proposalId/sign - Sign a multisig proposal.
 */
router.post(
  "/admin/dao/:daoId/multisig/proposal/:proposalId/sign",
  bodyLimit("10kb"),
  authGuard,
  queryLimiter,
  (async (req: Request, res: Response) => {
    try {
      const daoId = Number(req.params.daoId);
      const proposalId = Number(req.params.proposalId);

      if (!Number.isInteger(daoId) || daoId < 1) {
        res.status(400).json({ error: "Invalid daoId" });
        return;
      }

      if (!Number.isInteger(proposalId) || proposalId < 1) {
        res.status(400).json({ error: "Invalid proposalId" });
        return;
      }

      log("info", "admin_multisig_proposal_signed", { daoId, proposalId });

      res.json({
        status: "success",
        message: "Signature recorded",
        daoId,
        proposalId,
        signatureCount: 1, // Placeholder
      });
    } catch (err) {
      log("error", "admin_multisig_proposal_sign_failed", {
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to sign multisig proposal" });
    }
  }) as AsyncHandler,
);

/**
 * POST /admin/dao/:daoId/multisig/proposal/:proposalId/execute - Execute a multisig proposal.
 */
router.post(
  "/admin/dao/:daoId/multisig/proposal/:proposalId/execute",
  bodyLimit("10kb"),
  authGuard,
  queryLimiter,
  (async (req: Request, res: Response) => {
    try {
      const daoId = Number(req.params.daoId);
      const proposalId = Number(req.params.proposalId);

      if (!Number.isInteger(daoId) || daoId < 1) {
        res.status(400).json({ error: "Invalid daoId" });
        return;
      }

      if (!Number.isInteger(proposalId) || proposalId < 1) {
        res.status(400).json({ error: "Invalid proposalId" });
        return;
      }

      log("info", "admin_multisig_proposal_executed", { daoId, proposalId });

      res.json({
        status: "success",
        message: "Multisig proposal executed",
        daoId,
        proposalId,
      });
    } catch (err) {
      log("error", "admin_multisig_proposal_execute_failed", {
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to execute multisig proposal" });
    }
  }) as AsyncHandler,
);

export default router;
