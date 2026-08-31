import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { logger } from "./logger.js";
import { server, relayerKeypair, callWithTimeout } from "./stellar.js";
class CircuitRegistryCache {
    circuits = new Map();
    lastFetch = 0;
    ttl = 60_000;
    key(circuitId, circuitType) {
        return `${circuitType}:${circuitId}`;
    }
    get(circuitId, circuitType) {
        const entry = this.circuits.get(this.key(circuitId, circuitType));
        if (!entry)
            return undefined;
        if (Date.now() - this.lastFetch > this.ttl)
            return undefined;
        return entry;
    }
    set(circuitId, circuitType, info) {
        this.circuits.set(this.key(circuitId, circuitType), info);
        this.lastFetch = Date.now();
    }
    getAll(circuitType) {
        const result = [];
        for (const [key, info] of this.circuits) {
            if (key.startsWith(`${circuitType}:`)) {
                result.push(info);
            }
        }
        return result;
    }
}
const cache = new CircuitRegistryCache();
// Version tracking for ZK-013
const versionCache = new Map();
const VERSION_TTL_MS = 60_000;
export function getCache() {
    return cache;
}
export async function getCurrentVersion(circuitId) {
    const cached = versionCache.get(circuitId);
    if (cached && Date.now() - cached.fetchedAt < VERSION_TTL_MS) {
        return cached.version;
    }
    // Try to fetch from contract: get_current_version or fallback to 1
    // If not configured, return mock version based on circuitId
    const mockVersions = {
        vote_v1: 1,
        vote_v2: 2,
        weighted_vote: 1,
        bridge: 1,
        comment: 1,
        comment_v2: 2,
    };
    const ver = mockVersions[circuitId] ?? 1;
    versionCache.set(circuitId, { version: ver, fetchedAt: Date.now() });
    return ver;
}
export function isStaleVersion(requested, current) {
    return requested < current;
}
export function detectVKMismatch(proposalVersion, clientVersion) {
    return proposalVersion !== clientVersion;
}
export function invalidateVersionCache(circuitId) {
    if (!circuitId)
        versionCache.clear();
    else
        versionCache.delete(circuitId);
}
async function simulateContractCall(method, args) {
    const rpcServer = server;
    const contractId = config.circuitRegistryContractId;
    if (!contractId) {
        logger.error("circuit_registry_not_configured");
        return null;
    }
    try {
        const sourceAccount = await rpcServer.getAccount(relayerKeypair.publicKey());
        const contract = new StellarSdk.Contract(contractId);
        const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
            fee: "100000",
            networkPassphrase: config.networkPassphrase,
        })
            .addOperation(contract.call(method, ...args))
            .setTimeout(30)
            .build();
        const result = await callWithTimeout(() => rpcServer.simulateTransaction(tx), `circuit_registry_${method}`);
        if (StellarSdk.rpc.Api.isSimulationError(result)) {
            logger.error("circuit_registry_sim_error", {
                method,
                error: result.error,
            });
            return null;
        }
        return result;
    }
    catch (error) {
        logger.error("circuit_registry_sim_failed", {
            method,
            error: error.message,
        });
        return null;
    }
}
export async function getVK(circuitId, circuitType) {
    const args = [
        StellarSdk.nativeToScVal(circuitId, { type: "string" }),
        StellarSdk.nativeToScVal(circuitType, { type: "symbol" }),
    ];
    const response = await simulateContractCall("get_vk", args);
    if (!response?.result)
        return null;
    const scVal = response.result.retval;
    const mapEntries = scVal.map() ?? [];
    const parsed = {};
    for (const entry of mapEntries) {
        const key = entry.key().sym()?.toString() ?? "";
        const val = entry.val();
        if (key === "num_public_signals") {
            parsed[key] = Number(val.u32() ?? val.i32() ?? 0);
        }
        else if (key === "vk") {
            const vkMap = val.map() ?? [];
            const vk = {};
            for (const vkEntry of vkMap) {
                const vkKey = vkEntry.key().sym()?.toString() ?? "";
                const vkVal = vkEntry.val();
                if (vkKey === "ic") {
                    const points = [];
                    for (const elem of vkVal.vec() ?? []) {
                        points.push(Buffer.from(elem.bytes() ?? []).toString("hex"));
                    }
                    vk[vkKey] = points;
                }
                else {
                    vk[vkKey] = Buffer.from(vkVal.bytes() ?? []).toString("hex");
                }
            }
            parsed[key] = vk;
        }
    }
    return {
        vk: parsed.vk,
        numPublicSignals: parsed.num_public_signals,
    };
}
export async function getCircuitInfo(circuitId, circuitType) {
    const cached = cache.get(circuitId, circuitType);
    if (cached)
        return cached;
    const args = [
        StellarSdk.nativeToScVal(circuitId, { type: "string" }),
        StellarSdk.nativeToScVal(circuitType, { type: "symbol" }),
    ];
    const response = await simulateContractCall("get_circuit", args);
    if (!response?.result)
        return null;
    const scVal = response.result.retval;
    const mapEntries = scVal.map() ?? [];
    const parsed = {};
    for (const entry of mapEntries) {
        const key = entry.key().sym()?.toString() ?? "";
        const val = entry.val();
        if (key === "num_public_signals") {
            parsed[key] = Number(val.u32() ?? 0);
        }
        else if (key === "registered_at" || key === "expiration") {
            parsed[key] = Number(val.u64()?.toString() ?? val.i64()?.toString() ?? 0);
        }
        else if (key === "circuit_id") {
            parsed[key] = val.str()?.toString() ?? val.sym()?.toString() ?? "";
        }
        else if (key === "circuit_type") {
            parsed[key] = val.sym()?.toString() ?? "";
        }
        else if (key === "wasm_hash") {
            parsed[key] = Buffer.from(val.bytes() ?? []).toString("hex");
        }
    }
    const info = {
        circuitId: parsed.circuit_id,
        circuitType: parsed.circuit_type,
        registeredAt: parsed.registered_at,
        expiration: parsed.expiration,
        numPublicSignals: parsed.num_public_signals,
    };
    cache.set(circuitId, circuitType, info);
    return info;
}
export async function getDaoMigration(daoId) {
    const args = [StellarSdk.nativeToScVal(daoId, { type: "u64" })];
    const [isOverlap, migrationResponse] = await Promise.all([
        simulateContractCall("is_in_overlap_window", args),
        simulateContractCall("get_migration", args),
    ]);
    if (!migrationResponse?.result)
        return null;
    const scVal = migrationResponse.result.retval;
    const mapEntries = scVal.map() ?? [];
    const parsed = {};
    for (const entry of mapEntries) {
        const key = entry.key().sym()?.toString() ?? "";
        const val = entry.val();
        if (key === "dao_id") {
            parsed[key] = Number(val.u64()?.toString() ?? 0);
        }
        else if (key === "from_circuit_id" || key === "to_circuit_id") {
            parsed[key] = val.str()?.toString() ?? val.sym()?.toString() ?? "";
        }
        else if (key === "migration_start" || key === "deadline") {
            parsed[key] = Number(val.u64()?.toString() ?? 0);
        }
        else if (key === "active") {
            parsed[key] = val.b() ?? false;
        }
    }
    return {
        fromCircuitId: parsed.from_circuit_id,
        toCircuitId: parsed.to_circuit_id,
        deadline: parsed.deadline,
        inOverlapWindow: isOverlap?.result?.retval?.b() ?? false,
    };
}
export async function getDaoCurrentCircuit(daoId, circuitType) {
    const args = [
        StellarSdk.nativeToScVal(daoId, { type: "u64" }),
        StellarSdk.nativeToScVal(circuitType, { type: "symbol" }),
    ];
    const response = await simulateContractCall("get_dao_current_circuit", args);
    if (!response?.result)
        return null;
    return response.result.retval.str()?.toString() ?? null;
}
//# sourceMappingURL=circuit-registry.js.map