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
import { Router } from "express";
import { z } from "zod";
import { log } from "../services/logger.js";
import { queryLimiter, validateBody, validateParams, bodyLimit, } from "../middleware/index.js";
const router = Router();
// Must match circuits/quadratic_vote_main.circom and the voting contract's
// MAX_QV_BUDGET.
export const QV_MAX_BUDGET = 100;
export const QV_MAX_CREDITS = 10;
/**
 * Compute the quadratic cost of a set of allocations.
 *
 * Quadratic voting cost = sum(voiceCredits_i^2). A member has a fixed budget of
 * `budget` credits; each allocation must also be within [0, maxCredits].
 */
export function calculateQuadraticCost(allocations, budget = QV_MAX_BUDGET, maxCredits = QV_MAX_CREDITS) {
    const perProposal = allocations.map((a) => ({
        proposalId: a.proposalId,
        voiceCredits: a.voiceCredits,
        credits: a.voiceCredits * a.voiceCredits,
    }));
    const totalCreditsSpent = perProposal.reduce((sum, p) => sum + p.credits, 0);
    const withinRange = allocations.every((a) => a.voiceCredits >= 0 && a.voiceCredits <= maxCredits);
    return {
        perProposal,
        totalCreditsSpent,
        budget,
        remaining: budget - totalCreditsSpent,
        withinBudget: totalCreditsSpent <= budget,
        withinRange,
    };
}
/**
 * Aggregate revealed ballots into per-proposal voice-credit totals.
 *
 * The tally sums the voice credits (not the quadratic cost) allocated to each
 * proposal across all ballots — this is the quantity a QV round decides on.
 */
export function aggregateTally(ballots) {
    const totals = new Map();
    for (const ballot of ballots) {
        for (const a of ballot.allocations) {
            totals.set(a.proposalId, (totals.get(a.proposalId) ?? 0) + a.voiceCredits);
        }
    }
    const tally = [...totals.entries()]
        .map(([proposalId, totalVoiceCredits]) => ({
        proposalId,
        totalVoiceCredits,
    }))
        .sort((a, b) => a.proposalId - b.proposalId);
    return { tally, totalBallots: ballots.length };
}
// --- Validation schemas ---
const allocationSchema = z.object({
    proposalId: z.number().int().nonnegative(),
    voiceCredits: z.number().int().min(0).max(QV_MAX_CREDITS),
});
const calculateSchema = z.object({
    allocations: z.array(allocationSchema).min(1).max(16),
    budget: z.number().int().positive().max(QV_MAX_BUDGET).optional(),
});
const tallySchema = z.object({
    ballots: z
        .array(z.object({ allocations: z.array(allocationSchema).min(1).max(16) }))
        .min(1),
});
const daoParamsSchema = z.object({
    dao: z.string().regex(/^\d+$/),
});
/**
 * POST /qv/proposals/:dao/calculate
 * Compute the quadratic cost breakdown for a proposed allocation.
 */
router.post("/qv/proposals/:dao/calculate", bodyLimit("100kb"), queryLimiter, validateParams(daoParamsSchema), validateBody(calculateSchema), (async (req, res) => {
    const { allocations, budget } = req.body;
    const result = calculateQuadraticCost(allocations, budget ?? QV_MAX_BUDGET);
    log("info", "qv_calculate", {
        dao: req.params.dao,
        total: result.totalCreditsSpent,
        withinBudget: result.withinBudget,
    });
    return res.json({ dao: Number(req.params.dao), ...result });
}));
/**
 * POST /qv/tally
 * Aggregate revealed ballots into per-proposal voice-credit totals.
 */
router.post("/qv/tally", bodyLimit("100kb"), queryLimiter, validateBody(tallySchema), (async (req, res) => {
    const { ballots } = req.body;
    const result = aggregateTally(ballots);
    log("info", "qv_tally", { ballots: result.totalBallots });
    return res.json(result);
}));
export default router;
//# sourceMappingURL=quadratic.js.map