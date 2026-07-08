/**
 * Sync Service
 *
 * Handles DAO and membership synchronization from contracts to local cache.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { config, isValidContractId } from "../config.js";
import { log } from "./logger.js";
import * as dbService from "./db.js";
import { ensureDaoCreateEvent } from "./indexer.js";
import { server, relayerKeypair, callWithTimeout, simulateWithBackoff, } from "./stellar.js";
// ============================================
// MEMBERSHIP CACHE (GLOBAL)
// ============================================
export const daoMembersCache = new Map(); // daoId -> Set<memberAddress>
export const daoAdminsCache = new Map(); // daoId -> adminAddress
// ============================================
// DAO SYNC FROM CONTRACT
// ============================================
/**
 * Sync all DAOs from the DAO Registry contract to local cache
 */
export async function syncDaosFromContract() {
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
        log("info", "dao_sync_complete", { synced: daos.length, total: daoCount });
        return daos.length;
    }
    catch (err) {
        log("error", "dao_sync_error", { error: err.message });
        return 0;
    }
}
let daoSyncInterval = null;
/**
 * Start background DAO sync
 */
export function startDaoSync() {
    if (daoSyncInterval) {
        clearInterval(daoSyncInterval);
    }
    syncDaosFromContract()
        .then((count) => {
        log("info", "initial_dao_sync", { count });
    })
        .catch((err) => {
        log("error", "initial_dao_sync_failed", {
            error: err.message,
        });
    });
    daoSyncInterval = setInterval(() => {
        syncDaosFromContract().catch((err) => {
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
        log("info", "dao_sync_stopped");
    }
}
// ============================================
// MEMBERSHIP SYNC
// ============================================
/**
 * Sync members for a single DAO
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
        daoMembersCache.set(daoId, members);
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
 * Sync all memberships
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
    // Cache admin addresses
    for (const dao of daos) {
        if (dao.creator) {
            daoAdminsCache.set(dao.id, dao.creator);
        }
    }
    // Sync DAOs with bounded parallelism
    const MEMBERSHIP_CHUNK_SIZE = 5;
    for (let i = 0; i < daos.length; i += MEMBERSHIP_CHUNK_SIZE) {
        const chunk = daos.slice(i, i + MEMBERSHIP_CHUNK_SIZE);
        await Promise.all(chunk.map((dao) => syncDaoMembership(dao.id)));
    }
    log("info", "membership_sync_complete", { daoCount: daos.length });
}
let membershipSyncInterval = null;
/**
 * Start background membership sync
 */
export function startMembershipSync() {
    if (membershipSyncInterval) {
        clearInterval(membershipSyncInterval);
    }
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
        log("info", "membership_sync_stopped");
    }
}
/**
 * Trigger membership sync for specific DAO
 */
export async function triggerDaoMembershipSync(daoId) {
    log("info", "triggered_membership_sync", { daoId });
    await syncDaoMembership(daoId);
}
//# sourceMappingURL=sync.js.map