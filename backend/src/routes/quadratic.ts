/**
 * Quadratic Voting Routes (issue #50)
 *
 * Stateless helpers for the ZK quadratic-voting flow:
 *
 *   POST /qv/proposals/:dao/calculate
 *     Given a member's intended allocation of voice credits across proposals,
 *     compute the quadratic cost (sum of squares), the per-proposal breakdown,
 *     and whether it fits within the fixed budget. This is what the frontend
 *     calls as the budget sliders move, and what it feeds into proof generation.
 *
 *   POST /qv/tally
 *     Aggregate the revealed allocations from many ballots into per-proposal
 *     voice-credit totals. Individual ballots stay private on-chain; the tally
 *     service sums the reveals off-chain, producing the totals that are then
 *     committed on-chain via the voting contract's `record_qv_tally`.
 *
 * These endpoints are pure computation (no chain writes) so they can be unit
 * tested and reused by the tally service and the frontend.
 */

import { Router, type Request, type Response } from "express";

import { log } from "../services/logger.js";
import {
  queryLimiter,
  validateBody,
  validateParams,
  bodyLimit,
} from "../middleware/index.js";
import {
  QV_MAX_BUDGET,
  QV_MAX_CREDITS,
  qvParamsSchema,
  qvCalculateSchema,
  qvTallySchema,
  type QvCalculateRequest,
  type QvTallyRequest,
} from "../validation/schemas.js";
import type { AsyncHandler } from "../types/index.js";

export { QV_MAX_BUDGET, QV_MAX_CREDITS };

const router = Router();

export interface QvAllocation {
  proposalId: number;
  voiceCredits: number;
}

export interface QvProposalCost {
  proposalId: number;
  voiceCredits: number;
  credits: number; // voiceCredits^2 — quadratic cost contribution
}

export interface QvCalculation {
  perProposal: QvProposalCost[];
  totalCreditsSpent: number;
  budget: number;
  remaining: number;
  withinBudget: boolean;
  withinRange: boolean;
}

/**
 * Compute the quadratic cost of a set of allocations.
 *
 * Quadratic voting cost = sum(voiceCredits_i^2). A member has a fixed budget of
 * `budget` credits; each allocation must also be within [0, maxCredits].
 */
export function calculateQuadraticCost(
  allocations: QvAllocation[],
  budget: number = QV_MAX_BUDGET,
  maxCredits: number = QV_MAX_CREDITS,
): QvCalculation {
  const perProposal: QvProposalCost[] = allocations.map((a) => ({
    proposalId: a.proposalId,
    voiceCredits: a.voiceCredits,
    credits: a.voiceCredits * a.voiceCredits,
  }));

  const totalCreditsSpent = perProposal.reduce((sum, p) => sum + p.credits, 0);
  const withinRange = allocations.every(
    (a) => a.voiceCredits >= 0 && a.voiceCredits <= maxCredits,
  );

  return {
    perProposal,
    totalCreditsSpent,
    budget,
    remaining: budget - totalCreditsSpent,
    withinBudget: totalCreditsSpent <= budget,
    withinRange,
  };
}

export interface QvBallotReveal {
  allocations: QvAllocation[];
}

export interface QvTallyEntry {
  proposalId: number;
  totalVoiceCredits: number;
}

/**
 * Aggregate revealed ballots into per-proposal voice-credit totals.
 *
 * The tally sums the voice credits (not the quadratic cost) allocated to each
 * proposal across all ballots — this is the quantity a QV round decides on.
 */
export function aggregateTally(ballots: QvBallotReveal[]): {
  tally: QvTallyEntry[];
  totalBallots: number;
} {
  const totals = new Map<number, number>();
  for (const ballot of ballots) {
    for (const a of ballot.allocations) {
      totals.set(
        a.proposalId,
        (totals.get(a.proposalId) ?? 0) + a.voiceCredits,
      );
    }
  }
  const tally: QvTallyEntry[] = [...totals.entries()]
    .map(([proposalId, totalVoiceCredits]) => ({
      proposalId,
      totalVoiceCredits,
    }))
    .sort((a, b) => a.proposalId - b.proposalId);
  return { tally, totalBallots: ballots.length };
}

// --- Validation schemas live in validation/schemas.ts ---

/**
 * POST /qv/proposals/:dao/calculate
 * Compute the quadratic cost breakdown for a proposed allocation.
 */
router.post(
  "/qv/proposals/:dao/calculate",
  bodyLimit("100kb"),
  queryLimiter,
  validateParams(qvParamsSchema),
  validateBody(qvCalculateSchema),
  (async (req: Request, res: Response) => {
    const { allocations, budget } = req.body as QvCalculateRequest;
    const result = calculateQuadraticCost(allocations, budget ?? QV_MAX_BUDGET);
    log("info", "qv_calculate", {
      dao: req.params.dao,
      total: result.totalCreditsSpent,
      withinBudget: result.withinBudget,
    });
    return res.json({ dao: Number(req.params.dao), ...result });
  }) as AsyncHandler,
);

/**
 * POST /qv/tally
 * Aggregate revealed ballots into per-proposal voice-credit totals.
 */
router.post(
  "/qv/tally",
  bodyLimit("100kb"),
  queryLimiter,
  validateBody(qvTallySchema),
  (async (req: Request, res: Response) => {
    const { ballots } = req.body as QvTallyRequest;
    const result = aggregateTally(ballots);
    log("info", "qv_tally", { ballots: result.totalBallots });
    return res.json(result);
  }) as AsyncHandler,
);

export default router;
