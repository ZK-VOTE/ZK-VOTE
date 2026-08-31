import { type TTLTrackingEntry } from "./db.js";
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