import crypto from "crypto";
export const DEFAULT_VDF_ITERATIONS = 100000;
export const MIN_VDF_ITERATIONS = 1000;
export const MAX_VDF_ITERATIONS = 10000000;
/**
 * Computes a VDF (Verifiable Delay Function) using iterated SHA256.
 * Returns y = SHA256^T(x) where T = iterations, along with evenly-spaced checkpoints.
 */
export function computeVdf(inputHex, iterations) {
    const start = Date.now();
    let current = Buffer.from(inputHex, "hex");
    const checkpointInterval = Math.max(1, Math.floor(iterations / 16));
    const checkpoints = [];
    for (let i = 0; i < iterations; i++) {
        current = crypto.createHash("sha256").update(current).digest();
        if ((i + 1) % checkpointInterval === 0) {
            checkpoints.push(current.toString("hex"));
        }
    }
    const duration = Date.now() - start;
    return {
        output: current.toString("hex"),
        checkpoints,
        duration,
    };
}
/**
 * Verifies a VDF output by recomputing segments between checkpoints.
 * Returns true if outputHex === SHA256^T(inputHex), false otherwise.
 */
export function verifyVdf(inputHex, iterations, outputHex, checkpoints) {
    let current = Buffer.from(inputHex, "hex");
    const checkpointInterval = Math.max(1, Math.floor(iterations / 16));
    let checkpointIndex = 0;
    for (let i = 0; i < iterations; i++) {
        current = crypto.createHash("sha256").update(current).digest();
        if ((i + 1) % checkpointInterval === 0) {
            const expectedHex = current.toString("hex");
            if (checkpointIndex >= checkpoints.length ||
                checkpoints[checkpointIndex] !== expectedHex) {
                return false;
            }
            checkpointIndex++;
        }
    }
    return current.toString("hex") === outputHex;
}
/**
 * Derives a deterministic VDF input from election parameters.
 * Computes: SHA256(dao_id || proposal_id || block_hash || admin_seed)
 */
export function deriveVdfInput(daoId, proposalId, blockHashHex, adminSeedHex) {
    const daoIdBuf = Buffer.alloc(8);
    daoIdBuf.writeBigUInt64BE(BigInt(daoId));
    const proposalIdBuf = Buffer.alloc(8);
    proposalIdBuf.writeBigUInt64BE(BigInt(proposalId));
    const blockHashBuf = Buffer.from(blockHashHex, "hex");
    const adminSeedBuf = Buffer.from(adminSeedHex, "hex");
    const combined = Buffer.concat([
        daoIdBuf,
        proposalIdBuf,
        blockHashBuf,
        adminSeedBuf,
    ]);
    const hash = crypto.createHash("sha256").update(combined).digest();
    return hash.toString("hex");
}
/**
 * Benchmarks VDF computation across different iteration counts.
 */
export function benchmarkVdf(iterationsArray) {
    const results = [];
    for (const iterations of iterationsArray) {
        const inputHex = crypto.randomBytes(32).toString("hex");
        const { duration } = computeVdf(inputHex, iterations);
        results.push({
            iterations,
            computeTimeMs: duration,
            outputSize: 32,
        });
    }
    return results;
}
/**
 * Estimates the computation time in ms for a given number of iterations.
 * Based on calibration: 1000 iterations ≈ 0.1ms.
 */
export function estimateVdfTime(iterations) {
    return (iterations / 1000) * 0.1;
}
//# sourceMappingURL=vdf.js.map