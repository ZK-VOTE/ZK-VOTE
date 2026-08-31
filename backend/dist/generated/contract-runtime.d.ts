/**
 * Generated compatibility metadata for deployed contract runtimes.
 *
 * Keep this file in sync with contract `version()` / `storage_version()`
 * entrypoints whenever a protocol upgrade changes contract or storage layout.
 */
export interface ContractRuntimeCompatibility {
    contract: "dao-registry" | "membership-sbt" | "membership-tree" | "voting" | "comments";
    minSupportedContractVersion: number;
    maxSupportedContractVersion: number;
    minSupportedStorageVersion: number;
    maxSupportedStorageVersion: number;
}
export declare const CONTRACT_RUNTIME_COMPATIBILITY: {
    readonly voting: {
        readonly contract: "voting";
        readonly minSupportedContractVersion: 2;
        readonly maxSupportedContractVersion: 2;
        readonly minSupportedStorageVersion: 1;
        readonly maxSupportedStorageVersion: 1;
    };
    readonly daoRegistry: {
        readonly contract: "dao-registry";
        readonly minSupportedContractVersion: 1;
        readonly maxSupportedContractVersion: 1;
        readonly minSupportedStorageVersion: 1;
        readonly maxSupportedStorageVersion: 1;
    };
};
//# sourceMappingURL=contract-runtime.d.ts.map