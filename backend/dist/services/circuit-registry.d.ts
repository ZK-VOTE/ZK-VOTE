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
export {};
//# sourceMappingURL=circuit-registry.d.ts.map