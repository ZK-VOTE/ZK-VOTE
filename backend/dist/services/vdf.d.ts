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
//# sourceMappingURL=vdf.d.ts.map