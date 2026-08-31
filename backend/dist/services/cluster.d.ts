/**
 * Clustering & Multi-Core Process Service
 *
 * Implements primary-worker cluster process management for ZK-VOTE:
 * - Master process forks and manages worker processes
 * - Primary/Leader election for background services (indexer, sync, monitoring)
 * - Distributed sequence lock serialization over IPC for Stellar nonces
 * - Shared rate limiting state store over IPC across all workers
 * - In-memory cache invalidation broadcast over IPC
 * - Health monitoring, worker auto-restart, and coordinated graceful shutdown
 */
import type { Store, ClientRateLimitInfo, Options as RateLimitOptions } from "express-rate-limit";
export type ClusterIpcMessageType = "LEADER_ASSIGNMENT" | "SEQUENCE_LOCK_ACQUIRE" | "SEQUENCE_LOCK_GRANTED" | "SEQUENCE_LOCK_RELEASE" | "RATE_LIMIT_INCREMENT" | "RATE_LIMIT_RESPONSE" | "RATE_LIMIT_DECREMENT" | "RATE_LIMIT_RESET" | "CACHE_INVALIDATE" | "WORKER_HEALTH_PING" | "WORKER_HEALTH_PONG" | "GRACEFUL_SHUTDOWN";
export interface ClusterIpcMessage {
    type: ClusterIpcMessageType;
    requestId?: string;
    isLeader?: boolean;
    leaderPid?: number;
    limiterName?: string;
    key?: string;
    windowMs?: number;
    totalHits?: number;
    resetTimeMs?: number;
    channel?: string;
    data?: any;
    reason?: string;
    pid?: number;
    memory?: NodeJS.MemoryUsage;
    uptime?: number;
}
/**
 * Check whether current process is the elected leader/primary worker
 */
export declare function isLeaderWorker(): boolean;
/**
 * Register a listener for leader status changes
 */
export declare function onLeaderChange(cb: (isLeader: boolean) => void): void;
/**
 * Register a listener for cache invalidation events
 */
export declare function onCacheInvalidate(cb: (channel: string, key: string, data?: any) => void): void;
/**
 * Register worker graceful shutdown trigger
 */
export declare function registerWorkerShutdownHandler(handler: (reason: string) => void): void;
/**
 * Initialize IPC listener in worker process
 */
export declare function initWorkerIpc(): void;
export declare function acquireClusterSequenceLock(timeoutMs?: number): Promise<void>;
export declare function releaseClusterSequenceLock(): Promise<void>;
export declare class ClusterRateLimitStore implements Store {
    limiterName: string;
    options: RateLimitOptions;
    constructor(limiterName: string);
    init(options: RateLimitOptions): void;
    increment(key: string): Promise<ClientRateLimitInfo>;
    decrement(key: string): Promise<void>;
    resetKey(key: string): Promise<void>;
}
export declare function broadcastCacheInvalidation(channel: string, key: string, data?: any): void;
export declare function startClusterMaster(): void;
//# sourceMappingURL=cluster.d.ts.map