/**
 * Bridge Routes
 *
 * Handles cross-chain bridge operations:
 * - POST /bridge/vote - Submit a cross-chain vote (EVM -> Soroban)
 * - GET /bridge/nullifier/:daoId/:proposalId/:nullifier - Check nullifier status
 * - GET /bridge/sbt-root/:daoId - Get current SBT root for a DAO
 * - POST /bridge/relay - Manually trigger event relay
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=bridge.d.ts.map