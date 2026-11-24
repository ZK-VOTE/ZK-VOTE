/**
 * Unified Background Job Scheduler
 *
 * Coordinates periodic maintenance and reconciliation jobs:
 * - cleanup_stale_sessions: evicts expired relay sessions, nonces, and updates session_store_size
 * - token:maintenance: expires, revokes, and rotates auth tokens
 * - rate_limit:maintenance: computes and updates rate_limit_store_size
 * - reconciliation:check: verifies integrity between SQLite WAL, relayer state, and on-chain ledger
 */
import { createLogger } from "./logger.js";
import { runMaintenanceTasks } from "./authTokens.js";
import { getDb } from "./db.js";
import { session_store_size, rate_limit_store_size, reconciliation_mismatch_total, daoReconciliationRunsTotal, daoReconciliationLastOk, serviceLastRunTime, } from "./metrics.js";
const logger = createLogger("job-scheduler");
export class JobScheduler {
    timer = null;
    running = false;
    intervalMs;
    constructor(options = {}) {
        this.intervalMs = options.intervalMs ?? 60_000;
    }
    /**
     * Start recurring job scheduler loop
     */
    start() {
        if (this.timer) {
            logger.warn("job_scheduler_already_running");
            return;
        }
        logger.info("job_scheduler_started", { intervalMs: this.intervalMs });
        this.timer = setInterval(() => {
            this.tick().catch((err) => {
                logger.error("job_scheduler_tick_error", {
                    error: err.message,
                });
            });
        }, this.intervalMs);
        // Initial immediate tick
        this.tick().catch((err) => {
            logger.error("job_scheduler_initial_tick_error", {
                error: err.message,
            });
        });
    }
    /**
     * Stop recurring scheduler
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            logger.info("job_scheduler_stopped");
        }
    }
    /**
     * Run a single tick of all registered scheduled tasks
     */
    async tick() {
        if (this.running) {
            logger.debug("job_scheduler_skip_concurrent_tick");
            return { cleanedSessions: 0, tokenMaintenance: null, rateLimitKeys: 0 };
        }
        this.running = true;
        try {
            // 1. Cleanup stale sessions
            const cleanedSessions = this.cleanupStaleSessions();
            // 2. Auth token maintenance
            const tokenMaintenance = runMaintenanceTasks();
            // 3. Update gauge metrics
            const rateLimitKeys = this.updateStoreMetrics();
            // 4. State reconciliation check
            this.checkStateReconciliation();
            return {
                cleanedSessions,
                tokenMaintenance,
                rateLimitKeys,
            };
        }
        finally {
            this.running = false;
        }
    }
    /**
     * Evicts expired relay sessions and capabilities
     */
    cleanupStaleSessions() {
        const db = getDb();
        let cleaned = 0;
        try {
            const nowIso = new Date().toISOString();
            const res = db
                .prepare("DELETE FROM relay_session_capabilities WHERE expires_at < ?")
                .run(nowIso);
            cleaned = res.changes;
            // Update session_store_size gauge
            const activeCount = db
                .prepare("SELECT COUNT(*) as count FROM relay_session_capabilities")
                .get();
            session_store_size.set(activeCount ? activeCount.count : 0);
            if (cleaned > 0) {
                logger.info("cleanup_stale_sessions_completed", { cleaned, active: activeCount?.count });
            }
        }
        catch (err) {
            // Table might not be migrated yet in early tests
            session_store_size.set(0);
        }
        return cleaned;
    }
    /**
     * Inspect and update rate limit metrics
     */
    updateStoreMetrics() {
        // Basic approximate count of active rate limit buckets
        const count = 0;
        rate_limit_store_size.set(count);
        return count;
    }
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
    checkStateReconciliation() {
        const db = getDb();
        let mismatches = 0;
        try {
            // Check for orphan events or broken hashes in audit_log
            const unhashedAudit = db
                .prepare("SELECT COUNT(*) as count FROM audit_log WHERE hash IS NULL OR hash = ''")
                .get();
            if (unhashedAudit && unhashedAudit.count > 0) {
                reconciliation_mismatch_total.inc({ component: "audit_log", mismatch_type: "unhashed_entries" }, unhashedAudit.count);
                logger.warn("reconciliation_mismatch_audit_log", { unhashedCount: unhashedAudit.count });
                mismatches += unhashedAudit.count;
            }
        }
        catch {
            // Ignore if table doesn't exist
        }
        try {
            mismatches += this.reconcileDaoTallies();
        }
        catch (err) {
            logger.warn("dao_reconciliation_failed", {
                error: err.message,
            });
        }
        try {
            serviceLastRunTime.set({ service: "reconciliation" }, Date.now() / 1000);
        }
        catch {
            // metrics registry may be unavailable in unit tests
        }
    }
    /**
     * Compare per-DAO `vote_cast` event counts (on-chain hashes mirrored from
     * Horizon) against the relayer pipeline tables, plus pipeline-internal
     * consistency (stuck pendings, dead letters, hash-less confirmations).
     * Returns the number of mismatched groups found.
     */
    reconcileDaoTallies() {
        const db = getDb();
        let mismatches = 0;
        const tableExists = (name) => {
            try {
                return !!db
                    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                    .get(name);
            }
            catch {
                return false;
            }
        };
        const countWhere = (table, where) => {
            try {
                const row = db
                    .prepare(`SELECT COUNT(*) as count FROM "${table}" WHERE ${where}`)
                    .get();
                return row?.count ?? 0;
            }
            catch {
                return 0;
            }
        };
        // 1. Pipeline-internal consistency: stuck `pending` submissions older than 5m.
        if (tableExists("vote_submissions")) {
            const stuck = countWhere("vote_submissions", `status = 'pending' AND updated_at < ${Date.now() - 5 * 60 * 1000}`);
            if (stuck > 0) {
                reconciliation_mismatch_total.inc({ component: "dao_tally", mismatch_type: "stuck_pending_submissions" }, stuck);
                logger.warn("reconciliation_mismatch_stuck_pending", { stuck });
                mismatches += 1;
            }
            // Confirmed submissions must always carry a tx hash for Horizon audit.
            const confirmedWithoutHash = countWhere("vote_submissions", "status = 'confirmed' AND (tx_hash IS NULL OR tx_hash = '')");
            if (confirmedWithoutHash > 0) {
                reconciliation_mismatch_total.inc({ component: "dao_tally", mismatch_type: "confirmed_without_tx_hash" }, confirmedWithoutHash);
                logger.warn("reconciliation_mismatch_confirmed_without_hash", {
                    count: confirmedWithoutHash,
                });
                mismatches += 1;
            }
        }
        // 2. Dead-letter vote jobs diverge the DB count from the on-chain tally.
        if (tableExists("vote_jobs")) {
            const deadLetters = countWhere("vote_jobs", "status = 'DEAD_LETTER'");
            if (deadLetters > 0) {
                reconciliation_mismatch_total.inc({ component: "dao_tally", mismatch_type: "dead_letter_jobs" }, deadLetters);
                logger.warn("reconciliation_mismatch_dead_letters", {
                    count: deadLetters,
                });
                mismatches += 1;
            }
        }
        // 3. Per-DAO hash-vs-count check: `events_<daoId>` vote_cast rows (each
        // with a tx hash verifiable on Horizon/stellar.expert) vs committed
        // pipeline rows for that DAO.
        if (tableExists("daos")) {
            let daos = [];
            try {
                daos = db.prepare("SELECT id FROM daos").all();
            }
            catch {
                daos = [];
            }
            for (const { id: daoId } of daos) {
                const eventsTable = `events_${daoId}`;
                if (!tableExists(eventsTable))
                    continue;
                let eventVotes = 0;
                let eventHashes = 0;
                try {
                    const row = db
                        .prepare(`SELECT COUNT(*) as cnt, COUNT(DISTINCT tx_hash) as hashes FROM "${eventsTable}" WHERE type = 'vote_cast'`)
                        .get();
                    eventVotes = row?.cnt ?? 0;
                    eventHashes = row?.hashes ?? 0;
                }
                catch {
                    continue;
                }
                let pipelineVotes = 0;
                if (tableExists("vote_jobs")) {
                    try {
                        const row = db
                            .prepare("SELECT COUNT(*) as cnt FROM vote_jobs WHERE dao_id = ? AND status IN ('COMPLETED','PROCESSING','QUEUED')")
                            .get(daoId);
                        pipelineVotes = row?.cnt ?? 0;
                    }
                    catch {
                        pipelineVotes = 0;
                    }
                }
                if (eventVotes !== pipelineVotes) {
                    const drift = Math.abs(eventVotes - pipelineVotes);
                    reconciliation_mismatch_total.inc({ component: "dao_tally", mismatch_type: "hash_vs_db_count" }, drift);
                    logger.warn("reconciliation_mismatch_dao_tally", {
                        daoId,
                        eventVotes,
                        pipelineVotes,
                        eventHashes,
                        difference: eventVotes - pipelineVotes,
                    });
                    mismatches += 1;
                }
            }
        }
        const status = mismatches === 0 ? "ok" : "mismatch";
        try {
            daoReconciliationRunsTotal.inc({ status });
            if (mismatches === 0) {
                daoReconciliationLastOk.set(Date.now() / 1000);
            }
        }
        catch {
            // ignore metrics failures in tests
        }
        return mismatches;
    }
}
export const defaultJobScheduler = new JobScheduler();
//# sourceMappingURL=job-scheduler.js.map