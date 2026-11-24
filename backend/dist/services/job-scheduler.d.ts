/**
 * Unified Background Job Scheduler
 *
 * Coordinates periodic maintenance and reconciliation jobs:
 * - cleanup_stale_sessions: evicts expired relay sessions, nonces, and updates session_store_size
 * - token:maintenance: expires, revokes, and rotates auth tokens
 * - rate_limit:maintenance: computes and updates rate_limit_store_size
 * - reconciliation:check: verifies integrity between SQLite WAL, relayer state, and on-chain ledger
 */
export interface JobSchedulerOptions {
    intervalMs?: number;
    runImmediately?: boolean;
}
export declare class JobScheduler {
    private timer;
    private running;
    private intervalMs;
    constructor(options?: JobSchedulerOptions);
    /**
     * Start recurring job scheduler loop
     */
    start(): void;
    /**
     * Stop recurring scheduler
     */
    stop(): void;
    /**
     * Run a single tick of all registered scheduled tasks
     */
    tick(): Promise<{
        cleanedSessions: number;
        tokenMaintenance: any;
        rateLimitKeys: number;
    }>;
    /**
     * Evicts expired relay sessions and capabilities
     */
    cleanupStaleSessions(): number;
    /**
     * Inspect and update rate limit metrics
     */
    updateStoreMetrics(): number;
    /**
     * End-to-end DAO reconciliation (#577).
     *
     * Verifies the full `create_dao → mint → register → proposal → vote → tally`
     * pipeline stays consistent between the SQLite cache (DB counts), the
     * relayer pipeline tables (`vote_submissions`, `vote_jobs`,
     * `transaction_log`, `proof_commitments`) and the on-chain hashes recorded
     * in per-DAO `events_<daoId>` tables (sourced from Horizon/Soroban, see
     * FIX_REPORT.md blast-radius workflow). Any divergence increments
     * `reconciliation_mismatch_total{component="dao_tally"}` so the Grafana /
     * Prometheus `ZKVoteRelayerDaoTallyMismatch` alert fires.
     */
    checkStateReconciliation(): void;
    /**
     * Compare per-DAO `vote_cast` event counts (on-chain hashes mirrored from
     * Horizon) against the relayer pipeline tables, plus pipeline-internal
     * consistency (stuck pendings, dead letters, hash-less confirmations).
     * Returns the number of mismatched groups found.
     */
    reconcileDaoTallies(): number;
}
export declare const defaultJobScheduler: JobScheduler;
//# sourceMappingURL=job-scheduler.d.ts.map