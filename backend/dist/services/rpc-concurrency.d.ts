/**
 * RPC Concurrency Limiter
 *
 * Provides concurrency control for RPC requests to prevent overwhelming
 * the RPC server and causing resource exhaustion.
 */
export declare class RpcConcurrencyLimiter {
    private activeRequests;
    private readonly maxConcurrent;
    private readonly queue;
    private readonly maxQueueSize;
    constructor(maxConcurrent: number, maxQueueSize?: number);
    /**
     * Acquire a concurrency slot. Returns a release function that must be
     * called when the RPC request completes.
     */
    acquire(): Promise<() => void>;
    /**
     * Release a concurrency slot and process next queued request
     */
    private release;
    /**
     * Get current stats
     */
    getStats(): {
        activeRequests: number;
        queuedRequests: number;
        maxConcurrent: number;
    };
    /**
     * Clear all queued requests (for shutdown)
     */
    clearQueue(): void;
}
export declare const rpcConcurrencyLimiter: RpcConcurrencyLimiter;
/**
 * Execute an RPC call with concurrency limiting
 */
export declare function withRpcConcurrency<T>(fn: () => Promise<T>): Promise<T>;
//# sourceMappingURL=rpc-concurrency.d.ts.map