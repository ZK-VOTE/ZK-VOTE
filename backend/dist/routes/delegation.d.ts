/**
 * Anonymous Delegation Routes (issue #304)
 *
 * Derivation helpers and tally aggregation for liquid democracy. Secrets are
 * accepted as decimal field elements and are never persisted or logged — the
 * relay computes a commitment and forgets it, exactly as it does for the
 * quadratic-voting helpers in `quadratic.ts`.
 *
 *   POST /delegation/tag             derive a delegate's public tag
 *   POST /delegation/register        build the registration payload
 *   POST /delegation/vote            build the vote-on-behalf payload
 *   POST /delegation/revoke          build the revocation payload
 *   POST /delegation/tally           aggregate a tally including delegations
 *   POST /delegation/concentration   report delegate concentration
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=delegation.d.ts.map