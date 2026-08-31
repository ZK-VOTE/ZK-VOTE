/**
 * Sync Service with Optimistic Concurrency Control (Copy-on-Write Cache Snapshots)
 *
 * Handles DAO and membership synchronization from contracts to local cache.
 * Implements immutable cache snapshots with atomic reference swapping to eliminate
 * race conditions during async interleaving, cache versioning, invalidation notifications,
 * and hit/miss metrics.
 */
import { EventEmitter } from "events";
import * as StellarSdk from "@stellar/stellar-sdk";
import { config, isValidContractId } from "../config.js";
import { log } from "./logger.js";
import * as dbService from "./db.js";
import { ensureDaoCreateEvent } from "./indexer.js";
import { server, relayerKeypair, callWithTimeout, simulateWithBackoff, sequenceManager, } from "./stellar.js";
import { serviceLastRunTime, serviceErrors, serviceRunning, daosSynced, membershipSyncsTotal, } from "./metrics.js";
import { markDegraded, markHealthy } from "./service-health.js";
import { sharedSingleFlight } from "../utils/singleflight.js";
// Initial empty snapshot
let currentSnapshot = {
    daoMembers: new Map(),
    daoAdmins: new Map(),
    version: 0,
    updatedAt: new Date().toISOString(),
};
// Hit/Miss Counters
let cacheHits = 0;
let cacheMisses = 0;
// Event Emitter for Cache Invalidation Notifications
export const cacheEmitter = new EventEmitter();
/**
 * Get current immutable cache snapshot
 */
export function getCacheSnapshot() {
    return currentSnapshot;
}
/**
 * Get current cache version counter
 */
export function getCacheVersion() {
    return currentSnapshot.version;
}
/**
 * Get member set for DAO with metrics tracking
 */
export function getDaoMembersFromCache(daoId) {
    const members = currentSnapshot.daoMembers.get(daoId);
    if (members) {
        cacheHits++;
    }
    else {
        cacheMisses++;
    }
    return members;
}
/**
 * Get admin address for DAO with metrics tracking
 */
export function getDaoAdminFromCache(daoId) {
    const admin = currentSnapshot.daoAdmins.get(daoId);
    if (admin) {
        cacheHits++;
    }
    else {
        cacheMisses++;
    }
    return admin;
}
/**
 * Get cache hit/miss metrics
 */
export function getCacheMetrics() {
    const total = cacheHits + cacheMisses;
    const hitRate = total > 0 ? Math.round((cacheHits / total) * 100) / 100 : 0;
    return {
        hits: cacheHits,
        misses: cacheMisses,
        hitRate,
        version: currentSnapshot.version,
        daoCount: currentSnapshot.daoMembers.size,
    };
}
/**
 * Register listener for cache invalidation notifications
 */
export function onCacheInvalidated(listener) {
    cacheEmitter.on("cache:invalidated", listener);
    return () => {
        cacheEmitter.off("cache:invalidated", listener);
    };
}
/**
 * Evict the oldest entries (in Map insertion order) once a snapshot map
 * exceeds the configured max size. Bounds memory growth of the DAO caches
 * (see #191) — insertion-order (FIFO) eviction is used rather than
 * access-order LRU because these maps are immutable copy-on-write
 * snapshots, and reordering on read would defeat that concurrency design.
 */
export function evictOldestOverflow(map, maxEntries) {
    if (map.size <= maxEntries)
        return map;
    const trimmed = new Map(map);
    while (trimmed.size > maxEntries) {
        const oldestKey = trimmed.keys().next().value;
        if (oldestKey === undefined)
            break;
        trimmed.delete(oldestKey);
    }
    return trimmed;
}
/**
 * Atomically swap cache snapshot reference (Copy-on-Write)
 */
function swapCacheSnapshot(newMembers, newAdmins) {
    const nextVersion = currentSnapshot.version + 1;
    const boundedMembers = evictOldestOverflow(newMembers, config.maxCachedDaos);
    const boundedAdmins = evictOldestOverflow(newAdmins, config.maxCachedDaos);
    const nextSnapshot = {
        daoMembers: boundedMembers,
        daoAdmins: boundedAdmins,
        version: nextVersion,
        updatedAt: new Date().toISOString(),
    };
    // Atomic reference swap
    currentSnapshot = nextSnapshot;
    // Emit invalidation notification to connected clients/subscribers
    cacheEmitter.emit("cache:invalidated", currentSnapshot);
    log("debug", "cache_snapshot_swapped", {
        version: nextVersion,
        daoCount: newMembers.size,
        adminCount: newAdmins.size,
    });
    return currentSnapshot;
}
// ============================================
// BACKWARD COMPATIBILITY PROXIES
// ============================================
export const daoMembersCache = new Proxy(new Map(), {
    get(_target, prop, receiver) {
        const snapshotMap = currentSnapshot.daoMembers;
        if (prop === "get") {
            return (key) => getDaoMembersFromCache(key);
        }
        if (prop === "has") {
            return (key) => snapshotMap.has(key);
        }
        if (prop === "size") {
            return snapshotMap.size;
        }
        if (prop === "set") {
            return (key, value) => {
                const nextMembers = new Map(currentSnapshot.daoMembers);
                nextMembers.set(key, value);
                swapCacheSnapshot(nextMembers, currentSnapshot.daoAdmins);
                return receiver;
            };
        }
        const val = Reflect.get(snapshotMap, prop, snapshotMap);
        return typeof val === "function" ? val.bind(snapshotMap) : val;
    },
});
export const daoAdminsCache = new Proxy(new Map(), {
    get(_target, prop, receiver) {
        const snapshotMap = currentSnapshot.daoAdmins;
        if (prop === "get") {
            return (key) => getDaoAdminFromCache(key);
        }
        if (prop === "has") {
            return (key) => snapshotMap.has(key);
        }
        if (prop === "size") {
            return snapshotMap.size;
        }
        if (prop === "set") {
            return (key, value) => {
                const nextAdmins = new Map(currentSnapshot.daoAdmins);
                nextAdmins.set(key, value);
                swapCacheSnapshot(currentSnapshot.daoMembers, nextAdmins);
                return receiver;
            };
        }
        const val = Reflect.get(snapshotMap, prop, snapshotMap);
        return typeof val === "function" ? val.bind(snapshotMap) : val;
    },
});
// ============================================
// DAO SYNC FROM CONTRACT
// ============================================
/**
 * Sync all DAOs from the DAO Registry contract to local cache
 */
export async function syncDaosFromContract() {
    return sharedSingleFlight.do("daos", async () => {
        if (!config.daoRegistryContractId ||
            !isValidContractId(config.daoRegistryContractId)) {
            log("warn", "dao_sync_skipped", {
                reason: "DAO_REGISTRY_CONTRACT_ID not configured",
            });
            return 0;
        }
        try {
            log("info", "dao_sync_start");
            const contract = new StellarSdk.Contract(config.daoRegistryContractId);
            const account = await server.getAccount(relayerKeypair.publicKey());
            // Get DAO count
            const countOp = contract.call("dao_count");
            const countTx = new StellarSdk.TransactionBuilder(account, {
                fee: "100",
                networkPassphrase: config.networkPassphrase,
            })
                .addOperation(countOp)
                .setTimeout(30)
                .build();
            const countSimResult = await callWithTimeout(() => simulateWithBackoff(() => server.simulateTransaction(countTx)), "simulate_dao_count");
            if (!StellarSdk.rpc.Api.isSimulationSuccess(countSimResult)) {
                log("warn", "dao_count_failed", { error: countSimResult.error });
                return 0;
            }
            const daoCount = Number(StellarSdk.scValToNative(countSimResult.result.retval));
            log("info", "dao_count_fetched", { count: daoCount });
            if (daoCount === 0) {
                dbService.setDaosSyncTime(new Date().toISOString());
                return 0;
            }
            // Fetch each DAO with bounded parallelism
            const daos = [];
            const daoIds = Array.from({ length: daoCount }, (_, i) => i + 1);
            const DAO_CHUNK_SIZE = 5;
            const fetchDao = async (i) => {
                try {
                    const daoAccount = await server.getAccount(relayerKeypair.publicKey());
                    const getOp = contract.call("get_dao", StellarSdk.nativeToScVal(i, { type: "u64" }));
                    const getTx = new StellarSdk.TransactionBuilder(daoAccount, {
                        fee: "100",
                        networkPassphrase: config.networkPassphrase,
                    })
                        .addOperation(getOp)
                        .setTimeout(30)
                        .build();
                    const getSimResult = await callWithTimeout(() => simulateWithBackoff(() => server.simulateTransaction(getTx)), `simulate_get_dao_${i}`);
                    if (StellarSdk.rpc.Api.isSimulationSuccess(getSimResult) &&
                        getSimResult.result?.retval) {
                        const daoData = StellarSdk.scValToNative(getSimResult.result.retval);
                        daos.push({
                            id: i,
                            name: daoData.name || `DAO ${i}`,
                            creator: daoData.creator || "",
                            membership_open: daoData.membership_open !== false,
                            members_can_propose: daoData.members_can_propose === true,
                            metadata_cid: daoData.metadata_cid || null,
                            member_count: Number(daoData.member_count || 0),
                        });
                    }
                }
                catch (err) {
                    log("warn", "dao_fetch_failed", {
                        daoId: i,
                        error: err.message,
                    });
                }
            };
            for (let i = 0; i < daoIds.length; i += DAO_CHUNK_SIZE) {
                const chunk = daoIds.slice(i, i + DAO_CHUNK_SIZE);
                await Promise.all(chunk.map((id) => fetchDao(id)));
            }
            // Save to database
            if (daos.length > 0) {
                dbService.upsertDaos(daos);
                // Ensure dao_create events exist
                for (const dao of daos) {
                    ensureDaoCreateEvent(dao.id, dao);
                }
            }
            dbService.setDaosSyncTime(new Date().toISOString());
            daosSynced.inc(daos.length);
            serviceLastRunTime.set({ service: "dao_sync" }, Date.now() / 1000);
            log("info", "dao_sync_complete", {
                synced: daos.length,
                total: daoCount,
            });
            return daos.length;
        }
        catch (err) {
            serviceErrors.inc({ service: "dao_sync" });
            log("error", "dao_sync_error", { error: err.message });
            return 0;
        }
    });
}
let daoSyncInterval = null;
/**
 * Start background DAO sync
 */
export function startDaoSync() {
    if (daoSyncInterval) {
        clearInterval(daoSyncInterval);
    }
    serviceRunning.set({ service: "dao_sync" }, 1);
    syncDaosFromContract()
        .then((count) => {
        log("info", "initial_dao_sync", { count });
        markHealthy("dao_sync");
    })
        .catch((err) => {
        markDegraded("dao_sync", err.message);
        log("error", "initial_dao_sync_failed", {
            error: err.message,
        });
    });
    daoSyncInterval = setInterval(() => {
        syncDaosFromContract()
            .then(() => markHealthy("dao_sync"))
            .catch((err) => {
            markDegraded("dao_sync", err.message);
            log("error", "periodic_dao_sync_failed", {
                error: err.message,
            });
        });
    }, config.daoSyncIntervalMs);
    log("info", "dao_sync_started", { intervalMs: config.daoSyncIntervalMs });
}
/**
 * Stop background DAO sync
 */
export function stopDaoSync() {
    if (daoSyncInterval) {
        clearInterval(daoSyncInterval);
        daoSyncInterval = null;
        serviceRunning.set({ service: "dao_sync" }, 0);
        log("info", "dao_sync_stopped");
    }
}
// ============================================
// MEMBERSHIP SYNC
// ============================================
/**
 * Sync members for a single DAO (uses Copy-on-Write atomic snapshot update)
 */
export async function syncDaoMembership(daoId) {
    if (!config.membershipSbtContractId ||
        !isValidContractId(config.membershipSbtContractId)) {
        return;
    }
    try {
        const sbtContract = new StellarSdk.Contract(config.membershipSbtContractId);
        const members = new Set();
        const BATCH_SIZE = 50;
        let offset = 0;
        let hasMore = true;
        while (hasMore) {
            const account = await server.getAccount(relayerKeypair.publicKey());
            const getMembersOp = sbtContract.call("get_members", StellarSdk.nativeToScVal(daoId, { type: "u64" }), StellarSdk.nativeToScVal(offset, { type: "u64" }), StellarSdk.nativeToScVal(BATCH_SIZE, { type: "u64" }));
            const getMembersTx = new StellarSdk.TransactionBuilder(account, {
                fee: "100",
                networkPassphrase: config.networkPassphrase,
            })
                .addOperation(getMembersOp)
                .setTimeout(30)
                .build();
            const simResult = await callWithTimeout(() => simulateWithBackoff(() => server.simulateTransaction(getMembersTx)), `simulate_get_members_${daoId}_${offset}`);
            if (StellarSdk.rpc.Api.isSimulationSuccess(simResult) &&
                simResult.result?.retval) {
                const memberAddresses = StellarSdk.scValToNative(simResult.result.retval);
                if (Array.isArray(memberAddresses) && memberAddresses.length > 0) {
                    for (const addr of memberAddresses) {
                        members.add(addr);
                    }
                    offset += memberAddresses.length;
                    hasMore = memberAddresses.length === BATCH_SIZE;
                }
                else {
                    hasMore = false;
                }
            }
            else {
                hasMore = false;
            }
        }
        // Build new map copy and atomically swap reference
        const nextMembersMap = new Map(currentSnapshot.daoMembers);
        nextMembersMap.set(daoId, members);
        swapCacheSnapshot(nextMembersMap, currentSnapshot.daoAdmins);
        log("info", "dao_membership_synced", { daoId, memberCount: members.size });
    }
    catch (err) {
        log("warn", "dao_membership_sync_failed", {
            daoId,
            error: err.message,
        });
    }
}
/**
 * Sync all memberships (uses Copy-on-Write atomic snapshot update)
 */
export async function syncAllMemberships() {
    if (!config.membershipSbtContractId ||
        !isValidContractId(config.membershipSbtContractId)) {
        log("warn", "membership_sync_skipped", {
            reason: "MEMBERSHIP_SBT_CONTRACT_ID not configured",
        });
        return;
    }
    const daos = dbService.getAllCachedDaos();
    if (daos.length === 0) {
        log("info", "membership_sync_skipped", { reason: "no DAOs in cache" });
        return;
    }
    log("info", "membership_sync_start", { daoCount: daos.length });
    // Prepare admin addresses copy
    const nextAdminsMap = new Map(currentSnapshot.daoAdmins);
    for (const dao of daos) {
        if (dao.creator) {
            nextAdminsMap.set(dao.id, dao.creator);
        }
    }
    // Sync DAOs with bounded parallelism
    const MEMBERSHIP_CHUNK_SIZE = 5;
    for (let i = 0; i < daos.length; i += MEMBERSHIP_CHUNK_SIZE) {
        const chunk = daos.slice(i, i + MEMBERSHIP_CHUNK_SIZE);
        await Promise.all(chunk.map((dao) => syncDaoMembership(dao.id)));
    }
    log("info", "membership_sync_complete", { daoCount: daos.length });
    membershipSyncsTotal.inc({ status: "success" });
    serviceLastRunTime.set({ service: "membership_sync" }, Date.now() / 1000);
}
let membershipSyncInterval = null;
/**
 * Start background membership sync
 */
export function startMembershipSync() {
    if (membershipSyncInterval) {
        clearInterval(membershipSyncInterval);
    }
    serviceRunning.set({ service: "membership_sync" }, 1);
    // Initial sync after DAO sync
    setTimeout(() => {
        syncAllMemberships().catch((err) => {
            log("error", "initial_membership_sync_failed", {
                error: err.message,
            });
        });
    }, 5000);
    membershipSyncInterval = setInterval(() => {
        syncAllMemberships().catch((err) => {
            log("error", "periodic_membership_sync_failed", {
                error: err.message,
            });
        });
    }, config.membershipSyncIntervalMs);
    log("info", "membership_sync_started", {
        intervalMs: config.membershipSyncIntervalMs,
    });
}
/**
 * Stop background membership sync
 */
export function stopMembershipSync() {
    if (membershipSyncInterval) {
        clearInterval(membershipSyncInterval);
        membershipSyncInterval = null;
        serviceRunning.set({ service: "membership_sync" }, 0);
        log("info", "membership_sync_stopped");
    }
}
/**
 * Graceful shutdown: flush sequence state so the next process starts clean.
 * Called by the shutdown handler after in-flight submissions have drained.
 */
export async function gracefulShutdownSync() {
    stopDaoSync();
    stopMembershipSync();
    try {
        await sequenceManager.forceResync(server);
        log("info", "sequence_persisted_on_shutdown");
    }
    catch (err) {
        log("warn", "sequence_resync_on_shutdown_failed", {
            error: err.message,
        });
    }
}
/**
 * Trigger membership sync for specific DAO
 */
export async function triggerDaoMembershipSync(daoId) {
    log("info", "triggered_membership_sync", { daoId });
    await syncDaoMembership(daoId);
}
// ============================================
// REAL-TIME MEMBERSHIP VERIFICATION
//
// daoMembersCache (above) is refreshed on a periodic interval and is fine for
// non-critical reads (e.g. displaying a user's role). For security-critical
// writes, a stale cache creates a window where a just-revoked member is still
// treated as a member. verifyMembership() closes that window by reading the
// SBT contract's `has()` directly, with a short-TTL result cache so bursts of
// writes from the same caller don't each pay a full RPC round trip.
// ============================================
const MEMBERSHIP_VERIFICATION_TTL_MS = 30_000;
const membershipVerificationCache = new Map();
const membershipVerificationMetrics = {
    checks: 0,
    chainCalls: 0,
    cacheHits: 0,
    mismatches: 0,
    errors: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
};
/**
 * Latency/hit-rate/mismatch metrics for verifyMembership(), for monitoring.
 */
export function getMembershipVerificationMetrics() {
    const { checks, chainCalls, cacheHits, mismatches, errors, totalLatencyMs, maxLatencyMs, } = membershipVerificationMetrics;
    return {
        checks,
        chainCalls,
        cacheHits,
        mismatches,
        errors,
        avgLatencyMs: chainCalls > 0
            ? Math.round((totalLatencyMs / chainCalls) * 100) / 100
            : 0,
        maxLatencyMs,
    };
}
function membershipCacheKey(daoId, address) {
    return `${daoId}:${address}`;
}
/** Test/ops hook: clear the short-TTL verification cache. */
export function clearMembershipVerificationCache() {
    membershipVerificationCache.clear();
}
/**
 * Real-time on-chain membership check via the Membership SBT contract's
 * `has(dao_id, of)` read entrypoint — the source of truth for write-path
 * authorization. Results are cached for MEMBERSHIP_VERIFICATION_TTL_MS (30s)
 * to bound RPC load; a cache miss/mismatch against the periodic daoMembersCache
 * is logged for monitoring. Throws if the on-chain check itself cannot be
 * completed (RPC error) — callers should fail closed (reject the write)
 * rather than silently falling back to the periodic cache.
 */
export async function verifyMembership(daoId, address) {
    membershipVerificationMetrics.checks++;
    const key = membershipCacheKey(daoId, address);
    const cached = membershipVerificationCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        membershipVerificationMetrics.cacheHits++;
        return cached.result;
    }
    if (!config.membershipSbtContractId ||
        !isValidContractId(config.membershipSbtContractId)) {
        throw new Error("Membership verification unavailable: MEMBERSHIP_SBT_CONTRACT_ID not configured");
    }
    const start = Date.now();
    try {
        const sbtContract = new StellarSdk.Contract(config.membershipSbtContractId);
        const account = await server.getAccount(relayerKeypair.publicKey());
        const operation = sbtContract.call("has", StellarSdk.nativeToScVal(daoId, { type: "u64" }), StellarSdk.xdr.ScVal.scvAddress(StellarSdk.Address.fromString(address).toScAddress()));
        const tx = new StellarSdk.TransactionBuilder(account, {
            fee: "100",
            networkPassphrase: config.networkPassphrase,
        })
            .addOperation(operation)
            .setTimeout(30)
            .build();
        const simResult = await callWithTimeout(() => simulateWithBackoff(() => server.simulateTransaction(tx)), `simulate_verify_membership_${daoId}`);
        if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult) ||
            !simResult.result?.retval) {
            throw new Error("Membership verification simulation failed");
        }
        const isMember = Boolean(StellarSdk.scValToNative(simResult.result.retval));
        const latencyMs = Date.now() - start;
        membershipVerificationMetrics.chainCalls++;
        membershipVerificationMetrics.totalLatencyMs += latencyMs;
        membershipVerificationMetrics.maxLatencyMs = Math.max(membershipVerificationMetrics.maxLatencyMs, latencyMs);
        const cachedMembers = getDaoMembersFromCache(daoId);
        const cachedSaysMember = cachedMembers?.has(address) ?? false;
        if (cachedSaysMember !== isMember) {
            membershipVerificationMetrics.mismatches++;
            log("warn", "membership_cache_mismatch", {
                daoId,
                cachedMember: cachedSaysMember,
                onChainMember: isMember,
            });
        }
        membershipVerificationCache.set(key, {
            result: isMember,
            expiresAt: Date.now() + MEMBERSHIP_VERIFICATION_TTL_MS,
        });
        log("debug", "membership_verified_realtime", {
            daoId,
            isMember,
            latencyMs,
        });
        return isMember;
    }
    catch (err) {
        membershipVerificationMetrics.errors++;
        log("error", "membership_verify_failed", {
            daoId,
            error: err.message,
        });
        throw err;
    }
}
//# sourceMappingURL=sync.js.map