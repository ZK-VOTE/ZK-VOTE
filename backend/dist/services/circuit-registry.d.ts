import type { LoggerPort, RpcServerPort } from "./interfaces.js";
/**
 * Dependencies the circuit-registry service needs, injected explicitly via
 * `initCircuitRegistry` (called by the composition root at startup) so the
 * service never imports `stellar.js`'s module globals (#358).
 */
export interface CircuitRegistryDeps {
    /** Soroban RPC server (real or test stub). */
    server: RpcServerPort;
    /** Relayer keypair used to source simulation transactions. */
    relayerKeypair: {
        publicKey(): string;
    };
    /** Run `fn` with a timeout, labelled for logs/metrics. */
    callWithTimeout<T>(fn: () => Promise<T>, label: string): Promise<T>;
    /** circuit-registry contract id (may be unset → simulated calls return null). */
    circuitRegistryContractId: string | undefined;
    /** Network passphrase for transaction building. */
    networkPassphrase: string;
    /** Logger (defaults to the module logger if not provided). */
    logger: LoggerPort;
}
/**
 * Explicitly wire the circuit-registry service's dependencies. Must be called
 * once at startup by the composition root before any request reaches the
 * /circuits routes.
 */
export declare function initCircuitRegistry(d: CircuitRegistryDeps): void;
export interface CircuitInfo {
    circuitId: string;
    circuitType: "Vote" | "Comment";
    registeredAt: number;
    expiration: number;
    numPublicSignals: number;
}
export interface CircuitVKResult {
    vk: {
        alpha: string;
        beta: string;
        gamma: string;
        delta: string;
        ic: string[];
    };
    numPublicSignals: number;
}
export interface CircuitStatus {
    daoId: number;
    circuitType: "Vote" | "Comment";
    currentCircuit: string;
    availableCircuits: CircuitInfo[];
    migration?: {
        fromCircuitId: string;
        toCircuitId: string;
        deadline: number;
        inOverlapWindow: boolean;
    };
}
declare class CircuitRegistryCache {
    private circuits;
    private lastFetch;
    private ttl;
    private key;
    get(circuitId: string, circuitType: string): CircuitInfo | undefined;
    set(circuitId: string, circuitType: string, info: CircuitInfo): void;
    getAll(circuitType: string): CircuitInfo[];
}
export declare function getCache(): CircuitRegistryCache;
export declare function getCurrentVersion(circuitId: string): Promise<number | null>;
export declare function isStaleVersion(requested: number, current: number): boolean;
export declare function detectVKMismatch(proposalVersion: number, clientVersion: number): boolean;
export declare function invalidateVersionCache(circuitId?: string): void;
export declare function getVK(circuitId: string, circuitType: "Vote" | "Comment"): Promise<CircuitVKResult | null>;
export declare function getCircuitInfo(circuitId: string, circuitType: "Vote" | "Comment"): Promise<CircuitInfo | null>;
export declare function getDaoMigration(daoId: number): Promise<CircuitStatus["migration"] | null>;
export declare function getDaoCurrentCircuit(daoId: number, circuitType: "Vote" | "Comment"): Promise<string | null>;
export declare function proposeVkUpgrade(args: {
    circuitId: string;
    circuitType: "Vote" | "Comment";
    newVk: CircuitVKResult["vk"];
    newWasmHash: string;
    timelockDuration: number;
    requiredApprovals: number;
    daoId?: number;
    proposer: string;
}): Promise<number>;
export declare function approveVkUpgrade(proposalId: number, approver: string): Promise<void>;
export declare function executeVkUpgrade(proposalId: number, executor: string): Promise<void>;
export declare function cancelVkUpgrade(proposalId: number, canceller: string): Promise<void>;
export declare function getVkProposal(proposalId: number): Promise<{
    id: number;
    circuitId: string;
    circuitType: "Vote" | "Comment";
    proposedBy: string;
    proposedAt: number;
    executeAfter: number;
    requiredApprovals: number;
    approvals: number;
    status: "Pending" | "Approved" | "Executed" | "Cancelled";
    daoId?: number;
} | null>;
export declare function getDaoVkProposal(daoId: number): Promise<{
    id: number;
    circuitId: string;
    circuitType: "Vote" | "Comment";
    proposedBy: string;
    proposedAt: number;
    executeAfter: number;
    requiredApprovals: number;
    approvals: number;
    status: "Pending" | "Approved" | "Executed" | "Cancelled";
} | null>;
export {};
//# sourceMappingURL=circuit-registry.d.ts.map