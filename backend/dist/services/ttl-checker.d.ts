import type { TTLTrackingEntry } from "./db.js";
import type { LoggerPort, StellarContext } from "./interfaces.js";
/**
 * Dependencies injected via `initTtlChecker` (#358) so this module never
 * imports the `stellar.js`/`config.js`/`logger.js`/`db.js` module singletons
 * directly (the `db.js` import above is type-only).
 */
export interface TtlCheckerDeps {
    /** Soroban RPC surface for on-chain TTL queries. */
    server: StellarContext["server"];
    /** Config: TTL urgency thresholds (ms). */
    ttlGracePeriodMs: number;
    ttlRenewalThresholdMs: number;
    /** Config: relayer test mode (skips on-chain queries). */
    testMode: boolean;
    /** TTL tracking persistence (events store). */
    getTTLTracking(entryId: string): TTLTrackingEntry | null;
    upsertTTLTracking(entry: TTLTrackingEntry): void;
    /** Structured logger (called as `deps.log(level, event, meta)`). */
    log: LoggerPort["log"];
}
/** Explicitly wire the TTL checker (composition root only). */
export declare function initTtlChecker(d: TtlCheckerDeps): void;
export type Urgency = "grace" | "warning" | "healthy" | "unknown";
export interface TTLInfo {
    entryId: string;
    contractId: string;
    daoId: number | null;
    method: string | null;
    remainingMs: number;
    remainingLedgers: number;
    urgency: Urgency;
    tracked: boolean;
}
export declare function estimateRemainingFromTracked(entry: TTLTrackingEntry | null): TTLInfo | null;
export declare function queryContractInstanceTTL(contractId: string): Promise<{
    remainingLedgers: number;
    liveUntilLedger: number;
    latestLedger: number;
} | null>;
export declare function queryInstanceTTLWithFallback(contractId: string, entryId: string): Promise<TTLInfo>;
export declare function queryPersistentTTLWithFallback(contractId: string, daoId: number, method: string, entryId: string): Promise<TTLInfo>;
export declare function needsRenewal(info: TTLInfo): boolean;
export declare function isInGracePeriod(info: TTLInfo): boolean;
export declare function formatRemaining(info: TTLInfo): string;
//# sourceMappingURL=ttl-checker.d.ts.map