/**
 * TTL Renewal Service
 *
 * Periodically submits real transactions that call cheap contract functions
 * to trigger TTL extension on instance and persistent storage. Without this,
 * contract data expires after ~31 days of inactivity and is permanently lost.
 *
 * Strategy:
 * - Submit `version()` call on each contract → triggers bump_instance
 * - Submit `get_dao()` for each known DAO → triggers bump_persistent on DAO data
 * - Submit `current_root()` for each DAO → keeps Merkle tree roots alive
 * - Submit `proposal_count()` for each DAO → keeps proposal counter alive
 *
 * These are real on-chain transactions (small gas cost ~0.01 XLM each).
 * Simulation alone does NOT extend TTLs — only committed transactions do.
 */
/**
 * Start the periodic TTL renewal service.
 */
export declare function startTTLRenewal(intervalMs?: number): void;
/**
 * Stop the TTL renewal service.
 */
export declare function stopTTLRenewal(): void;
//# sourceMappingURL=ttl.d.ts.map