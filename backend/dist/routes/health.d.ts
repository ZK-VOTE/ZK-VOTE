/**
 * Health Check Routes
 *
 * Provides health, readiness, and configuration endpoints.
 */
import type * as StellarSdk from "@stellar/stellar-sdk";
declare const router: import("express-serve-static-core").Router;
/**
 * Initialize health routes with dependencies
 */
export declare function initHealthRoutes(rpcServer: StellarSdk.rpc.Server | {
    getHealth: () => Promise<{
        status: string;
    }>;
}, relayerPubKey: string): void;
export default router;
//# sourceMappingURL=health.d.ts.map