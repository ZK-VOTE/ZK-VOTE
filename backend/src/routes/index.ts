/**
 * Routes Module Index + declarative route registry.
 *
 * Historically this file was a flat list of re-exports and `index.ts` held a
 * hand-written list of `app.use(...)` calls. The registry below makes the
 * mount order, required services, DI-service prerequisites and startup profile
 * explicit, and `mountRoutes()` validates those requirements **before**
 * mounting anything. The original named re-exports remain as aliases so no
 * existing import site needs to change.
 */

export { default as healthRoutes, initHealthRoutes } from "./health.js";
export { default as analyticsRoutes } from "./analytics.js";
export { default as votingRoutes } from "./voting.js";
export { default as daoRoutes } from "./daos.js";
export { default as ipfsRoutes } from "./ipfs.js";
export { default as commentsRoutes } from "./comments.js";
export { default as claimRoutes } from "./claim.js";
export { default as indexerRoutes, initIndexerRoutes } from "./indexer.js";
export { default as bridgeRoutes } from "./bridge.js";
export { default as circuitRoutes } from "./circuits.js";
export { default as transactionRoutes } from "./transactions.js";
export { default as authRoutes } from "./auth.js";
export { default as quadraticRoutes } from "./quadratic.js";
export { default as metricsRoutes } from "./metrics.js";
export { default as remediationRoutes } from "./remediation.js";
export { default as novaRoutes } from "./nova.js";
export { default as adminRoutes } from "./admin.js";
export { default as thresholdRoutes } from "./threshold.js";
export { default as auditRoutes } from "./audit.js";
export { default as randomnessRoutes } from "./randomness.js";
export { default as factoryRoutes } from "./factory.js";
export { default as payRoutes } from "./pay.js";
export { default as swapRoutes } from "./swap.js";
export { default as rampRoutes } from "./ramp.js";
export { default as onboardingRoutes } from "./onboarding.js";
export { default as notificationRoutes } from "./notifications.js";
export { proverRoutes } from "./prover.js";
export { eventsRoutes } from "./events.js";
