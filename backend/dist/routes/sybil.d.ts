/**
 * Sybil-Resistance Routes (issue #301)
 *
 * Read-only helpers over the weight curve in `services/sybil.ts`. Nothing here
 * writes to the chain — the authoritative weight is enforced twice already, in
 * `membership-sbt` and inside the proof — so these endpoints exist so the UI
 * and DAO admins can see the same numbers without reimplementing the curve.
 *
 *   GET  /sybil/params               the curve parameters and the curve table
 *   POST /sybil/weight               weight for an (age, reputation) pair
 *   POST /sybil/simulate             what a Sybil attack actually buys
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=sybil.d.ts.map