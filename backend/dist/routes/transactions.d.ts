/**
 * Transaction Status Routes (#172)
 *
 * `GET /tx/:hash` returns the current confirmation status of a transaction,
 * serving as the polling fallback for frontends that do not (or cannot) use
 * the WebSocket confirmation feed. The queue answers from its in-memory state
 * (pending / cached outcome) and falls back to a single `getTransaction`
 * lookup for hashes it has never seen.
 */
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=transactions.d.ts.map