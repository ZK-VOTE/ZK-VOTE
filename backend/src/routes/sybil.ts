/**
 * Sybil-Resistance Routes (issue #301)
 *
 * Read-only helpers over the weight curve in `services/sybil.ts`. Nothing here
 * writes to the chain — the authoritative weight is enforced twice already, in
 * `membership-sbt` and inside the proof — so these endpoints exist so the UI
 * and DAO admins can see the same numbers without reimplementing the curve.
 *
 *   GET  /sybil/params               the curve parameters and the curve table
 *   POST /sybil/weight               weight for an (age, reputation) pair
 *   POST /sybil/simulate             what a Sybil attack actually buys
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { log } from "../services/logger.js";
import {
  queryLimiter,
  validateBody,
  bodyLimit,
} from "../middleware/index.js";
import type { AsyncHandler } from "../types/index.js";
import {
  computeWeight,
  ageDaysAt,
  analyzeSybilBound,
  weightCurveTable,
  weightCurveParams,
  MAX_REPUTATION,
} from "../services/sybil.js";

const router = Router();

// --- Validation schemas ---

const weightSchema = z
  .object({
    ageDays: z.number().int().min(0).max(36_500).optional(),
    mintedAt: z.number().int().min(0).optional(),
    snapshotTime: z.number().int().min(0).optional(),
    reputation: z.number().int().min(0).max(MAX_REPUTATION).default(0),
  })
  .refine((v) => v.ageDays !== undefined || v.mintedAt !== undefined, {
    message: "Provide either ageDays, or mintedAt (with optional snapshotTime)",
  });

const simulateSchema = z.object({
  sybilCount: z.number().int().min(0).max(1_000_000),
  sybilAgeDays: z.number().int().min(0).max(36_500).default(0),
  sybilReputation: z.number().int().min(0).max(MAX_REPUTATION).default(0),
  honestCount: z.number().int().min(0).max(1_000_000).default(100),
  honestAgeDays: z.number().int().min(0).max(36_500).default(365),
  honestReputation: z.number().int().min(0).max(MAX_REPUTATION).default(40),
});

/**
 * GET /sybil/params
 * The weight-curve parameters plus the curve rendered as a table.
 */
router.get(
  "/sybil/params",
  queryLimiter,
  (async (_req: Request, res: Response) => {
    return res.json({
      ...weightCurveParams(),
      curve: weightCurveTable(),
    });
  }) as AsyncHandler,
);

/**
 * POST /sybil/weight
 * Weight for a given SBT age and reputation. Age may be given directly, or as
 * a mint timestamp — in which case it is measured against `snapshotTime`,
 * defaulting to now, exactly as the circuit measures it against the election
 * snapshot.
 */
router.post(
  "/sybil/weight",
  bodyLimit("10kb"),
  queryLimiter,
  validateBody(weightSchema),
  (async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof weightSchema>;
    const snapshotTime =
      body.snapshotTime ?? Math.floor(Date.now() / 1000);
    const ageDays =
      body.ageDays ?? ageDaysAt(body.mintedAt as number, snapshotTime);

    const breakdown = computeWeight(ageDays, body.reputation);
    log("info", "sybil_weight", {
      ageDays: breakdown.ageDays,
      weight: breakdown.weight,
    });
    return res.json({ ...breakdown, snapshotTime });
  }) as AsyncHandler,
);

/**
 * POST /sybil/simulate
 * What a Sybil attack of a given size actually buys, against the flat
 * one-identity-one-vote baseline. This is the demonstration the issue asks for:
 * with fresh identities the attacker's share of voting weight is strictly lower
 * than their share of identities, and the gap is the curve's contribution.
 */
router.post(
  "/sybil/simulate",
  bodyLimit("10kb"),
  queryLimiter,
  validateBody(simulateSchema),
  (async (req: Request, res: Response) => {
    const scenario = req.body as z.infer<typeof simulateSchema>;
    const analysis = analyzeSybilBound(scenario);
    log("info", "sybil_simulate", {
      sybilCount: scenario.sybilCount,
      attackerShare: analysis.attackerShare,
    });
    return res.json(analysis);
  }) as AsyncHandler,
);

export default router;
