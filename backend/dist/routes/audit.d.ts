/**
 * Audit Routes - Query & Export for accountability
 *
 * Provides:
 * - GET /audit/logs - query audit trail with filters
 * - GET /audit/export - export audit logs (json/csv)
 * - GET /audit/stats - summary stats
 *
 * All endpoints require authentication (authGuard) to prevent leaking audit metadata.
 * Logs themselves are already redacted, but access control adds defense in depth.
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=audit.d.ts.map