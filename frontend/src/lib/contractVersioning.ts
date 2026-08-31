export interface ContractRuntimeVersion {
  contract:
    | "dao-registry"
    | "membership-sbt"
    | "membership-tree"
    | "voting"
    | "comments";
  minSupportedContractVersion: number;
  maxSupportedContractVersion: number;
  minSupportedStorageVersion: number;
  maxSupportedStorageVersion: number;
}

export interface OnChainStorageLayout {
  contract_version: number | bigint;
  storage_version: number | bigint;
  latest_migration_at?: number | bigint;
  rollback_to_version?: number | bigint | null;
  capabilities?: number[] | bigint[];
}

export const SUPPORTED_CONTRACT_RUNTIME: Record<
  string,
  ContractRuntimeVersion
> = {
  voting: {
    contract: "voting",
    minSupportedContractVersion: 2,
    maxSupportedContractVersion: 2,
    minSupportedStorageVersion: 1,
    maxSupportedStorageVersion: 1,
  },
  "dao-registry": {
    contract: "dao-registry",
    minSupportedContractVersion: 1,
    maxSupportedContractVersion: 1,
    minSupportedStorageVersion: 1,
    maxSupportedStorageVersion: 1,
  },
};

export function isRuntimeCompatible(
  supported: ContractRuntimeVersion,
  layout: OnChainStorageLayout,
): boolean {
  const contractVersion = Number(layout.contract_version);
  const storageVersion = Number(layout.storage_version);

  return (
    contractVersion >= supported.minSupportedContractVersion &&
    contractVersion <= supported.maxSupportedContractVersion &&
    storageVersion >= supported.minSupportedStorageVersion &&
    storageVersion <= supported.maxSupportedStorageVersion
  );
}

export function describeRuntimeCompatibility(
  supported: ContractRuntimeVersion,
  layout: OnChainStorageLayout,
): { compatible: boolean; reason?: string } {
  if (isRuntimeCompatible(supported, layout)) {
    return { compatible: true };
  }

  return {
    compatible: false,
    reason: `${supported.contract} runtime ${Number(layout.contract_version)} / storage ${Number(
      layout.storage_version,
    )} is outside supported contract ${supported.minSupportedContractVersion}-${supported.maxSupportedContractVersion} and storage ${supported.minSupportedStorageVersion}-${supported.maxSupportedStorageVersion}`,
  };
}
