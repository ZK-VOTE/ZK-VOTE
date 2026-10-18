/**
 * #592 Per-DAO registry pin + allowlist + deployer attestation.
 * Voting create_proposal admin checks must call only the pinned registry
 * contract id whose code hash matches the pinned registry_hash.
 */
import { unauthenticatedRejectionTotal, crossTenantDenialTotal } from "./metrics.js";
import { incWithDrilldown } from "./metric-drilldown.js";

const pins = new Map<number, { registryId: string; registryHash: string }>();
const allowlist = new Set<string>((process.env.REGISTRY_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean));

export function pinRegistry(daoId: number, registryId: string, registryHash: string): void {
  pins.set(daoId, { registryId, registryHash });
  allowlist.add(registryId);
}

export function getRegistryPin(daoId: number): { registryId: string; registryHash: string } | undefined {
  return pins.get(daoId);
}

/** Verify a get_admin response origin before trusting it. */
export function verifyRegistryCaller(daoId: number, callerId: string, callerHash?: string): void {
  const pin = pins.get(daoId);
  // Bounded labels on the metric; the DAO and caller go on the drill-down log.
  if (!pin) {
    incWithDrilldown(
      unauthenticatedRejectionTotal,
      { endpoint: "registry", reason: "registry_not_pinned" },
      { dao_id: daoId, caller: callerId },
      { level: "warn" },
    );
    throw new Error("Registry not pinned for DAO");
  }
  if (callerId !== pin.registryId || !allowlist.has(callerId)) {
    incWithDrilldown(
      crossTenantDenialTotal,
      { target_resource: "registry", reason: "caller_not_allowlisted" },
      { dao_id: daoId, caller: callerId },
      { level: "warn" },
    );
    throw new Error("Registry caller not allowlisted (fake-registry spoof blocked)");
  }
  if (callerHash && callerHash !== pin.registryHash) {
    incWithDrilldown(
      crossTenantDenialTotal,
      { target_resource: "registry", reason: "code_hash_mismatch" },
      { dao_id: daoId, caller: callerId },
      { level: "warn" },
    );
    throw new Error("Registry code hash mismatch (fake-registry spoof blocked)");
  }
}
