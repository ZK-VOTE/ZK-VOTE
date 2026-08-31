/**
 * Claim Routes — Vote-to-Earn Anonymous Rewards
 *
 * Thin rewards crate flow: only voters (is_nullifier_used) can claim once via claim-nullifier.
 * Relayer provides anonymity; contract enforces double-claim via claim-nullifier storage.
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=claim.d.ts.map