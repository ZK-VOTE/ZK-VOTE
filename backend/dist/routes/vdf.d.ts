/**
 * VDF Commit–Reveal Routes (issue #302)
 *
 * Client-side helpers for the VDF-gated commit–reveal voting flow. The relay
 * never learns a voter's choice from these endpoints: commitments are computed
 * from values the caller supplies, and the blinding factor is generated
 * client-side for the real flow. `POST /vdf/commitment` exists so a client
 * without a crypto implementation can still participate, and its response makes
 * the blinding's role explicit.
 *
 *   GET  /vdf/profiles          delay profiles and the latency/security tradeoff
 *   GET  /vdf/cost-analysis     what VDF verification costs on Soroban
 *   POST /vdf/commitment        compute a vote commitment (+ optional blinding)
 *   POST /vdf/commitment/verify check a reveal against a commitment
 *   POST /vdf/benchmark         measure VDF throughput on this host
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=vdf.d.ts.map