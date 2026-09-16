/**
 * VDF + Threshold Randomness Routes (Issue #310)
 *
 * Provides verifiable, unbiasable randomness for proposal ordering that:
 *  1. Uses a VDF seeded from election parameters to introduce a time-delay
 *     that prevents front-running by the admin.
 *  2. Mixes the VDF output with threshold-RNG contributions from multiple
 *     independent authorities so that no single party can control the seed.
 *  3. Exposes a deterministic, replay-safe ordering endpoint that maps a
 *     set of proposal IDs to a random permutation.
 *
 * Endpoints:
 *  POST /randomness/seed         – Compute VDF seed for a DAO/proposal set
 *  POST /randomness/contribute   – Submit a threshold-RNG share
 *  POST /randomness/finalize     – Combine shares → final seed, return ordering
 *  GET  /randomness/ordering/:daoId – Fetch the committed proposal ordering
 *  GET  /randomness/verify/:daoId   – Verify stored ordering is reproducible
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=randomness.d.ts.map