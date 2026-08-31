/**
 * Database Worker Thread Pool
 *
 * Implements a read/write separated worker pool:
 * - 1 Dedicated Writer Worker for SQLite write operations (WAL mode single writer)
 * - N Reader Workers for parallel read queries (round-robin dispatching)
 *
 * Provides message-passing interface, worker crash recovery, auto-restart,
 * and pool performance metrics.
 */
export interface WorkerPoolMetrics {
    writerActive: boolean;
    activeReadersCount: number;
    queueDepth: number;
    totalQueriesHandled: number;
    totalProcessingTimeMs: number;
    avgProcessingTimeMs: number;
    crashesCount: number;
    restartsCount: number;
}
export declare class DbWorkerPool {
    private dbPath;
    private writerWorker;
    private readerWorkers;
    private currentReaderIndex;
    private pendingRequests;
    private requestCounter;
    private totalQueriesHandled;
    private totalProcessingTimeMs;
    private crashesCount;
    private restartsCount;
    private initialized;
    constructor(dbPath?: string);
    /**
     * Initialize worker pool (1 Writer + N Readers)
     */
    init(options?: {
        numReaders?: number;
    }): Promise<void>;
    /**
     * Spawn a new worker thread
     */
    private spawnWorker;
    /**
     * Handle worker crash with automatic restart
     */
    private handleCrash;
    /**
     * Execute write query on writer worker
     */
    executeWrite(sql: string, params?: any[]): Promise<{
        changes: number;
        lastInsertRowid: number;
    }>;
    /**
     * Execute raw SQL string on writer worker (DDL / transactions)
     */
    execWrite(sql: string): Promise<{
        success: boolean;
    }>;
    /**
     * Execute read query on reader worker pool (round-robin)
     */
    queryRead<T = any>(sql: string, params?: any[]): Promise<T[]>;
    /**
     * Execute single-row read query on reader worker pool
     */
    queryReadOne<T = any>(sql: string, params?: any[]): Promise<T | undefined>;
    /**
     * Dispatch message to target worker thread
     */
    private dispatch;
    /**
     * Round-robin selection of reader worker
     */
    private getNextReader;
    /**
     * Return current worker pool performance metrics
     */
    getMetrics(): WorkerPoolMetrics;
    /**
     * Close worker pool
     */
    close(): Promise<void>;
}
export declare function getDbWorkerPool(dbPath?: string): DbWorkerPool;
//# sourceMappingURL=dbWorkerPool.d.ts.map