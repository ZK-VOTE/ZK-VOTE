/**
 * Auth Token Scheduler Service
 *
 * Handles periodic background tasks:
 * - Automatic token rotation on configurable schedule
 * - Expiration of timed-out tokens
 * - Cleanup of revoked/expired tokens
 * - Audit log cleanup
 */
export declare function ensureLegacyTokenMigrated(): void;
export declare function startAuthScheduler(): void;
export declare function stopAuthScheduler(): void;
export declare function isAuthSchedulerRunning(): boolean;
//# sourceMappingURL=authScheduler.d.ts.map