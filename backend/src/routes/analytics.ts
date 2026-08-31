/**
 * Privacy-Preserving Analytics Routes (issue #306)
 *
 * Exposes homomorphic tally aggregation with threshold-decrypt-of-aggregate-only
 * semantics and a per-DAO privacy budget:
 *
 *   POST  /analytics/init            Initialize an analytics aggregate for a DAO.
 *   POST  /analytics/accumulate      Fold one encrypted participation contribution
 *                                    into the DAO aggregate (homomorphic addition).
 *   GET   /analytics/state/:daoId    View encrypted aggregate + cohort size (never
 *                                    decrypts per-voter data).
 *   GET   /analytics/budget/:daoId   View the DAO's privacy budget accounting.
 *   POST  /analytics/decrypt         Threshold-decrypt the aggregate only, subject
 *                                    to threshold / k-anonymity / budget guards.
 *   POST  /analytics/budget/reset    Reset the DAO's privacy budget window (admin).
 */

import { Router, type Request, type Response } from "express";

import { log } from "../services/logger.js";
import { authGuard, auditLog, bodyLimit } from "../middleware/index.js";
import type { AsyncHandler } from "../types/index.js";
import * as analytics from "../services/privacy-analytics.js";

const router = Router();

/**
 * POST /analytics/init
 * Initialize an encrypted analytics aggregate for a DAO under a DKG joint key.
 */
router.post(
  "/analytics/init",
  bodyLimit("100kb"),
  authGuard,
  auditLog("analytics_init"),
  (async (req: Request, res: Response) => {
    const { daoId, jointPublicKey, thresholdT, thresholdN, minCohort, epsilonPerQuery, epsilonBudget } =
      req.body;

    try {
      const state = analytics.initializeAnalytics({
        daoId: Number(daoId),
        jointPublicKey: String(jointPublicKey),
        thresholdT: Number(thresholdT),
        thresholdN: Number(thresholdN),
        minCohort: minCohort != null ? Number(minCohort) : undefined,
        epsilonPerQuery: epsilonPerQuery != null ? Number(epsilonPerQuery) : undefined,
        epsilonBudget: epsilonBudget != null ? Number(epsilonBudget) : undefined,
      });

      res.json({ success: true, state });
    } catch (err) {
      log("error", "analytics_init_failed", {
        error: (err as Error).message,
        daoId,
      });
      res.status(400).json({ error: (err as Error).message });
    }
  }) as AsyncHandler,
);

/**
 * POST /analytics/accumulate
 * Fold one encrypted participation contribution into the DAO aggregate.
 * Expected body: { daoId, c1, c2 } where (c1, c2) is an ElGamal ciphertext of 1.
 */
router.post(
  "/analytics/accumulate",
  bodyLimit("10kb"),
  authGuard,
  auditLog("analytics_accumulate"),
  (async (req: Request, res: Response) => {
    const { daoId, c1, c2 } = req.body;

    try {
      if (!c1 || !c2 || typeof c1 !== "string" || typeof c2 !== "string") {
        return res.status(400).json({ error: "c1 and c2 ciphertext strings are required" });
      }
      const state = analytics.accumulateContribution(Number(daoId), { c1, c2 });
      res.json({ success: true, state });
    } catch (err) {
      log("error", "analytics_accumulate_failed", {
        error: (err as Error).message,
        daoId,
      });
      res.status(400).json({ error: (err as Error).message });
    }
  }) as AsyncHandler,
);

/**
 * GET /analytics/state/:daoId
 * View the encrypted aggregate + cohort size. Never reveals per-voter values.
 */
router.get("/analytics/state/:daoId", (async (req: Request, res: Response) => {
  const { daoId } = req.params;
  try {
    const state = analytics.getState(Number(daoId));
    res.json({ success: true, state });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
}) as AsyncHandler);

/**
 * GET /analytics/budget/:daoId
 * View the DAO's privacy budget accounting.
 */
router.get("/analytics/budget/:daoId", (async (req: Request, res: Response) => {
  const { daoId } = req.params;
  try {
    const budget = analytics.getPrivacyBudget(Number(daoId));
    res.json({ success: true, budget });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}) as AsyncHandler);

/**
 * POST /analytics/decrypt
 * Threshold-decrypt the aggregate only. Body: { daoId, shares: [{ authorityIndex, shareHex }] }
 */
router.post(
  "/analytics/decrypt",
  bodyLimit("100kb"),
  authGuard,
  auditLog("analytics_decrypt"),
  (async (req: Request, res: Response) => {
    const { daoId, shares } = req.body;

    try {
      if (!Array.isArray(shares) || shares.length === 0) {
        return res.status(400).json({ error: "shares array is required" });
      }
      const result = analytics.thresholdDecryptAggregate(Number(daoId), shares);
      res.json({ success: true, result });
    } catch (err) {
      log("error", "analytics_decrypt_failed", {
        error: (err as Error).message,
        daoId,
      });
      res.status(400).json({ error: (err as Error).message });
    }
  }) as AsyncHandler,
);

/**
 * POST /analytics/budget/reset
 * Reset the DAO's privacy budget window (admin).
 */
router.post(
  "/analytics/budget/reset",
  bodyLimit("1kb"),
  authGuard,
  auditLog("analytics_budget_reset"),
  (async (req: Request, res: Response) => {
    const { daoId, epsilonBudget } = req.body;
    try {
      const budget = analytics.resetPrivacyBudget(
        Number(daoId),
        epsilonBudget != null ? Number(epsilonBudget) : undefined,
      );
      res.json({ success: true, budget });
    } catch (err) {
      log("error", "analytics_budget_reset_failed", {
        error: (err as Error).message,
        daoId,
      });
      res.status(400).json({ error: (err as Error).message });
    }
  }) as AsyncHandler,
);

/**
 * GET /analytics/status — overview of the analytics subsystem.
 */
router.get("/analytics/status", (async (_req: Request, res: Response) => {
  res.json({
    success: true,
    feature: "privacy-preserving-analytics",
    curve: "BN254",
    semantics: "homomorphic-elgamal",
    decryptScope: "aggregate-only",
    issue: 306,
  });
}) as AsyncHandler);

export default router;
