export declare const DEFAULT_VDF_ITERATIONS = 100000;
export declare const MIN_VDF_ITERATIONS = 1000;
export declare const MAX_VDF_ITERATIONS = 10000000;
/**
 * Computes a VDF (Verifiable Delay Function) using iterated SHA256.
 * Returns y = SHA256^T(x) where T = iterations, along with evenly-spaced checkpoints.
 */
export declare function computeVdf(inputHex: string, iterations: number): {
    output: string;
    checkpoints: string[];
    duration: number;
};
/**
 * Verifies a VDF output by recomputing segments between checkpoints.
 * Returns true if outputHex === SHA256^T(inputHex), false otherwise.
 */
export declare function verifyVdf(inputHex: string, iterations: number, outputHex: string, checkpoints: string[]): boolean;
/**
 * Derives a deterministic VDF input from election parameters.
 * Computes: SHA256(dao_id || proposal_id || block_hash || admin_seed)
 */
export declare function deriveVdfInput(daoId: number, proposalId: number, blockHashHex: string, adminSeedHex: string): string;
/**
 * Benchmarks VDF computation across different iteration counts.
 */
export declare function benchmarkVdf(iterationsArray: number[]): {
    iterations: number;
    computeTimeMs: number;
    outputSize: number;
}[];
/**
 * Estimates the computation time in ms for a given number of iterations.
 * Based on calibration: 1000 iterations ≈ 0.1ms.
 */
export declare function estimateVdfTime(iterations: number): number;
/** Domain tag for vote commitments, keeping them un-substitutable elsewhere. */
export declare const VOTE_COMMIT_DOMAIN = "ZKVOTE-COMMIT-V1";
/** Minimum blinding factor length. 32 bytes puts a brute-force search over
 *  blindings far out of reach, which matters because `choice` is low-entropy —
 *  without a blinding factor a commitment to "yes" or "no" is trivially opened
 *  by trying both. */
export declare const MIN_BLINDING_BYTES = 32;
export interface VoteCommitment {
    /** The value published on-chain during the commit phase. */
    commitment: string;
    /** Kept by the voter; required to reveal. Never leaves the client. */
    blinding: string;
    daoId: number;
    proposalId: number;
    /** The nullifier this commitment is bound to, as a decimal field element. */
    nullifier: string;
    choice: number;
}
/**
 * Compute a vote commitment.
 *
 * `SHA256(domain ‖ daoId ‖ proposalId ‖ nullifier ‖ choice ‖ blinding)`,
 * matching `Voting::compute_vote_commitment` byte for byte. SHA-256 rather than
 * Poseidon because this value is checked by the Soroban contract, where
 * `env.crypto().sha256` is a host function and Poseidon is not — the contract
 * must be able to recompute it cheaply during reveal.
 *
 * The nullifier is inside the preimage so a commitment observed on-chain cannot
 * be replayed into another voter's slot; daoId and proposalId are there so it
 * cannot be replayed into another election, mirroring the nullifier scheme's
 * own domain separation.
 *
 * The nullifier is passed as a decimal field element (as it appears in the
 * circuit's public signals) and encoded as 32 big-endian bytes, matching
 * `U256::to_be_bytes` on the contract side.
 */
export declare function computeVoteCommitment(daoId: number, proposalId: number, nullifier: string, choice: number, blindingHex: string): string;
/** Generate a commitment plus a fresh blinding factor for a voter. */
export declare function createVoteCommitment(daoId: number, proposalId: number, nullifier: string, choice: number): VoteCommitment;
/**
 * Check a reveal against a published commitment.
 *
 * Compared in constant time: the relay checks reveals on behalf of voters, and
 * a timing-variable comparison here would leak how much of a candidate
 * commitment matched.
 */
export declare function verifyVoteCommitment(commitmentHex: string, daoId: number, proposalId: number, nullifier: string, choice: number, blindingHex: string): boolean;
export interface DelayProfile {
    name: string;
    iterations: number;
    /** Wall-clock delay on the reference prover, in seconds. */
    delaySeconds: number;
    /** Delay if an attacker's hardware is `speedup`× faster sequentially. */
    attackerDelaySeconds: number;
    /** Checkpoints needed to keep on-chain verification inside budget. */
    checkpoints: number;
    /** SHA-256 invocations the contract performs to verify. */
    onChainHashes: number;
    suitableFor: string;
}
/**
 * Sequential speedup an adversary with the best available hardware is assumed
 * to have over the reference prover.
 *
 * SHA-256 is not parallelisable within a chain, so the only lever is clock rate
 * and a tighter core. An ASIC buys a large *throughput* win and only a modest
 * *latency* win; 10× is the conservative bound this analysis uses. It is the
 * single most important assumption here — if it is wrong, every delay below is
 * wrong by the same factor, which is why the profiles quote both columns.
 */
export declare const ASSUMED_ATTACKER_SPEEDUP = 10;
/** Measured throughput of the reference implementation, hashes/second.
 *  `benchmarkVdf()` re-measures this on the target host. */
export declare const REFERENCE_HASHES_PER_SEC = 10000000;
/**
 * The latency-versus-security tradeoff, as a table.
 *
 * The tension is direct: a longer delay is a stronger coercion guarantee (the
 * coercer must wait longer, and the window in which a last-minute bloc could
 * act shrinks) but a worse experience (results take longer, and a failed reveal
 * is discovered later). The profiles below are the points on that curve worth
 * offering; §"Recommendation" in the spike doc argues for `standard`.
 */
export declare function delayProfiles(hashesPerSec?: number): DelayProfile[];
export interface CommitRevealCost {
    profile: string;
    iterations: number;
    /** Sequential SHA-256 the prover must perform. */
    proverHashes: number;
    /** SHA-256 the contract performs under naive full verification. */
    naiveOnChainHashes: number;
    /** SHA-256 the contract performs verifying `checkpoints` segments. */
    segmentedOnChainHashes: number;
    /** Whether segmented verification fits Soroban's per-transaction budget. */
    fitsInSorobanBudget: boolean;
    /** Persistent-storage entries the flow adds per voter. */
    storageEntriesPerVoter: number;
    notes: string;
}
/**
 * Soroban's per-transaction CPU instruction budget, and the measured cost of
 * one `env.crypto().sha256` on a 32-byte input.
 *
 * These are the numbers the spike's feasibility conclusion rests on; they are
 * stated here as named constants so a future SDK change invalidates the
 * conclusion loudly rather than silently.
 */
export declare const SOROBAN_CPU_BUDGET = 100000000;
export declare const SHA256_COST_INSTRUCTIONS = 3800;
export declare const MAX_ON_CHAIN_HASHES: number;
/**
 * Cost analysis for running commit–reveal at each delay profile.
 *
 * The headline finding: full on-chain VDF verification is not viable at any
 * useful delay. Verifying `y = SHA256^T(x)` costs the same T hashes the prover
 * spent, and Soroban's budget allows roughly 26,000 — five orders of magnitude
 * short of even the `minimal` profile. Segmented verification does not help,
 * because checking every segment still costs T in total.
 *
 * What *does* work is what the contract implements: the delay is enforced by
 * the ledger timestamp, and the VDF output is verified against a small number
 * of segments so that a submitted output which does not lie on the chain is
 * rejected, with full verification available to anyone off-chain. That is a
 * weaker on-chain guarantee than "the contract proved the work happened", and
 * the spike says so explicitly rather than papering over it.
 */
export declare function commitRevealCostAnalysis(hashesPerSec?: number): CommitRevealCost[];
//# sourceMappingURL=vdf.d.ts.map