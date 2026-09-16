/**
 * Privacy-Preserving Analytics (homomorphic tally aggregates) — issue #306
 *
 * Computes turnout / participation analytics for a DAO WITHOUT ever decrypting
 * per-voter contributions. The core idea:
 *
 *   1. Each participation contribution is a fresh ElGamal encryption of `vote=1`
 *      under the DAO's DKG joint public key. The plaintext per-slot is never
 *      revealed or stored.
 *   2. Contributions are folded into a single per-DAO *aggregate* ciphertext via
 *      homomorphic addition. The aggregate therefore equals the number of
 *      participants, but indexers / the relayer see only the two ciphertext
 *      points (c1, c2).
 *   3. Only the aggregate — over the whole DAO or a cohort of proposals — is ever
 *      threshold-decrypted, and only after:
 *        - enough decryption share authorities have contributed (>= t), and
 *        - the cohort meets the DAO's k-anonymity floor (min_cohort), and
 *        - the DAO's privacy budget (ε) still has budget left.
 *
 * A per-DAO monotonically-spent ε budget bounds how many aggregates may be
 * decrypted in a window, so an attacker cannot repeatedly slice/difference
 * aggregates down to a single voter. See THREAT_MODEL.md §Privacy-Preserving
 * Analytics and the DKG/threshold-decryption primitives in ./threshold-crypto.ts.
 */
import * as tc from "./threshold-crypto.js";
export interface AnalyticsConfig {
    daoId: number;
    jointPublicKey: string;
    thresholdT: number;
    thresholdN: number;
    /** k-anonymity floor: never decrypt a cohort smaller than this. */
    minCohort?: number;
    /** per-query ε cost. */
    epsilonPerQuery?: number;
    /** total ε budget for the window. */
    epsilonBudget?: number;
}
export interface AnalyticsState {
    daoId: number;
    jointPublicKey: string;
    thresholdT: number;
    thresholdN: number;
    contributionCount: number;
    aggregateC1: string;
    aggregateC2: string;
    decrypted: boolean;
    lastDecryptedTally: string;
    decryptedAt: string | null;
    updatedAt: string;
}
export interface PrivacyBudgetState {
    daoId: number;
    epsilonBudget: number;
    epsilonSpent: number;
    epsilonPerQuery: number;
    minCohort: number;
    remaining: number;
}
export interface DecryptResult {
    tally: bigint;
    tallyStr: string;
    proof: string;
    combinedShare: string;
    spentEpsilon: number;
    remainingEpsilon: number;
}
export declare class PrivacyAnalyticsError extends Error {
    constructor(message: string);
}
/**
 * Initialize the analytics aggregate for a DAO. Idempotent — re-initialising
 * with the same joint public key is a no-op; a mismatched key is rejected.
 */
export declare function initializeAnalytics(cfg: AnalyticsConfig): AnalyticsState;
/**
 * Fold one encrypted participation contribution into the DAO aggregate via
 * homomorphic addition. The individual contribution is discarded immediately,
 * so per-voter participation is never recoverable from the analytics store.
 */
export declare function accumulateContribution(daoId: number, contribution: tc.Ciphertext): AnalyticsState;
/**
 * Return the current analytics state (aggregate ciphertext + cohort size).
 * This NEVER decrypts and is safe to expose: it reveals only the cohort size,
 * which is public on-chain, and the two ciphertext points.
 */
export declare function getState(daoId: number): AnalyticsState;
/**
 * Return the DAO's privacy budget accounting (does not require a DKG joint key).
 */
export declare function getPrivacyBudget(daoId: number): PrivacyBudgetState;
/**
 * Threshold-decrypt the DAO *aggregate* only.
 *
 * Guards (all must pass, otherwise the aggregate is refused):
 *   - the aggregate is not already decrypted (single-decrypt semantics),
 *   - at least `threshold_t` distinct authority decryption shares are supplied,
 *   - the cohort meets the k-anonymity floor (`min_cohort`),
 *   - ε budget remains for at least one more decryption.
 *
 * On success the ε budget is debited and the aggregate is marked decrypted.
 */
export declare function thresholdDecryptAggregate(daoId: number, shares: Array<{
    authorityIndex: number;
    shareHex: string;
}>): DecryptResult;
/**
 * Reset the DAO's privacy budget window (admin operation). Kept explicit and
 * auditable rather than implicit.
 */
export declare function resetPrivacyBudget(daoId: number, newBudget?: number): PrivacyBudgetState;
//# sourceMappingURL=privacy-analytics.d.ts.map