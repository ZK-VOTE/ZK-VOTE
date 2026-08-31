/**
 * E2E Encrypted Governance Content API (#324)
 *
 * `/api/v1/encryption` — key-epoch distribution and the ciphertext store for
 * proposal and comment bodies.
 *
 * Every handler is deliberately incapable of reading what it moves. Key
 * material arrives already sealed to its recipient, bodies arrive as complete
 * AES-GCM envelopes, and no route accepts a plaintext or a raw group key. If a
 * request could hand the relay something it could decrypt, that would be the
 * bug — not a convenience.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import {
  CONTENT_TYPES,
  ENVELOPE_VERSION,
  getActiveEpoch,
  getRecoveryShares,
  getWrappedKey,
  loadCiphertext,
  nextEpoch,
  recordGroupKeyEpoch,
  redactContent,
  redactEnvelopeForLog,
  storeCiphertext,
  type ContentEnvelope,
} from "../services/encryption.js";
import {
  authGuard,
  commentLimiter,
  queryLimiter,
  validateBody,
  validateParams,
} from "../middleware/index.js";
import { log } from "../services/logger.js";
import type { AsyncHandler } from "../types/index.js";

const router = Router();

const BASE = "/api/v1/encryption";

// ============================================
// SCHEMAS
// ============================================

const base64 = z
  .string()
  .min(1)
  .max(1_000_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Expected base64");

const daoParams = z.object({ daoId: z.coerce.number().int().nonnegative() });

const contentParams = z.object({
  daoId: z.coerce.number().int().nonnegative(),
  contentType: z.enum(CONTENT_TYPES),
  contentId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
});

const memberParams = daoParams.extend({
  memberId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
});

/**
 * A rotation submission. The relay validates shape and consistency only — it
 * cannot check that a wrap really contains the committed key, which is exactly
 * why `keyCommitment` is published for members to verify against.
 */
const rotationSchema = z.object({
  threshold: z.number().int().min(1).max(255),
  keyCommitment: z.string().regex(/^[0-9a-f]{64}$/, "Expected a SHA-256 hex digest"),
  rotationReason: z.enum([
    "genesis",
    "member_joined",
    "member_left",
    "member_revoked",
    "manual",
  ]),
  wraps: z
    .array(
      z.object({
        memberId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
        wrapped: base64,
      }),
    )
    .min(1)
    .max(2048),
  recoveryShares: z
    .array(z.object({ index: z.number().int().min(1).max(255), wrappedShare: base64 }))
    .max(255)
    .default([]),
});

const envelopeSchema = z.object({
  v: z.literal(ENVELOPE_VERSION),
  epoch: z.number().int().min(1),
  nonce: base64,
  ciphertext: base64,
  tag: base64,
});

const redactionSchema = z.object({
  reason: z.string().min(5).max(500),
});

/**
 * `validateParams` publishes its coerced output on the request rather than
 * mutating `req.params`, which is a getter under Express 5.
 */
function params<T>(req: Request): T {
  return (req as Request & { validatedParams: T }).validatedParams;
}

// ============================================
// KEY EPOCHS
// ============================================

/**
 * Current key epoch for a DAO.
 *
 * Public: the epoch number, member count, threshold and key commitment are all
 * metadata a client needs before it can even ask for its wrap, and none of them
 * narrow the key.
 */
router.get(
  `${BASE}/daos/:daoId/epoch`,
  queryLimiter,
  validateParams(daoParams),
  (async (req: Request, res: Response) => {
    const { daoId } = params<{ daoId: number }>(req);
    const epoch = getActiveEpoch(daoId);

    if (!epoch) {
      return res.status(404).json({ error: "No key epoch for this DAO" });
    }
    return res.json(epoch);
  }) as AsyncHandler,
);

/**
 * Publish a new key epoch (rotation).
 *
 * Authenticated because rotation is a membership-boundary change: an attacker
 * who could post an epoch of their own wraps would not learn any existing
 * plaintext, but would be able to convince clients to encrypt future content to
 * a key they hold.
 */
router.post(
  `${BASE}/daos/:daoId/epoch`,
  commentLimiter,
  authGuard,
  validateParams(daoParams),
  validateBody(rotationSchema),
  (async (req: Request, res: Response) => {
    const { daoId } = params<{ daoId: number }>(req);
    const body = req.body as z.infer<typeof rotationSchema>;

    if (body.threshold > body.recoveryShares.length && body.recoveryShares.length > 0) {
      return res.status(400).json({
        error: "Threshold exceeds the number of recovery shares supplied",
      });
    }

    try {
      const epochNumber = nextEpoch(daoId);
      const epoch = recordGroupKeyEpoch({
        daoId,
        epoch: epochNumber,
        threshold: body.threshold,
        keyCommitment: body.keyCommitment,
        rotationReason: body.rotationReason,
        wraps: body.wraps.map((wrap) => ({
          daoId,
          epoch: epochNumber,
          memberId: wrap.memberId,
          wrapped: wrap.wrapped,
        })),
        recoveryShares: body.recoveryShares,
      });

      return res.status(201).json(epoch);
    } catch (error) {
      log("error", "group_key_rotation_failed", {
        daoId,
        reason: body.rotationReason,
        error: (error as Error).message,
      });
      return res.status(500).json({ error: "Failed to record key epoch" });
    }
  }) as AsyncHandler,
);

/**
 * A member's sealed copy of the current group key.
 *
 * A non-member has no wrap, so this returns 404 — the relay has nothing to give
 * and no ability to synthesise one.
 */
router.get(
  `${BASE}/daos/:daoId/members/:memberId/key`,
  queryLimiter,
  authGuard,
  validateParams(memberParams),
  (async (req: Request, res: Response) => {
    const { daoId, memberId } = params<{ daoId: number; memberId: string }>(req);

    const epoch = getActiveEpoch(daoId);
    if (!epoch) {
      return res.status(404).json({ error: "No key epoch for this DAO" });
    }

    const wrapped = getWrappedKey(daoId, epoch.epoch, memberId);
    if (!wrapped) {
      log("warn", "group_key_wrap_missing", {
        daoId,
        epoch: epoch.epoch,
        memberId,
      });
      return res.status(404).json({ error: "No group key for this member" });
    }

    return res.json({
      daoId,
      epoch: epoch.epoch,
      keyCommitment: epoch.keyCommitment,
      wrapped: wrapped.wrapped,
    });
  }) as AsyncHandler,
);

/** Sealed recovery shares for an epoch, for a threshold reconstruction. */
router.get(
  `${BASE}/daos/:daoId/recovery-shares`,
  queryLimiter,
  authGuard,
  validateParams(daoParams),
  (async (req: Request, res: Response) => {
    const { daoId } = params<{ daoId: number }>(req);

    const epoch = getActiveEpoch(daoId);
    if (!epoch) {
      return res.status(404).json({ error: "No key epoch for this DAO" });
    }

    return res.json({
      daoId,
      epoch: epoch.epoch,
      threshold: epoch.threshold,
      shares: getRecoveryShares(daoId, epoch.epoch),
    });
  }) as AsyncHandler,
);

// ============================================
// CIPHERTEXT STORE
// ============================================

/** Store an encrypted proposal or comment body. */
router.put(
  `${BASE}/daos/:daoId/content/:contentType/:contentId`,
  commentLimiter,
  validateParams(contentParams),
  validateBody(envelopeSchema),
  (async (req: Request, res: Response) => {
    const { daoId, contentType, contentId } = params<{
      daoId: number;
      contentType: (typeof CONTENT_TYPES)[number];
      contentId: string;
    }>(req);
    const body = req.body as z.infer<typeof envelopeSchema>;

    const active = getActiveEpoch(daoId);
    if (!active) {
      return res.status(409).json({ error: "DAO has no key epoch yet" });
    }
    if (body.epoch !== active.epoch) {
      // Writing under a stale epoch would leave content unreadable by the
      // members who were just rotated in.
      return res.status(409).json({
        error: "Content must be encrypted to the active epoch",
        activeEpoch: active.epoch,
      });
    }

    const envelope: ContentEnvelope = {
      v: ENVELOPE_VERSION,
      daoId,
      epoch: body.epoch,
      contentType,
      contentId,
      nonce: body.nonce,
      ciphertext: body.ciphertext,
      tag: body.tag,
    };

    try {
      storeCiphertext(envelope);
      return res.status(201).json(redactEnvelopeForLog(envelope));
    } catch (error) {
      log("error", "encrypted_content_store_failed", {
        daoId,
        contentType,
        contentId,
        error: (error as Error).message,
      });
      return res.status(500).json({ error: "Failed to store content" });
    }
  }) as AsyncHandler,
);

/**
 * Fetch an encrypted body.
 *
 * Anyone may fetch the ciphertext; only a member holding the epoch key can open
 * it. Keeping the fetch open avoids turning read access into a membership
 * oracle. A redacted body returns 410 with its tombstone.
 */
router.get(
  `${BASE}/daos/:daoId/content/:contentType/:contentId`,
  queryLimiter,
  validateParams(contentParams),
  (async (req: Request, res: Response) => {
    const { daoId, contentType, contentId } = params<{
      daoId: number;
      contentType: (typeof CONTENT_TYPES)[number];
      contentId: string;
    }>(req);

    const stored = loadCiphertext(daoId, contentType, contentId);
    if (!stored) return res.status(404).json({ error: "Content not found" });

    if (stored.redacted || !stored.envelope) {
      return res.status(410).json({
        error: "Content was redacted",
        redactedAt: stored.redactedAt,
        reason: stored.redactionReason,
      });
    }

    return res.json(stored.envelope);
  }) as AsyncHandler,
);

/**
 * Redact a stored body.
 *
 * Operator-scoped, and irreversible: the ciphertext columns are overwritten,
 * so this is the relay's only meaningful erasure primitive for content it
 * cannot read.
 */
router.delete(
  `${BASE}/daos/:daoId/content/:contentType/:contentId`,
  commentLimiter,
  authGuard,
  validateParams(contentParams),
  validateBody(redactionSchema),
  (async (req: Request, res: Response) => {
    const { daoId, contentType, contentId } = params<{
      daoId: number;
      contentType: (typeof CONTENT_TYPES)[number];
      contentId: string;
    }>(req);
    const { reason } = req.body as z.infer<typeof redactionSchema>;

    const redactedNow = redactContent(daoId, contentType, contentId, reason);
    if (!redactedNow) {
      const stored = loadCiphertext(daoId, contentType, contentId);
      if (!stored) return res.status(404).json({ error: "Content not found" });
      // Already redacted — report the existing tombstone rather than churn it.
      return res.status(200).json({
        daoId,
        contentType,
        contentId,
        redacted: true,
        redactedAt: stored.redactedAt,
        reason: stored.redactionReason,
      });
    }

    const stored = loadCiphertext(daoId, contentType, contentId);
    return res.status(200).json({
      daoId,
      contentType,
      contentId,
      redacted: true,
      redactedAt: stored?.redactedAt ?? null,
      reason,
    });
  }) as AsyncHandler,
);

export default router;
