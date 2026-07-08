/**
 * Event Indexer Routes
 *
 * Handles event retrieval, indexer status, and event notifications.
 */
declare const router: import("express-serve-static-core").Router;
/**
 * Initialize the indexer routes with optional membership sync callback
 */
export declare function initIndexerRoutes(membershipSyncFn?: (daoId: number) => Promise<void>): void;
export default router;
//# sourceMappingURL=indexer.d.ts.map