/**
 * Sync Service
 *
 * Handles DAO and membership synchronization from contracts to local cache.
 */
export declare const daoMembersCache: Map<number, Set<string>>;
export declare const daoAdminsCache: Map<number, string>;
/**
 * Sync all DAOs from the DAO Registry contract to local cache
 */
export declare function syncDaosFromContract(): Promise<number>;
/**
 * Start background DAO sync
 */
export declare function startDaoSync(): void;
/**
 * Stop background DAO sync
 */
export declare function stopDaoSync(): void;
/**
 * Sync members for a single DAO
 */
export declare function syncDaoMembership(daoId: number): Promise<void>;
/**
 * Sync all memberships
 */
export declare function syncAllMemberships(): Promise<void>;
/**
 * Start background membership sync
 */
export declare function startMembershipSync(): void;
/**
 * Stop background membership sync
 */
export declare function stopMembershipSync(): void;
/**
 * Trigger membership sync for specific DAO
 */
export declare function triggerDaoMembershipSync(daoId: number): Promise<void>;
//# sourceMappingURL=sync.d.ts.map