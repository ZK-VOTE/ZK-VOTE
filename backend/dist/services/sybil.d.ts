/**
 * Sybil-Resistance Weight Curve (issue #301)
 *
 * The TypeScript mirror of the weight curve that
 * `contracts/membership-sbt/src/lib.rs` enforces on-chain and
 * `circuits/sybil_weight.circom` enforces in the proof. Everything the API and
 * the UI say about weight comes from here, so there is exactly one place to
 * read the rule and exactly three places (Rust, circom, here) that must agree.
 *
 * ## The curve
 *
 *     weight = min(MAX_SYBIL_WEIGHT, BASE_WEIGHT + agePoints + repPoints)
 *
 * `agePoints` and `repPoints` are step functions — one point per threshold
 * crossed. That shape is chosen for two reasons:
 *
 *   * **It bounds amplification.** A fresh identity is worth BASE_WEIGHT (1)
 *     and the best possible identity is worth MAX_SYBIL_WEIGHT (10). So an
 *     attacker's advantage per Sybil relative to an established member is a
 *     fixed 10:1 ratio, never unbounded — which is what the funding caps in
 *     THREAT_MODEL §"Sybil bounds" need in order to be meaningful.
 *   * **It is concave.** Thresholds widen (7 → 30 → 90 → 180 → 365 days), so
 *     each extra point costs more waiting than the last. Age farming hits
 *     diminishing returns well before the cap.
 *
 * A smooth curve (sqrt, log) would need division or a lookup argument in
 * circom and buys nothing: the property that matters is the bound, not the
 * shape.
 */
/** Age thresholds in days; crossing each adds one point. */
export declare const AGE_THRESHOLD_DAYS: readonly number[];
/** Reputation thresholds; crossing each adds one point. */
export declare const REPUTATION_THRESHOLDS: readonly number[];
/** Weight every non-revoked member carries — the one-member-one-vote floor. */
export declare const BASE_WEIGHT = 1;
/** Hard cap on any single identity's weight. */
export declare const MAX_SYBIL_WEIGHT = 10;
/** Upper bound on a stored reputation score. */
export declare const MAX_REPUTATION = 10000;
export declare const SECONDS_PER_DAY = 86400;
/**
 * Minimum SBT age before an identity carries more than the base weight.
 * Matches the 7-day floor THREAT_MODEL already documents for reward
 * eligibility, so the two gates cannot drift apart.
 */
export declare const MIN_SBT_AGE_DAYS: number;
export interface WeightBreakdown {
    ageDays: number;
    reputation: number;
    agePoints: number;
    reputationPoints: number;
    baseWeight: number;
    /** Uncapped sum, useful for showing "you are at the cap" in the UI. */
    rawWeight: number;
    /** The weight the chain and the circuit will agree on. */
    weight: number;
    capped: boolean;
    /** Days until the next age threshold, or null once past the last one. */
    daysToNextThreshold: number | null;
    /** Reputation needed for the next point, or null once past the last one. */
    reputationToNextThreshold: number | null;
}
/** Points contributed by SBT age. */
export declare function agePoints(ageDays: number): number;
/** Points contributed by reputation. */
export declare function reputationPoints(reputation: number): number;
/**
 * Whole days between a mint timestamp and a snapshot, floored.
 *
 * Matches the `AgeInDays` circom template and the Rust
 * `now.saturating_sub(minted_at) / SECONDS_PER_DAY`: a mint in the future
 * yields 0, never a negative age.
 */
export declare function ageDaysAt(mintedAtSec: number, snapshotSec: number): number;
/** The full weight computation, with the breakdown the UI needs. */
export declare function computeWeight(ageDays: number, reputation: number): WeightBreakdown;
export interface SybilScenario {
    /** How many identities the attacker controls. */
    sybilCount: number;
    /** Age in days of each Sybil identity at the snapshot. */
    sybilAgeDays: number;
    /** Reputation each Sybil has managed to accrue. */
    sybilReputation: number;
    /** Age of the honest member being compared against. */
    honestAgeDays: number;
    honestReputation: number;
    /** Honest members participating, for the share calculation. */
    honestCount: number;
}
export interface SybilAnalysis {
    scenario: SybilScenario;
    weightPerSybil: number;
    weightPerHonest: number;
    totalSybilWeight: number;
    totalHonestWeight: number;
    /** Attacker's share of total voting weight, 0..1. */
    attackerShare: number;
    /** How many Sybils are needed to match one honest member. */
    sybilsPerHonestVote: number;
    /** Sybils needed to reach a majority of total weight. */
    sybilsForMajority: number;
    /** Under flat one-identity-one-vote, the same share — for comparison. */
    attackerShareUnweighted: number;
    /** Multiplicative reduction in attacker share the curve buys. */
    reductionFactor: number;
}
/**
 * Quantify what the curve actually buys against a Sybil attack.
 *
 * The comparison that matters is against flat one-identity-one-vote, which is
 * what the relay does today: there, N Sybils get N votes and the attacker's
 * share is N/(N+H) regardless of how new the identities are. Under the curve a
 * fresh Sybil is worth BASE_WEIGHT while an established member is worth up to
 * MAX_SYBIL_WEIGHT, so the same N buys proportionally less.
 */
export declare function analyzeSybilBound(scenario: SybilScenario): SybilAnalysis;
/** The curve as a table, for docs and for the UI's explainer. */
export declare function weightCurveTable(): Array<{
    ageDays: number;
    label: string;
    weightAtZeroReputation: number;
    weightAtMaxReputation: number;
}>;
/** Every parameter, for the `GET /sybil/params` endpoint. */
export declare function weightCurveParams(): {
    baseWeight: number;
    maxSybilWeight: number;
    maxReputation: number;
    minSbtAgeDays: number;
    ageThresholdDays: readonly number[];
    reputationThresholds: readonly number[];
};
//# sourceMappingURL=sybil.d.ts.map