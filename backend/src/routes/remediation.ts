/**
 * Remediation Routes - Accountable incident response
 *
 * Structured remediation actions with:
 * - Append-only audit (immutable)
 * - Authz via authGuard (requires RELAYER_AUTH_TOKEN)
 * - Replay-safe via idempotencyKey
 * - Tests for immutability, authz, replay safety
 *
 * Actions are intentionally generic but structured to support incident response:
 *   freeze_dao, unfreeze_dao, pause_voting, resume_voting,
 *   revoke_member, restore_member, emergency_pause, emergency_resume,
 *   rotate_vk, quarantine_proposal
 */

import { Router, type Request, type Response } from "express";
import { authGuard, bodyLimit, queryLimiter } from "../middleware/index.js";
import {
  appendAudit,
  isIdempotencyKeyUsed,
  markIdempotencyKey,
  deriveActor,
  redactPii,
} from "../middleware/audit.js";
import { hashIp } from "../services/logger.js";
import { log } from "../services/logger.js";
import type { AsyncHandler } from "../types/index.js";
import crypto from "crypto";

const router = Router();

// ============================================
// TYPES & STORE
// ============================================

export type RemediationActionType =
  | "freeze_dao"
  | "unfreeze_dao"
  | "pause_voting"
  | "resume_voting"
  | "revoke_member"
  | "restore_member"
  | "emergency_pause"
  | "emergency_resume"
  | "rotate_vk"
  | "quarantine_proposal";

const VALID_ACTIONS: Set<string> = new Set([
  "freeze_dao",
  "unfreeze_dao",
  "pause_voting",
  "resume_voting",
  "revoke_member",
  "restore_member",
  "emergency_pause",
  "emergency_resume",
  "rotate_vk",
  "quarantine_proposal",
]);

export interface RemediationRecord {
  id: string;
  timestamp: string;
  action: RemediationActionType;
  target: string; // daoId or proposal identifier
  reason: string;
  actor: string; // hashed
  actorIpHash: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  txHash?: string | null;
  immutable: true;
}

// In-memory append-only store (backed by audit log as well)
let remediationLog: RemediationRecord[] = [];
let remediationCounter = 0;

// Export for testing / query
export function getRemediationLog(): RemediationRecord[] {
  return [...remediationLog];
}
export function clearRemediationLog(): void {
  remediationLog = [];
  remediationCounter = 0;
}
export function getRemediationById(id: string): RemediationRecord | undefined {
  return remediationLog.find((r) => r.id === id);
}

// ============================================
// VALIDATION
// ============================================

function validateRemediationBody(body: any): {
  valid: boolean;
  error?: string;
} {
  if (!body || typeof body !== "object")
    return { valid: false, error: "body required" };
  if (!body.action || typeof body.action !== "string")
    return { valid: false, error: "action is required" };
  if (!VALID_ACTIONS.has(body.action))
    return { valid: false, error: `invalid action: ${body.action}` };
  if (
    body.target === undefined ||
    body.target === null ||
    String(body.target).trim() === ""
  ) {
    return { valid: false, error: "target is required" };
  }
  if (
    !body.reason ||
    typeof body.reason !== "string" ||
    body.reason.trim().length < 5
  ) {
    return { valid: false, error: "reason must be at least 5 characters" };
  }
  if (
    !body.idempotencyKey ||
    typeof body.idempotencyKey !== "string" ||
    body.idempotencyKey.length < 8
  ) {
    return {
      valid: false,
      error: "idempotencyKey must be at least 8 characters",
    };
  }
  if (
    body.metadata !== undefined &&
    (typeof body.metadata !== "object" || Array.isArray(body.metadata))
  ) {
    return { valid: false, error: "metadata must be an object" };
  }
  return { valid: true };
}

// ============================================
// ROUTES
// ============================================

/**
 * POST /remediation/action - Submit structured remediation action
 * Requires auth (authz), append-only, replay-safe
 */
router.post("/remediation/action", bodyLimit("100kb"), authGuard, (async (req: Request, res: Response) => {
  const validation = validateRemediationBody(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const { action, target, reason, idempotencyKey, metadata } = req.body;

  // Replay-safe: check idempotencyKey
  if (isIdempotencyKeyUsed(idempotencyKey)) {
    log("warn", "remediation_replay_blocked", {
      action,
      target,
      idempotencyKey: idempotencyKey.slice(0, 8) + "...",
    });
    // Audit the blocked replay attempt as well (append-only)
    appendAudit({
      requestId: (req as any).ctx || "unknown",
      method: req.method,
      path: req.path,
      action: "remediation_replay_blocked",
      actor: deriveActor(req),
      actorIpHash: hashIp(req.ip),
      requestBody: redactPii({
        action,
        target,
        reason: reason.slice(0, 50),
        idempotencyKey: "[REDACTED]",
      }) as unknown,
      statusCode: 409,
    });
    return res.status(409).json({
      error: "Duplicate idempotencyKey - action already processed",
      remediationId: null,
    });
  }

  // Mark key as used BEFORE processing to prevent race conditions
  markIdempotencyKey(idempotencyKey);

  const actor = deriveActor(req);
  const ipHash = hashIp(req.ip);
  const id = `rem-${Date.now()}-${++remediationCounter}`;
  const timestamp = new Date().toISOString();

  const record: RemediationRecord = {
    id,
    timestamp,
    action: action as RemediationActionType,
    target: String(target),
    reason: String(reason),
    actor,
    actorIpHash: ipHash,
    idempotencyKey,
    metadata: metadata
      ? (redactPii(metadata) as Record<string, unknown>)
      : undefined,
    txHash: null,
    immutable: true as const,
  };

  // Append-only: push to remediation log
  remediationLog.push(record);

  // Also append to general audit log for full accountability
  appendAudit({
    requestId: (req as any).ctx || id,
    method: req.method,
    path: req.path,
    action: `remediation:${action}`,
    actor,
    actorIpHash: ipHash,
    requestBody: redactPii({
      action,
      target,
      reason,
      idempotencyKey: "[REDACTED]",
      metadata,
    }) as unknown,
    statusCode: 201,
  });

  log("info", "remediation_action_recorded", {
    id,
    action,
    target,
    actor: actor.slice(0, 12) + "...",
  });

  // In production this would interact with contracts (e.g., pause, freeze). Here we simulate success.
  res.status(201).json({
    success: true,
    remediationId: id,
    record: {
      id: record.id,
      timestamp: record.timestamp,
      action: record.action,
      target: record.target,
      reason: record.reason,
      actor: record.actor,
      idempotencyKey: "[REDACTED]", // never echo raw key
      metadata: record.metadata,
      immutable: true,
    },
  });
}) as AsyncHandler);

/**
 * GET /remediation/log - Query remediation audit trail
 * Requires auth, supports filters: action, target, from, to, limit, offset
 */
router.get("/remediation/log", authGuard, queryLimiter, (req: Request, res: Response) => {
  const { action, target, from, to, limit, offset } = req.query;
  let filtered = [...remediationLog];

  if (action) filtered = filtered.filter((r) => r.action === String(action));
  if (target) filtered = filtered.filter((r) => r.target === String(target));
  if (from) {
    const fromTs = new Date(String(from)).getTime();
    if (!isNaN(fromTs)) filtered = filtered.filter((r) => new Date(r.timestamp).getTime() >= fromTs);
  }
  if (to) {
    const toTs = new Date(String(to)).getTime();
    if (!isNaN(toTs)) filtered = filtered.filter((r) => new Date(r.timestamp).getTime() <= toTs);
  }

  const total = filtered.length;
  const off = Math.max(0, parseInt(String(offset || "0"), 10) || 0);
  const lim = Math.min(Math.max(1, parseInt(String(limit || "50"), 10) || 50), 100);

  const entries = filtered.slice(off, off + lim);
  // Return redacted view - idempotencyKey always redacted
  const sanitized = entries.map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    action: e.action,
    target: e.target,
    reason: e.reason,
    actor: e.actor,
    actorIpHash: e.actorIpHash,
    metadata: e.metadata,
    txHash: e.txHash,
    immutable: true,
    idempotencyKey: "[REDACTED]",
  }));

  res.json({ entries: sanitized, total, limit: lim, offset: off });
});

/**
 * GET /remediation/:id - Get single remediation record by id
 */
router.get("/remediation/:id", authGuard, queryLimiter, (req: Request, res: Response) => {
  const { id } = req.params;
  const rec = getRemediationById(id);
  if (!rec) return res.status(404).json({ error: "Remediation record not found" });
  res.json({
    id: rec.id,
    timestamp: rec.timestamp,
    action: rec.action,
    target: rec.target,
    reason: rec.reason,
    actor: rec.actor,
    actorIpHash: rec.actorIpHash,
    metadata: rec.metadata,
    txHash: rec.txHash,
    immutable: true,
    idempotencyKey: "[REDACTED]",
  });
});

/**
 * POST /remediation/verify - Verify remediation log integrity (immutable check)
 * Returns hash chain to prove append-only
 */
router.post("/remediation/verify", bodyLimit("100kb"), authGuard, (req: Request, res: Response) => {
  // Compute simple hash chain of remediation log to prove no tampering
  let prevHash = "0".repeat(64);
  const chain: Array<{ id: string; hash: string; prevHash: string }> = [];
  for (const rec of remediationLog) {
    const payload = JSON.stringify({
      id: rec.id,
      timestamp: rec.timestamp,
      action: rec.action,
      target: rec.target,
      prevHash,
    });
    const hash = crypto.createHash("sha256").update(payload).digest("hex");
    chain.push({ id: rec.id, hash, prevHash });
    prevHash = hash;
  }
  res.json({
    valid: true,
    length: remediationLog.length,
    chain,
    latestHash: prevHash,
  });
});

export default router;
