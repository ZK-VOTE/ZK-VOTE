/**
 * Protocol upgrade coordinator.
 *
 * Implements the prepare -> verify -> commit handshake declared in
 * `releases/compatibility-manifest.json`. The chain contracts enforce the
 * per-contract half (voting refuses to commit without a prepared+verified
 * manifest and holds a migration barrier on vote submission); this service is
 * the cross-contract/train half: compatibility validation, readiness gates,
 * rollback choreography and indexer event emission.
 *
 * It is dependency-injected and has no runtime imports beyond node:crypto, so
 * the state machine can be tested without a chain or a database.
 */

import { createHash } from "node:crypto";

export interface ContractRequirement {
  version: number;
  storageVersion: number;
  minVersion: number;
  circuitId?: string;
}

export interface CompatibilityManifest {
  schemaVersion: number;
  release: string;
  description?: string;
  contracts: Record<string, ContractRequirement>;
  backendSchemaVersion: number;
  upgradeOrder: string[];
  rollbackOrder: string[];
  readiness: {
    pauseVoteSubmissionDuringMigration: boolean;
    requireBackendSchemaMatch: boolean;
    requireNoCircuitOverlap: boolean;
  };
}

export interface ChainContractState {
  version: number;
  storageVersion: number;
  circuitId?: string;
}

export type ChainState = Record<string, ChainContractState>;

export interface BackendState {
  schemaVersion: number;
  migrationChecksumsMatch: boolean;
}

export interface ReadinessSnapshot {
  chain: ChainState;
  backend: BackendState;
  haltedTiers: number[];
  circuitMigrationOverlap: boolean;
  blackoutActive: boolean;
}

export interface UpgradeFinding {
  code: string;
  message: string;
  contract?: string;
}

export interface UpgradeEvent {
  type: "UpgradePrepared" | "UpgradeVerified" | "UpgradeCommitted" | "UpgradeRollback";
  release: string;
  manifestHash: string;
  contract?: string;
  [key: string]: unknown;
}

export type UpgradePhase = "prepare" | "verify" | "commit" | "rollback";

/** Deterministic hash of the manifest's canonical JSON (hash field excluded). */
export function manifestHash(manifest: CompatibilityManifest): string {
  const canonical = JSON.stringify(sortKeys(manifest as unknown as Record<string, unknown>));
  return createHash("sha256").update(canonical).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function validateManifest(value: unknown): CompatibilityManifest {
  const m = value as CompatibilityManifest;
  if (!m || m.schemaVersion !== 1) throw new Error("compatibility manifest schemaVersion must be 1");
  if (!m.contracts || typeof m.contracts !== "object") throw new Error("missing contracts");
  if (!Array.isArray(m.upgradeOrder) || !Array.isArray(m.rollbackOrder)) {
    throw new Error("upgradeOrder and rollbackOrder are required");
  }
  for (const name of m.upgradeOrder) {
    if (!m.contracts[name]) throw new Error(`upgradeOrder references unknown contract ${name}`);
  }
  if (m.rollbackOrder.length !== m.upgradeOrder.length) {
    throw new Error("rollbackOrder must cover every upgraded contract");
  }
  return m;
}

/** Reject a train that would leave any dependent contract incompatible. */
export function checkCompatibility(
  manifest: CompatibilityManifest,
  snapshot: ReadinessSnapshot,
): UpgradeFinding[] {
  const findings: UpgradeFinding[] = [];
  for (const [name, req] of Object.entries(manifest.contracts)) {
    const state = snapshot.chain[name];
    if (!state) {
      findings.push({ code: "contract_missing", contract: name, message: `${name} is absent from chain state` });
      continue;
    }
    if (state.version < req.minVersion) {
      findings.push({
        code: "below_min_version",
        contract: name,
        message: `${name} is at version ${state.version}, below the required minimum ${req.minVersion}`,
      });
    }
    if (state.storageVersion < req.storageVersion) {
      findings.push({
        code: "storage_version_downgrade",
        contract: name,
        message: `${name} storage version ${state.storageVersion} < ${req.storageVersion}`,
      });
    }
    if (req.circuitId && state.circuitId && state.circuitId !== req.circuitId) {
      findings.push({
        code: "circuit_id_mismatch",
        contract: name,
        message: `${name} uses circuit ${state.circuitId}, expected ${req.circuitId}`,
      });
    }
  }
  if (
    manifest.readiness.requireBackendSchemaMatch &&
    snapshot.backend.schemaVersion !== manifest.backendSchemaVersion
  ) {
    findings.push({
      code: "backend_schema_mismatch",
      message: `backend schema version ${snapshot.backend.schemaVersion} != ${manifest.backendSchemaVersion}`,
    });
  }
  if (!snapshot.backend.migrationChecksumsMatch) {
    findings.push({ code: "backend_migration_checksum", message: "backend migration checksums do not match" });
  }
  return findings;
}

export interface CoordinatorHooks {
  getSnapshot(): Promise<ReadinessSnapshot>;
  emit(event: UpgradeEvent): Promise<void> | void;
  /** Open/close the on-chain migration window (voting vote-submission gate). */
  setMigrationWindow(open: boolean): Promise<void> | void;
  /** Prepare/verify/commit one contract via its registry-gated entrypoints. */
  applyContract(
    contract: string,
    phase: UpgradePhase,
    hash: string,
    manifest: CompatibilityManifest,
  ): Promise<void> | void;
}

export class UpgradeCoordinator {
  private readonly manifest: CompatibilityManifest;
  private readonly hooks: CoordinatorHooks;

  constructor(manifest: CompatibilityManifest, hooks: CoordinatorHooks) {
    this.manifest = manifest;
    this.hooks = hooks;
  }

  get hash(): string {
    return manifestHash(this.manifest);
  }

  /** prepare never mutates versions; it binds every target to one manifest. */
  async prepare(): Promise<UpgradeEvent> {
    for (const contract of this.manifest.upgradeOrder) {
      await this.hooks.applyContract(contract, "prepare", this.hash, this.manifest);
    }
    const event: UpgradeEvent = {
      type: "UpgradePrepared",
      release: this.manifest.release,
      manifestHash: this.hash,
    };
    await this.hooks.emit(event);
    return event;
  }

  /**
   * verify opens the readiness barrier and re-checks every dependency. Votes
   * arriving after this point are rejected by voting with MigrationInProgress
   * or queued by the relayer; they are never partially processed.
   */
  async verify(): Promise<UpgradeEvent> {
    const snapshot = await this.hooks.getSnapshot();
    const findings = checkCompatibility(this.manifest, snapshot);
    if (findings.length) {
      throw new Error(`upgrade rejected: ${findings.map((f) => f.code).join(", ")}`);
    }
    if (this.manifest.readiness.requireNoCircuitOverlap && snapshot.circuitMigrationOverlap) {
      throw new Error("upgrade rejected: circuit migration overlap is active");
    }
    if (snapshot.blackoutActive) {
      throw new Error("upgrade rejected: election blackout is active");
    }
    if (this.manifest.readiness.pauseVoteSubmissionDuringMigration) {
      await this.hooks.setMigrationWindow(true);
    }
    for (const contract of this.manifest.upgradeOrder) {
      await this.hooks.applyContract(contract, "verify", this.hash, this.manifest);
    }
    const event: UpgradeEvent = {
      type: "UpgradeVerified",
      release: this.manifest.release,
      manifestHash: this.hash,
    };
    await this.hooks.emit(event);
    return event;
  }

  /** final commit; refuses to proceed if a dependency drifted since verify. */
  async commit(): Promise<UpgradeEvent> {
    const snapshot = await this.hooks.getSnapshot();
    const findings = checkCompatibility(this.manifest, snapshot);
    if (findings.length) {
      // Leave the barrier open: fail closed so no vote is processed against a
      // half-applied train. The operator must roll back explicitly.
      throw new Error(`commit rejected: ${findings.map((f) => f.code).join(", ")}`);
    }
    for (const contract of this.manifest.upgradeOrder) {
      await this.hooks.applyContract(contract, "commit", this.hash, this.manifest);
    }
    await this.hooks.setMigrationWindow(false);
    const event: UpgradeEvent = {
      type: "UpgradeCommitted",
      release: this.manifest.release,
      manifestHash: this.hash,
    };
    await this.hooks.emit(event);
    return event;
  }

  /**
   * Cascading rollback in reverse upgrade order. Each entry names the restoring
   * action; the voting contract restores its storage layout itself and the
   * circuit registry restores the previous circuit ID via the compensating
   * `restore_current_circuit` entrypoint.
   */
  rollbackPlan(): Array<{ contract: string; restore: string }> {
    return this.manifest.rollbackOrder.map((contract) => ({
      contract,
      restore:
        contract === "voting"
          ? "rollback_upgrade_from_registry (restores VERSION_KEY, STORAGE_VERSION_KEY and circuit pin)"
          : contract === "circuit-registry"
            ? "restore_current_circuit(dao_id, circuit_type, previous_circuit_id)"
            : `rollback_upgrade_from_registry for ${contract}`,
    }));
  }

  async rollback(): Promise<UpgradeEvent> {
    await this.hooks.setMigrationWindow(true);
    for (const step of this.rollbackPlan()) {
      await this.hooks.applyContract(step.contract, "rollback", this.hash, this.manifest);
    }
    await this.hooks.setMigrationWindow(false);
    const event: UpgradeEvent = {
      type: "UpgradeRollback",
      release: this.manifest.release,
      manifestHash: this.hash,
    };
    await this.hooks.emit(event);
    return event;
  }
}
