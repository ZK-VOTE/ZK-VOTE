import * as StellarSdk from "@stellar/stellar-sdk";
import { server } from "./stellar.js";
import { config } from "../config.js";
import { log } from "./logger.js";
import { getTTLTracking, upsertTTLTracking, } from "./db.js";
const SOROBAN_TTL_LEDGERS = 31 * 17280;
const LEDGER_DURATION_MS = 5000;
function categorizeUrgency(remainingMs) {
    if (remainingMs < config.ttlGracePeriodMs)
        return "grace";
    if (remainingMs < config.ttlRenewalThresholdMs)
        return "warning";
    return "healthy";
}
export function estimateRemainingFromTracked(entry) {
    if (!entry || !entry.lastRenewedAt)
        return null;
    const lastRenewed = new Date(entry.lastRenewedAt).getTime();
    const elapsedMs = Date.now() - lastRenewed;
    const estimatedRemainingMs = SOROBAN_TTL_LEDGERS * LEDGER_DURATION_MS - elapsedMs;
    if (estimatedRemainingMs <= 0)
        return null;
    const remainingLedgers = Math.floor(estimatedRemainingMs / LEDGER_DURATION_MS);
    return {
        entryId: entry.entryId,
        contractId: entry.contractId,
        daoId: entry.daoId,
        method: entry.method,
        remainingMs: estimatedRemainingMs,
        remainingLedgers,
        urgency: categorizeUrgency(estimatedRemainingMs),
        tracked: true,
    };
}
export async function queryContractInstanceTTL(contractId) {
    try {
        if (config.testMode)
            return null;
        const rawId = StellarSdk.StrKey.decodeContract(contractId);
        const ledgerKey = StellarSdk.xdr.LedgerKey.contractData(new StellarSdk.xdr.LedgerKeyContractData({
            contract: StellarSdk.xdr.ScAddress.scAddressTypeContract(rawId),
            key: StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: StellarSdk.xdr.ContractDataDurability.persistent(),
        }));
        const response = await server.getLedgerEntries(ledgerKey);
        if (!response || !response.entries || response.entries.length === 0)
            return null;
        const entry = response.entries[0];
        const liveUntilLedger = entry.liveUntilLedgerSeq;
        const latestLedger = response.latestLedger;
        if (!liveUntilLedger || !latestLedger)
            return null;
        return {
            remainingLedgers: Math.max(0, liveUntilLedger - latestLedger),
            liveUntilLedger,
            latestLedger,
        };
    }
    catch (err) {
        log("debug", "ttl_query_instance_failed", {
            contract: contractId.slice(0, 8) + "...",
            error: err.message,
        });
        return null;
    }
}
export async function queryInstanceTTLWithFallback(contractId, entryId) {
    let remainingLedgers;
    let urgency;
    const onChain = await queryContractInstanceTTL(contractId);
    if (onChain) {
        remainingLedgers = onChain.remainingLedgers;
        const remainingMs = remainingLedgers * LEDGER_DURATION_MS;
        urgency = categorizeUrgency(remainingMs);
        upsertTTLTracking({
            entryId,
            contractId,
            daoId: null,
            method: "version",
            lastRenewedAt: null,
            remainingLedgers,
            urgency,
        });
    }
    else {
        const tracked = getTTLTracking(entryId);
        const estimated = estimateRemainingFromTracked(tracked);
        if (estimated) {
            remainingLedgers = estimated.remainingLedgers;
            urgency = estimated.urgency;
        }
        else {
            remainingLedgers = SOROBAN_TTL_LEDGERS;
            urgency = "healthy";
        }
    }
    const remainingMs = remainingLedgers * LEDGER_DURATION_MS;
    return {
        entryId,
        contractId,
        daoId: null,
        method: "version",
        remainingMs,
        remainingLedgers,
        urgency,
        tracked: !onChain,
    };
}
export async function queryPersistentTTLWithFallback(contractId, daoId, method, entryId) {
    const tracked = getTTLTracking(entryId);
    const estimated = estimateRemainingFromTracked(tracked);
    if (estimated) {
        return { ...estimated, tracked: true };
    }
    const remainingMs = SOROBAN_TTL_LEDGERS * LEDGER_DURATION_MS;
    return {
        entryId,
        contractId,
        daoId,
        method,
        remainingMs,
        remainingLedgers: SOROBAN_TTL_LEDGERS,
        urgency: "healthy",
        tracked: false,
    };
}
export function needsRenewal(info) {
    return info.remainingMs < config.ttlRenewalThresholdMs;
}
export function isInGracePeriod(info) {
    return info.urgency === "grace";
}
export function formatRemaining(info) {
    const days = Math.floor(info.remainingMs / 86400000);
    const hours = Math.floor((info.remainingMs % 86400000) / 3600000);
    return `${days}d ${hours}h`;
}
//# sourceMappingURL=ttl-checker.js.map