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
declare const router: import("express-serve-static-core").Router;
export declare const QV_MAX_BUDGET = 100;
export declare const QV_MAX_CREDITS = 10;
export interface QvAllocation {
    proposalId: number;
    voiceCredits: number;
}
export interface QvProposalCost {
    proposalId: number;
    voiceCredits: number;
    credits: number;
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
export declare function calculateQuadraticCost(allocations: QvAllocation[], budget?: number, maxCredits?: number): QvCalculation;
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
export declare function aggregateTally(ballots: QvBallotReveal[]): {
    tally: QvTallyEntry[];
    totalBallots: number;
};
export default router;
//# sourceMappingURL=quadratic.d.ts.map