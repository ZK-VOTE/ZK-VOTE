/**
 * Membership Routes — Commitment Registration Rate Limiting (#371)
 *
 * `register_with_caller` requires caller auth, so the relayer cannot forge the
 * member's signature: this endpoint simulates the registration against the
 * membership-tree contract and returns the prepared transaction XDR (plus the
 * authorization entry) for the member to complete signing in their wallet.
 *
 * The per-member rate limiter here mirrors the on-chain per-member registration
 * cooldown in the membership-tree contract, so both layers reject spam.
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=membership.d.ts.map