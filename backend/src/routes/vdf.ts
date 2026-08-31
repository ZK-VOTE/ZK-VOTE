/**
 * VDF Commit–Reveal Routes (issue #302)
 *
 * Client-side helpers for the VDF-gated commit–reveal voting flow. The relay
 * never learns a voter's choice from these endpoints: commitments are computed
 * from values the caller supplies, and the blinding factor is generated
 * client-side for the real flow. `POST /vdf/commitment` exists so a client
 * without a crypto implementation can still participate, and its response makes
 * the blinding's role explicit.
 *
 *   GET  /vdf/profiles          delay profiles and the latency/security tradeoff
 *   GET  /vdf/cost-analysis     what VDF verification costs on Soroban
 *   POST /vdf/commitment        compute a vote commitment (+ optional blinding)
 *   POST /vdf/commitment/verify check a reveal against a commitment
 *   POST /vdf/benchmark         measure VDF throughput on this host
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { log } from "../services/logger.js";
import {
  queryLimiter,
  voteLimiter,
  validateBody,
  bodyLimit,
} from "../middleware/index.js";
import type { AsyncHandler } from "../types/index.js";
import {
  computeVoteCommitment,
  createVoteCommitment,
  verifyVoteCommitment,
  delayProfiles,
  commitRevealCostAnalysis,
  benchmarkVdf,
  MIN_BLINDING_BYTES,
  MIN_VDF_ITERATIONS,
  MAX_VDF_ITERATIONS,
  MAX_ON_CHAIN_HASHES,
  SOROBAN_CPU_BUDGET,
  SHA256_COST_INSTRUCTIONS,
  ASSUMED_ATTACKER_SPEEDUP,
} from "../services/vdf.js";

const router = Router();

const commitmentSchema = z.object({
  daoId: z.number().int().nonnegative(),
  proposalId: z.number().int().nonnegative(),
  choice: z.number().int().min(0).max(65_535),
  /** Omit to have the relay generate one. Supply your own for a flow where the
   *  relay must never be able to open the commitment. */
  blinding: z
    .string()
    .regex(/^[0-9a-fA-F]+$/)
    .min(MIN_BLINDING_BYTES * 2)
    .optional(),
});

const verifySchema = z.object({
  commitment: z.string().regex(/^[0-9a-fA-F]{64}$/),
  daoId: z.number().int().nonnegative(),
  proposalId: z.number().int().nonnegative(),
  choice: z.number().int().min(0).max(65_535),
  blinding: z.string().regex(/^[0-9a-fA-F]+$/),
});

const benchmarkSchema = z.object({
  iterations: z
    .array(z.number().int().min(MIN_VDF_ITERATIONS).max(MAX_VDF_ITERATIONS))
    .min(1)
    .max(6),
});

/**
 * GET /vdf/profiles
 * The delay profiles and what each buys, so a DAO admin can pick a point on the
 * latency/security curve with the numbers in front of them.
 */
router.get(
  "/vdf/profiles",
  queryLimiter,
  (async (_req: Request, res: Response) => {
    return res.json({
      assumedAttackerSpeedup: ASSUMED_ATTACKER_SPEEDUP,
      profiles: delayProfiles(),
    });
  }) as AsyncHandler,
);

/**
 * GET /vdf/cost-analysis
 * On-chain verification cost per profile, against the Soroban CPU budget.
 */
router.get(
  "/vdf/cost-analysis",
  queryLimiter,
  (async (_req: Request, res: Response) => {
    return res.json({
      sorobanCpuBudget: SOROBAN_CPU_BUDGET,
      sha256CostInstructions: SHA256_COST_INSTRUCTIONS,
      maxOnChainHashes: MAX_ON_CHAIN_HASHES,
      analysis: commitRevealCostAnalysis(),
    });
  }) as AsyncHandler,
);

/**
 * POST /vdf/commitment
 * Compute a vote commitment.
 *
 * When `blinding` is supplied the relay only hashes — it cannot open the
 * commitment, because it never sees the choice again. When it is omitted the
 * relay generates one and returns it; the response says plainly that the caller
 * must store it, since without it the vote can never be revealed.
 */
router.post(
  "/vdf/commitment",
  bodyLimit("10kb"),
  voteLimiter,
  validateBody(commitmentSchema),
  (async (req: Request, res: Response) => {
    const { daoId, proposalId, choice, blinding } = req.body as z.infer<
      typeof commitmentSchema
    >;

    if (blinding) {
      const commitment = computeVoteCommitment(
        daoId,
        proposalId,
        choice,
        blinding,
      );
      log("info", "vdf_commitment_computed", { daoId, proposalId });
      return res.json({ commitment, daoId, proposalId, blindingGenerated: false });
    }

    const generated = createVoteCommitment(daoId, proposalId, choice);
    log("info", "vdf_commitment_generated", { daoId, proposalId });
    return res.json({
      commitment: generated.commitment,
      blinding: generated.blinding,
      daoId,
      proposalId,
      blindingGenerated: true,
      warning:
        "Store this blinding factor. The vote cannot be revealed without it, " +
        "and it is not retained by the relay.",
    });
  }) as AsyncHandler,
);

/**
 * POST /vdf/commitment/verify
 * Check that an opening matches a published commitment, before spending gas on
 * an on-chain reveal that would revert.
 */
router.post(
  "/vdf/commitment/verify",
  bodyLimit("10kb"),
  queryLimiter,
  validateBody(verifySchema),
  (async (req: Request, res: Response) => {
    const { commitment, daoId, proposalId, choice, blinding } =
      req.body as z.infer<typeof verifySchema>;
    const valid = verifyVoteCommitment(
      commitment,
      daoId,
      proposalId,
      choice,
      blinding,
    );
    log("info", "vdf_commitment_verified", { daoId, proposalId, valid });
    return res.json({ valid, daoId, proposalId });
  }) as AsyncHandler,
);

/**
 * POST /vdf/benchmark
 * Measure VDF throughput on this host. The delay profiles are derived from a
 * reference hash rate; this is how a deployment calibrates them against its own
 * hardware instead of trusting the default.
 */
router.post(
  "/vdf/benchmark",
  bodyLimit("10kb"),
  queryLimiter,
  validateBody(benchmarkSchema),
  (async (req: Request, res: Response) => {
    const { iterations } = req.body as z.infer<typeof benchmarkSchema>;
    const results = benchmarkVdf(iterations);
    const totalIterations = results.reduce((s, r) => s + r.iterations, 0);
    const totalMs = results.reduce((s, r) => s + r.computeTimeMs, 0);
    const hashesPerSec = totalMs === 0 ? 0 : (totalIterations / totalMs) * 1000;

    log("info", "vdf_benchmark", { hashesPerSec: Math.round(hashesPerSec) });
    return res.json({
      results,
      hashesPerSec: Math.round(hashesPerSec),
      calibratedProfiles: delayProfiles(hashesPerSec || undefined),
    });
  }) as AsyncHandler,
);

export default router;
