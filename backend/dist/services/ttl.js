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
import * as StellarSdk from "@stellar/stellar-sdk";
import { config, isValidContractId } from "../config.js";
import { server, relayerKeypair, callWithTimeout, withSequenceLock, waitForTransaction, } from "./stellar.js";
import { log } from "./logger.js";
import * as dbService from "./db.js";
// Default: run every 7 days (well within the 31-day TTL window)
const DEFAULT_TTL_RENEWAL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
let renewalTimer = null;
/**
 * Submit a real transaction calling a contract method.
 * Follows the simulate → prepare → sign → submit → wait pattern.
 */
async function submitCall(contractId, method, args = []) {
    try {
        return await withSequenceLock(async () => {
            const rpcServer = server;
            const sourceAccount = await rpcServer.getAccount(relayerKeypair.publicKey());
            const contract = new StellarSdk.Contract(contractId);
            const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
                fee: "1000000",
                networkPassphrase: config.networkPassphrase,
            })
                .addOperation(contract.call(method, ...args))
                .setTimeout(30)
                .build();
            // Simulate to get the prepared transaction
            const simResult = await callWithTimeout(() => rpcServer.simulateTransaction(tx), `ttl_sim_${method}`);
            if (StellarSdk.rpc.Api.isSimulationError(simResult)) {
                log("warn", "ttl_renewal_sim_error", {
                    contract: contractId.slice(0, 8) + "...",
                    method,
                    error: simResult.error,
                });
                return false;
            }
            // Prepare (adds auth & resource info)
            const prepared = StellarSdk.rpc
                .assembleTransaction(tx, simResult)
                .build();
            // Sign with relayer keypair
            prepared.sign(relayerKeypair);
            // Submit
            const sendResult = await callWithTimeout(() => rpcServer.sendTransaction(prepared), `ttl_send_${method}`);
            if (sendResult.status === "ERROR") {
                log("warn", "ttl_renewal_send_error", {
                    contract: contractId.slice(0, 8) + "...",
                    method,
                    status: sendResult.status,
                });
                return false;
            }
            // Wait for confirmation (max 15 attempts = 15s)
            await waitForTransaction(sendResult.hash, 15);
            return true;
        });
    }
    catch (err) {
        log("warn", "ttl_renewal_call_failed", {
            contract: contractId.slice(0, 8) + "...",
            method,
            error: err.message,
        });
        return false;
    }
}
/**
 * Extend TTLs for all contracts and their data.
 */
async function renewAllTTLs() {
    log("info", "ttl_renewal_started");
    const startTime = Date.now();
    let successCount = 0;
    let failCount = 0;
    // 1. Bump instance TTL on all contracts by calling version()
    const contractIds = [
        config.votingContractId,
        config.treeContractId,
        config.commentsContractId,
        config.daoRegistryContractId,
        config.membershipSbtContractId,
    ].filter((id) => !!id && isValidContractId(id));
    for (const contractId of contractIds) {
        const ok = await submitCall(contractId, "version");
        if (ok)
            successCount++;
        else
            failCount++;
        // Delay between calls to avoid sequence number issues
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    // If ALL contract calls failed, the network is likely down or reset.
    // Skip DAO-specific renewals to avoid wasting time.
    if (failCount === contractIds.length && contractIds.length > 0) {
        log("warn", "ttl_renewal_all_contracts_failed", {
            message: "Network may be down or reset. Skipping DAO data renewal.",
        });
        const durationMs = Date.now() - startTime;
        log("info", "ttl_renewal_completed", {
            successCount,
            failCount,
            durationMs,
        });
        return;
    }
    // 2. Bump persistent data for each known DAO
    try {
        const daos = dbService.getAllCachedDaos();
        for (const dao of daos) {
            const daoIdScVal = StellarSdk.nativeToScVal(dao.id, { type: "u64" });
            // Bump DAO registry data
            if (config.daoRegistryContractId &&
                isValidContractId(config.daoRegistryContractId)) {
                const ok = await submitCall(config.daoRegistryContractId, "get_dao", [
                    daoIdScVal,
                ]);
                if (ok)
                    successCount++;
                else
                    failCount++;
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
            // Bump tree root data
            if (config.treeContractId && isValidContractId(config.treeContractId)) {
                const ok = await submitCall(config.treeContractId, "current_root", [
                    daoIdScVal,
                ]);
                if (ok)
                    successCount++;
                else
                    failCount++;
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
            // Bump proposal count
            if (config.votingContractId &&
                isValidContractId(config.votingContractId)) {
                const ok = await submitCall(config.votingContractId, "proposal_count", [
                    daoIdScVal,
                ]);
                if (ok)
                    successCount++;
                else
                    failCount++;
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        }
    }
    catch (err) {
        log("warn", "ttl_renewal_dao_iteration_failed", {
            error: err.message,
        });
    }
    const durationMs = Date.now() - startTime;
    log("info", "ttl_renewal_completed", { successCount, failCount, durationMs });
}
/**
 * Start the periodic TTL renewal service.
 */
export function startTTLRenewal(intervalMs) {
    if (config.testMode)
        return;
    const interval = intervalMs ??
        Number(process.env.TTL_RENEWAL_INTERVAL_MS || DEFAULT_TTL_RENEWAL_INTERVAL_MS);
    // Run immediately on startup, then periodically
    renewAllTTLs().catch((err) => {
        log("error", "ttl_renewal_initial_failed", {
            error: err.message,
        });
    });
    renewalTimer = setInterval(() => {
        renewAllTTLs().catch((err) => {
            log("error", "ttl_renewal_periodic_failed", {
                error: err.message,
            });
        });
    }, interval);
    const intervalDays = (interval / (24 * 60 * 60 * 1000)).toFixed(1);
    log("info", "ttl_renewal_service_started", { intervalDays });
}
/**
 * Stop the TTL renewal service.
 */
export function stopTTLRenewal() {
    if (renewalTimer) {
        clearInterval(renewalTimer);
        renewalTimer = null;
        log("info", "ttl_renewal_service_stopped");
    }
}
//# sourceMappingURL=ttl.js.map