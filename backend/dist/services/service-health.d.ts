/**
 * Service Health & Graceful Degradation Registry (#204)
 *
 * Tracks per-component health by criticality tier and provides:
 *  - Last-known-good (LKG) response cache for important/non-critical reads
 *  - Durable write queue for non-critical operations (e.g. IPFS pins)
 *  - Overall degradation summary for /health and response headers
 *
 * Principle: the system stays available with reduced functionality.
 */
export type ServiceTier = "critical" | "important" | "non_critical" | "background";
export type ServiceState = "healthy" | "degraded" | "unavailable";
export type ServiceName = "soroban_rpc" | "sqlite" | "ipfs" | "comments" | "indexer" | "dao_sync" | "ttl_renewal" | "sbt_transfer_watch";
export interface ServiceHealthEntry {
    name: ServiceName;
    tier: ServiceTier;
    state: ServiceState;
    lastError: string | null;
    updatedAt: string;
    description: string;
}
export interface OverallHealth {
    status: "ok" | "degraded";
    degraded: ServiceName[];
    unavailable: ServiceName[];
    services: ServiceHealthEntry[];
}
export interface QueuedWrite {
    id: string;
    service: ServiceName;
    operation: string;
    payload: unknown;
    createdAt: string;
    attempts: number;
    lastError: string | null;
}
/** Reset all services to healthy (tests). */
export declare function resetServiceHealth(): void;
export declare function markHealthy(name: ServiceName): void;
export declare function markDegraded(name: ServiceName, error?: string): void;
export declare function markUnavailable(name: ServiceName, error?: string): void;
export declare function getServiceHealth(name?: ServiceName): ServiceHealthEntry | ServiceHealthEntry[];
export declare function getOverallHealth(): OverallHealth;
export declare function getDegradedServiceNames(): string[];
export declare function setLkg(key: string, value: unknown, ttlMs?: number): void;
export declare function getLkg<T = unknown>(key: string): T | null;
export declare function commentsLkgKey(daoId: number, proposalId: number): string;
export declare function ipfsLkgKey(cid: string): string;
export declare function enqueueDegradedWrite(service: ServiceName, operation: string, payload: unknown): QueuedWrite;
export declare function listQueuedWrites(service?: ServiceName): QueuedWrite[];
export declare function removeQueuedWrite(id: string): boolean;
export declare function updateQueuedWriteError(id: string, error: string): void;
/**
 * Drain queued IPFS pinJSON operations when the service recovers.
 * handler should return the resulting CID or throw.
 */
export declare function drainIpfsPinQueue(handler: (payload: {
    data: unknown;
    name?: string;
}) => Promise<{
    cid: string;
    size?: number;
}>): Promise<{
    drained: number;
    failed: number;
}>;
/** Clear queue file (tests). */
export declare function clearDegradedWriteQueue(): void;
//# sourceMappingURL=service-health.d.ts.map