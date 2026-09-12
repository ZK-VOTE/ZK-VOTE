/**
 * Composition Root (#358)
 *
 * The single place that explicitly constructs and wires service dependencies
 * at startup. Refactored services receive their dependencies via `init*`
 * functions (or constructor arguments); they never import `stellar.js`'s or
 * `db.js`'s module-level singletons to get what they need.
 *
 * `buildAppServices()` is called once from `index.ts` after environment
 * validation; the returned container is passed to the app wiring.
 */
import { config } from "./config.js";
import { logger } from "./services/logger.js";
import type { StellarContext } from "./services/interfaces.js";
/** The explicitly-wired service container. */
export interface AppServices {
    /** Immutable app configuration (validated before construction). */
    config: typeof config;
    /** Structured logger. */
    logger: typeof logger;
    /** The Stellar/Soroban surface, injected into consumer services. */
    stellar: StellarContext;
}
/**
 * Construct and wire every service. Must be called after `validateEnv()`.
 * This is the only place that reaches for the module singletons of the
 * foundational services (logger/stellar/db); consumer services get their
 * dependencies from here instead.
 */
export declare function buildAppServices(): AppServices;
//# sourceMappingURL=composition-root.d.ts.map