import * as StellarSdk from "@stellar/stellar-sdk";
import type { RpcServerPort, LoggerPort } from "./interfaces.js";
import type { TTLInfo } from "./ttl-checker.js";
import type { TTLTrackingEntry } from "./db.js";
/**
 * Database surface needed by the TTL renewal service (#358). Structurally
 * typed so unit tests can inject an in-memory fake.
 */
export interface TtlDbPort {
    getAllCachedDaos(): Array<{
        id: number;
    }>;
    upsertTTLTracking(entry: TTLTrackingEntry): void;
    createTTLCostLog(cycleId: string, cycleStart: string): number;
    updateTTLCostLog(id: number, fields: Partial<{
        cycleEnd: string;
        entriesRenewed: number;
        entriesSkipped: number;
        txCount: number;
        totalFeeXlm: number;
        status: string;
    }>): void;
}
/** TTL introspection surface (the subset of `ttl-checker.ts` used here). */
export interface TtlCheckerPort {
    queryInstanceTTLWithFallback(contractId: string, entryId: string): Promise<TTLInfo>;
    queryPersistentTTLWithFallback(contractId: string, daoId: number, method: string, entryId: string): Promise<TTLInfo>;
    needsRenewal(info: TTLInfo): boolean;
    isInGracePeriod(info: TTLInfo): boolean;
    formatRemaining(info: TTLInfo): string;
}
/** Health-reporting surface (subset of `service-health.ts`). */
export interface TtlHealthPort {
    markHealthy(service: "ttl_renewal"): void;
    markDegraded(service: "ttl_renewal", reason?: string): void;
}
/**
 * Dependencies of the TTL renewal service, injected explicitly via
 * `initTtlService` (called by the composition root) so this module never
 * imports the `stellar.js`/`db.js`/`service-health.js` module singletons
 * to get what it needs (#358).
 */
export interface TtlServiceDeps {
    /** Active RPC server (pool-backed proxy in production). */
    server: RpcServerPort;
    /** Relayer keypair used to sign renewal transactions. */
    relayerKeypair: {
        publicKey(): string;
    } & Partial<StellarSdk.Keypair>;
    /** Run `fn` with a timeout, labelled for logs/metrics. */
    callWithTimeout<T>(fn: () => Promise<T>, label: string): Promise<T>;
    /** Serialize transaction submissions against the relayer account. */
    withSequenceLock<T>(fn: () => Promise<T>): Promise<T>;
    /** Wait for an on-chain transaction to settle. */
    waitForTransaction(hash: string, timeoutSeconds?: number): Promise<{
        status: string;
    }>;
    /** Config: relayer test mode (disables the background renewal loop). */
    testMode: boolean;
    /** Config: Stellar network passphrase. */
    networkPassphrase: string;
    /** Config: max fee (stroops) for TTL renewal transactions. */
    ttlMaxFee: string;
    /** Config: whether on-chain TTL checks run before renewal. */
    ttlCheckEnabled: boolean;
    /** Config: whether per-cycle cost logging is persisted. */
    ttlCostTrackingEnabled: boolean;
    /** Config: renewal batch size. */
    ttlBatchSize: number;
    /** Config: default renewal interval (ms). */
    ttlRenewalIntervalMs: number;
    /** Contract IDs by config key (same keys as `CONTRACT_META.envKey`). */
    contractIds: {
        votingContractId?: string;
        treeContractId?: string;
        commentsContractId?: string;
        daoRegistryContractId?: string;
        membershipSbtContractId?: string;
    };
    /** Cached-DAO reads + TTL tracking/cost-log persistence. */
    db: TtlDbPort;
    /** On-chain TTL introspection. */
    checker: TtlCheckerPort;
    /** Health reporting for the renewal loop. */
    health: TtlHealthPort;
    /** Structured logger (called as `deps.log(level, event, meta)`). */
    log: LoggerPort["log"];
}
/** Explicitly wire the TTL service's dependencies (composition root only). */
export declare function initTtlService(d: TtlServiceDeps): void;
interface SubmitCallResult {
    success: boolean;
    feeXlm?: number;
    txHash?: string;
    error?: string;
}
declare function submitCall(contractId: string, method: string, args?: StellarSdk.xdr.ScVal[]): Promise<SubmitCallResult>;
type TTLSubmitter = typeof submitCall;
/**
 * Replace only the transaction-submission boundary in test mode.
 */
export declare function setTTLSubmitterForTests(submitter: TTLSubmitter | null): void;
declare function renewAllTTLs(): Promise<void>;
export declare function startTTLRenewal(intervalMs?: number): void;
export declare function stopTTLRenewal(): void;
export { renewAllTTLs };
//# sourceMappingURL=ttl.d.ts.map