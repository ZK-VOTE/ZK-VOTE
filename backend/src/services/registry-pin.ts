/**
 * #592 Per-DAO registry pin + allowlist + deployer attestation.
 * Enhanced with Persistent Storage (ZV-118 / #957)
 * 
 * Voting create_proposal admin checks must call only the pinned registry
 * contract id whose code hash matches the pinned registry_hash.
 * 
 * Pins are persisted in the database for:
 * - Multi-replica consistency
 * - Restart resilience
 * - Audit trail
 * - Administrative rotation
 */
import { unauthenticatedRejectionTotal, crossTenantDenialTotal } from "./metrics.js";
import { incWithDrilldown } from "./metric-drilldown.js";
import { kysely } from "./kysely.js";
import { log } from "./logger.js";
import { getStellarClient } from "./stellar.js";

const allowlist = new Set<string>(
  (process.env.REGISTRY_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// In-memory cache for hot-path reads (refreshed on miss)
const pinCache = new Map<number, { registryId: string; registryHash: string; cachedAt: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Pins a registry contract to a DAO with code-hash verification.
 * Persists to database for multi-replica access (ZV-118).
 */
export async function pinRegistry(
  daoId: number,
  registryId: string,
  registryHash: string,
  pinnedBy?: string,
  reason?: string,
): Promise<void> {
  try {
    // Verify the on-chain WASM hash before pinning
    const onChainHash = await verifyOnChainCodeHash(registryId);
    
    if (onChainHash !== registryHash) {
      log("error", "registry_pin_hash_mismatch", {
        daoId,
        registryId,
        expectedHash: registryHash,
        onChainHash,
      });
      throw new Error(
        `Registry code hash mismatch: expected ${registryHash}, on-chain ${onChainHash}`
      );
    }

    // Check if pin already exists (for audit)
    const existingPin = await kysely
      .selectFrom("registry_pins")
      .select(["registry_id", "code_hash"])
      .where("dao_id", "=", daoId)
      .executeTakeFirst();

    // Insert or update pin
    await kysely
      .insertInto("registry_pins")
      .values({
        dao_id: daoId,
        registry_id: registryId,
        code_hash: registryHash,
        version: 1,
        pinned_at: new Date(),
        pinned_by: pinnedBy,
        last_verified_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column("dao_id").doUpdateSet({
          registry_id: registryId,
          code_hash: registryHash,
          version: kysely.raw("registry_pins.version + 1"),
          pinned_at: new Date(),
          pinned_by: pinnedBy,
          last_verified_at: new Date(),
        })
      )
      .execute();

    // Record audit event if this is a rotation
    if (existingPin) {
      await kysely
        .insertInto("registry_pin_audit")
        .values({
          dao_id: daoId,
          old_registry_id: existingPin.registry_id,
          old_code_hash: existingPin.code_hash,
          new_registry_id: registryId,
          new_code_hash: registryHash,
          rotated_by: pinnedBy || "system",
          reason: reason || "pin_update",
          rotated_at: new Date(),
        })
        .execute();

      log("info", "registry_pin_rotated", {
        daoId,
        oldRegistry: existingPin.registry_id,
        newRegistry: registryId,
        pinnedBy,
      });
    } else {
      log("info", "registry_pin_created", {
        daoId,
        registryId,
        pinnedBy,
      });
    }

    // Update cache and allowlist
    pinCache.set(daoId, { registryId, registryHash, cachedAt: Date.now() });
    allowlist.add(registryId);
  } catch (error: any) {
    log("error", "registry_pin_failed", {
      daoId,
      registryId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Verifies the on-chain WASM code hash of a contract.
 * Returns the SHA-256 hash of the deployed WASM.
 */
async function verifyOnChainCodeHash(contractId: string): Promise<string> {
  try {
    const stellar = getStellarClient();
    const contract = await stellar.getContract(contractId);
    
    // Get the contract code (WASM)
    const wasmHash = contract.wasmHash;
    
    if (!wasmHash) {
      throw new Error(`Could not retrieve WASM hash for contract ${contractId}`);
    }
    
    return wasmHash;
  } catch (error: any) {
    log("error", "on_chain_hash_verification_failed", {
      contractId,
      error: error.message,
    });
    throw new Error(`Failed to verify on-chain code hash: ${error.message}`);
  }
}

/**
 * Retrieves the registry pin for a DAO.
 * Uses cache with TTL, falls back to database.
 */
export async function getRegistryPin(
  daoId: number
): Promise<{ registryId: string; registryHash: string } | undefined> {
  // Check cache first
  const cached = pinCache.get(daoId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return { registryId: cached.registryId, registryHash: cached.registryHash };
  }

  // Fetch from database
  try {
    const pin = await kysely
      .selectFrom("registry_pins")
      .select(["registry_id", "code_hash"])
      .where("dao_id", "=", daoId)
      .executeTakeFirst();

    if (pin) {
      // Update cache
      pinCache.set(daoId, {
        registryId: pin.registry_id,
        registryHash: pin.code_hash,
        cachedAt: Date.now(),
      });
      allowlist.add(pin.registry_id);
      return { registryId: pin.registry_id, registryHash: pin.code_hash };
    }

    return undefined;
  } catch (error: any) {
    log("error", "registry_pin_fetch_failed", {
      daoId,
      error: error.message,
    });
    return undefined;
  }
}

/**
 * Verifies a get_admin response origin before trusting it.
 * Enhanced with on-chain hash verification (ZV-118).
 */
export async function verifyRegistryCaller(
  daoId: number,
  callerId: string,
  callerHash?: string
): Promise<void> {
  const pin = await getRegistryPin(daoId);
  
  // Bounded labels on the metric; the DAO and caller go on the drill-down log.
  if (!pin) {
    incWithDrilldown(
      unauthenticatedRejectionTotal,
      { endpoint: "registry", reason: "registry_not_pinned" },
      { dao_id: daoId, caller: callerId },
      { level: "warn" }
    );
    throw new Error("Registry not pinned for DAO");
  }
  
  if (callerId !== pin.registryId || !allowlist.has(callerId)) {
    incWithDrilldown(
      crossTenantDenialTotal,
      { resource_type: "registry", reason: "caller_not_allowlisted" },
      { dao_id: daoId, caller: callerId },
      { level: "warn" }
    );
    throw new Error("Registry caller not allowlisted (fake-registry spoof blocked)");
  }
  
  // Verify code hash if provided
  if (callerHash && callerHash !== pin.registryHash) {
    incWithDrilldown(
      crossTenantDenialTotal,
      { resource_type: "registry", reason: "code_hash_mismatch" },
      { dao_id: daoId, caller: callerId },
      { level: "warn" }
    );
    throw new Error("Registry code hash mismatch (fake-registry spoof blocked)");
  }

  // Periodically re-verify on-chain hash (at use time)
  await reVerifyRegistryHashIfStale(daoId, pin.registryId, pin.registryHash);
}

/**
 * Re-verifies the on-chain code hash if it hasn't been checked recently.
 * Fails closed on hash mismatch (ZV-118).
 */
async function reVerifyRegistryHashIfStale(
  daoId: number,
  registryId: string,
  expectedHash: string
): Promise<void> {
  try {
    const pin = await kysely
      .selectFrom("registry_pins")
      .select(["last_verified_at"])
      .where("dao_id", "=", daoId)
      .executeTakeFirst();

    if (!pin) return;

    const now = new Date();
    const lastVerified = pin.last_verified_at ? new Date(pin.last_verified_at) : new Date(0);
    const hoursSinceVerification = (now.getTime() - lastVerified.getTime()) / (1000 * 60 * 60);

    // Re-verify every 24 hours
    if (hoursSinceVerification < 24) {
      return;
    }

    const onChainHash = await verifyOnChainCodeHash(registryId);

    if (onChainHash !== expectedHash) {
      log("error", "registry_hash_mismatch_detected", {
        daoId,
        registryId,
        expectedHash,
        onChainHash,
      });
      throw new Error(
        "Registry code hash changed on-chain! Potential contract upgrade or spoofing attempt."
      );
    }

    // Update last verified timestamp
    await kysely
      .updateTable("registry_pins")
      .set({ last_verified_at: now })
      .where("dao_id", "=", daoId)
      .execute();
  } catch (error: any) {
    log("error", "registry_hash_reverification_failed", {
      daoId,
      registryId,
      error: error.message,
    });
    // Fail closed: throw error to reject the call
    throw error;
  }
}

/**
 * Gets audit trail for registry pin rotations.
 */
export async function getRegistryPinAuditLog(
  daoId: number,
  limit: number = 50
): Promise<Array<{
  oldRegistryId: string | null;
  newRegistryId: string;
  rotatedBy: string;
  reason: string | null;
  rotatedAt: Date;
}>> {
  try {
    const logs = await kysely
      .selectFrom("registry_pin_audit")
      .select([
        "old_registry_id as oldRegistryId",
        "new_registry_id as newRegistryId",
        "rotated_by as rotatedBy",
        "reason",
        "rotated_at as rotatedAt",
      ])
      .where("dao_id", "=", daoId)
      .orderBy("rotated_at", "desc")
      .limit(limit)
      .execute();

    return logs;
  } catch (error: any) {
    log("error", "registry_audit_log_fetch_failed", {
      daoId,
      error: error.message,
    });
    return [];
  }
}
