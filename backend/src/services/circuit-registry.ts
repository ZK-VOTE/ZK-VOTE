import * as StellarSdk from "@stellar/stellar-sdk";
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
  relayerKeypair: { publicKey(): string };
  /** Run `fn` with a timeout, labelled for logs/metrics. */
  callWithTimeout<T>(fn: () => Promise<T>, label: string): Promise<T>;
  /** circuit-registry contract id (may be unset → simulated calls return null). */
  circuitRegistryContractId: string | undefined;
  /** Network passphrase for transaction building. */
  networkPassphrase: string;
  /** Logger (defaults to the module logger if not provided). */
  logger: LoggerPort;
}

let deps: CircuitRegistryDeps | null = null;

/**
 * Explicitly wire the circuit-registry service's dependencies. Must be called
 * once at startup by the composition root before any request reaches the
 * /circuits routes.
 */
export function initCircuitRegistry(d: CircuitRegistryDeps): void {
  deps = d;
}

function getDeps(): CircuitRegistryDeps {
  if (!deps) {
    throw new Error(
      "circuit-registry: initCircuitRegistry() must be called before use",
    );
  }
  return deps;
}

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

class CircuitRegistryCache {
  private circuits: Map<string, CircuitInfo> = new Map();
  private lastFetch: number = 0;
  private ttl: number = 60_000;

  private key(circuitId: string, circuitType: string): string {
    return `${circuitType}:${circuitId}`;
  }

  get(circuitId: string, circuitType: string): CircuitInfo | undefined {
    const entry = this.circuits.get(this.key(circuitId, circuitType));
    if (!entry) return undefined;
    if (Date.now() - this.lastFetch > this.ttl) return undefined;
    return entry;
  }

  set(circuitId: string, circuitType: string, info: CircuitInfo): void {
    this.circuits.set(this.key(circuitId, circuitType), info);
    this.lastFetch = Date.now();
  }

  getAll(circuitType: string): CircuitInfo[] {
    const result: CircuitInfo[] = [];
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
const versionCache = new Map<string, { version: number; fetchedAt: number }>();
const VERSION_TTL_MS = 60_000;

export function getCache(): CircuitRegistryCache {
  return cache;
}

export async function getCurrentVersion(
  circuitId: string,
): Promise<number | null> {
  const cached = versionCache.get(circuitId);
  if (cached && Date.now() - cached.fetchedAt < VERSION_TTL_MS) {
    return cached.version;
  }
  // Try to fetch from contract: get_current_version or fallback to 1
  // If not configured, return mock version based on circuitId
  const mockVersions: Record<string, number> = {
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

export function isStaleVersion(requested: number, current: number): boolean {
  return requested < current;
}

export function detectVKMismatch(
  proposalVersion: number,
  clientVersion: number,
): boolean {
  return proposalVersion !== clientVersion;
}

export function invalidateVersionCache(circuitId?: string): void {
  if (!circuitId) versionCache.clear();
  else versionCache.delete(circuitId);
}

async function simulateContractCall(
  method: string,
  args: StellarSdk.xdr.ScVal[],
): Promise<StellarSdk.rpc.Api.SimulateTransactionSuccessResponse | null> {
  const { server, relayerKeypair, callWithTimeout, circuitRegistryContractId, networkPassphrase, logger } = getDeps();
  const rpcServer = server as unknown as StellarSdk.rpc.Server;
  const contractId = circuitRegistryContractId;
  if (!contractId) {
    logger.error("circuit_registry_not_configured");
    return null;
  }

  try {
    const sourceAccount = await rpcServer.getAccount(
      relayerKeypair.publicKey(),
    );
    const contract = new StellarSdk.Contract(contractId);

    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: "100000",
      networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const result = await callWithTimeout(
      () => rpcServer.simulateTransaction(tx),
      `circuit_registry_${method}`,
    );

    if (StellarSdk.rpc.Api.isSimulationError(result)) {
      logger.error("circuit_registry_sim_error", {
        method,
        error: result.error,
      });
      return null;
    }

    return result as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;
  } catch (error) {
    logger.error("circuit_registry_sim_failed", {
      method,
      error: (error as Error).message,
    });
    return null;
  }
}

export async function getVK(
  circuitId: string,
  circuitType: "Vote" | "Comment",
): Promise<CircuitVKResult | null> {
  const args = [
    StellarSdk.nativeToScVal(circuitId, { type: "string" }),
    StellarSdk.nativeToScVal(circuitType, { type: "symbol" }),
  ];

  const response = await simulateContractCall("get_vk", args);
  if (!response?.result) return null;

  const scVal = response.result.retval;
  const mapEntries = scVal.map() ?? [];
  const parsed: Record<string, unknown> = {};

  for (const entry of mapEntries) {
    const key = entry.key().sym()?.toString() ?? "";
    const val = entry.val();
    if (key === "num_public_signals") {
      parsed[key] = Number(val.u32() ?? val.i32() ?? 0);
    } else if (key === "vk") {
      const vkMap = val.map() ?? [];
      const vk: Record<string, unknown> = {};
      for (const vkEntry of vkMap) {
        const vkKey = vkEntry.key().sym()?.toString() ?? "";
        const vkVal = vkEntry.val();
        if (vkKey === "ic") {
          const points: string[] = [];
          for (const elem of vkVal.vec() ?? []) {
            points.push(Buffer.from(elem.bytes() ?? []).toString("hex"));
          }
          vk[vkKey] = points;
        } else {
          vk[vkKey] = Buffer.from(vkVal.bytes() ?? []).toString("hex");
        }
      }
      parsed[key] = vk;
    }
  }

  return {
    vk: parsed.vk as CircuitVKResult["vk"],
    numPublicSignals: parsed.num_public_signals as number,
  };
}

export async function getCircuitInfo(
  circuitId: string,
  circuitType: "Vote" | "Comment",
): Promise<CircuitInfo | null> {
  const cached = cache.get(circuitId, circuitType);
  if (cached) return cached;

  const args = [
    StellarSdk.nativeToScVal(circuitId, { type: "string" }),
    StellarSdk.nativeToScVal(circuitType, { type: "symbol" }),
  ];

  const response = await simulateContractCall("get_circuit", args);
  if (!response?.result) return null;

  const scVal = response.result.retval;
  const mapEntries = scVal.map() ?? [];
  const parsed: Record<string, unknown> = {};

  for (const entry of mapEntries) {
    const key = entry.key().sym()?.toString() ?? "";
    const val = entry.val();
    if (key === "num_public_signals") {
      parsed[key] = Number(val.u32() ?? 0);
    } else if (key === "registered_at" || key === "expiration") {
      parsed[key] = Number(val.u64()?.toString() ?? val.i64()?.toString() ?? 0);
    } else if (key === "circuit_id") {
      parsed[key] = val.str()?.toString() ?? val.sym()?.toString() ?? "";
    } else if (key === "circuit_type") {
      parsed[key] = val.sym()?.toString() ?? "";
    } else if (key === "wasm_hash") {
      parsed[key] = Buffer.from(val.bytes() ?? []).toString("hex");
    }
  }

  const info: CircuitInfo = {
    circuitId: parsed.circuit_id as string,
    circuitType: parsed.circuit_type as "Vote" | "Comment",
    registeredAt: parsed.registered_at as number,
    expiration: parsed.expiration as number,
    numPublicSignals: parsed.num_public_signals as number,
  };

  cache.set(circuitId, circuitType, info);
  return info;
}

export async function getDaoMigration(
  daoId: number,
): Promise<CircuitStatus["migration"] | null> {
  const args = [StellarSdk.nativeToScVal(daoId, { type: "u64" })];

  const [isOverlap, migrationResponse] = await Promise.all([
    simulateContractCall("is_in_overlap_window", args),
    simulateContractCall("get_migration", args),
  ]);

  if (!migrationResponse?.result) return null;

  const scVal = migrationResponse.result.retval;
  const mapEntries = scVal.map() ?? [];
  const parsed: Record<string, unknown> = {};

  for (const entry of mapEntries) {
    const key = entry.key().sym()?.toString() ?? "";
    const val = entry.val();
    if (key === "dao_id") {
      parsed[key] = Number(val.u64()?.toString() ?? 0);
    } else if (key === "from_circuit_id" || key === "to_circuit_id") {
      parsed[key] = val.str()?.toString() ?? val.sym()?.toString() ?? "";
    } else if (key === "migration_start" || key === "deadline") {
      parsed[key] = Number(val.u64()?.toString() ?? 0);
    } else if (key === "active") {
      parsed[key] = val.b() ?? false;
    }
  }

  return {
    fromCircuitId: parsed.from_circuit_id as string,
    toCircuitId: parsed.to_circuit_id as string,
    deadline: parsed.deadline as number,
    inOverlapWindow: isOverlap?.result?.retval?.b() ?? false,
  };
}

export async function getDaoCurrentCircuit(
  daoId: number,
  circuitType: "Vote" | "Comment",
): Promise<string | null> {
  const args = [
    StellarSdk.nativeToScVal(daoId, { type: "u64" }),
    StellarSdk.nativeToScVal(circuitType, { type: "symbol" }),
  ];

  const response = await simulateContractCall("get_dao_current_circuit", args);
  if (!response?.result) return null;
  return response.result.retval.str()?.toString() ?? null;
}

export async function proposeVkUpgrade(args: {
  circuitId: string;
  circuitType: "Vote" | "Comment";
  newVk: CircuitVKResult["vk"];
  newWasmHash: string;
  timelockDuration: number;
  requiredApprovals: number;
  daoId?: number;
  proposer: string;
}): Promise<number> {
  const {
    circuitId,
    circuitType,
    newVk,
    newWasmHash,
    timelockDuration,
    requiredApprovals,
    daoId,
    proposer,
  } = args;

  const vkArgs = [
    StellarSdk.nativeToScVal(circuitId, { type: "string" }),
    StellarSdk.nativeToScVal(circuitType, { type: "symbol" }),
    StellarSdk.nativeToScVal(
      {
        alpha: newVk.alpha,
        beta: newVk.beta,
        gamma: newVk.gamma,
        delta: newVk.delta,
        ic: newVk.ic,
      },
      { type: "map" },
    ),
    StellarSdk.nativeToScVal(Buffer.from(newWasmHash, "hex"), { type: "bytes" }),
    StellarSdk.nativeToScVal(timelockDuration, { type: "u64" }),
    StellarSdk.nativeToScVal(requiredApprovals, { type: "u32" }),
    StellarSdk.nativeToScVal(daoId ?? null, { type: "u64" }),
    StellarSdk.nativeToScVal(proposer, { type: "address" }),
  ];

  const response = await simulateContractCall("propose_vk_upgrade", vkArgs);
  if (!response?.result) {
    throw new Error("Failed to propose VK upgrade");
  }
  return Number(response.result.retval.u32?.toString() ?? response.result.retval.i32?.toString() ?? 0);
}

export async function approveVkUpgrade(proposalId: number, approver: string): Promise<void> {
  const args = [
    StellarSdk.nativeToScVal(proposalId, { type: "u32" }),
    StellarSdk.nativeToScVal(approver, { type: "address" }),
  ];

  const response = await simulateContractCall("approve_vk_upgrade", args);
  if (StellarSdk.rpc.Api.isSimulationError(response)) {
    throw new Error(response.error);
  }
}

export async function executeVkUpgrade(proposalId: number, executor: string): Promise<void> {
  const args = [
    StellarSdk.nativeToScVal(proposalId, { type: "u32" }),
    StellarSdk.nativeToScVal(executor, { type: "address" }),
  ];

  const response = await simulateContractCall("execute_vk_upgrade", args);
  if (StellarSdk.rpc.Api.isSimulationError(response)) {
    throw new Error(response.error);
  }
}

export async function cancelVkUpgrade(proposalId: number, canceller: string): Promise<void> {
  const args = [
    StellarSdk.nativeToScVal(proposalId, { type: "u32" }),
    StellarSdk.nativeToScVal(canceller, { type: "address" }),
  ];

  const response = await simulateContractCall("cancel_vk_upgrade", args);
  if (StellarSdk.rpc.Api.isSimulationError(response)) {
    throw new Error(response.error);
  }
}

export async function getVkProposal(proposalId: number): Promise<{
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
} | null> {
  const args = [StellarSdk.nativeToScVal(proposalId, { type: "u32" })];

  const response = await simulateContractCall("get_vk_proposal", args);
  if (!response?.result) return null;

  const scVal = response.result.retval;
  const mapEntries = scVal.map() ?? [];
  const parsed: Record<string, unknown> = {};

  for (const entry of mapEntries) {
    const key = entry.key().sym()?.toString() ?? "";
    const val = entry.val();
    switch (key) {
      case "id":
        parsed[key] = Number(val.u32()?.toString() ?? val.i32()?.toString() ?? 0);
        break;
      case "circuit_id":
        parsed[key] = val.str()?.toString() ?? val.sym()?.toString() ?? "";
        break;
      case "circuit_type":
        parsed[key] = val.sym()?.toString() ?? "";
        break;
      case "proposed_by":
        parsed[key] = val.addr()?.toString() ?? "";
        break;
      case "proposed_at":
      case "execute_after":
        parsed[key] = Number(val.u64()?.toString() ?? val.i64()?.toString() ?? 0);
        break;
      case "required_approvals":
      case "approvals":
        parsed[key] = Number(val.u32()?.toString() ?? val.i32()?.toString() ?? 0);
        break;
      case "status":
        parsed[key] = val.sym()?.toString() ?? "";
        break;
      case "dao_id":
        parsed[key] = Number(val.u64()?.toString() ?? val.i64()?.toString() ?? 0);
        break;
    }
  }

  return {
    id: parsed.id as number,
    circuitId: parsed.circuit_id as string,
    circuitType: (parsed.circuit_type as "Vote" | "Comment") ?? "Vote",
    proposedBy: parsed.proposed_by as string,
    proposedAt: parsed.proposed_at as number,
    executeAfter: parsed.execute_after as number,
    requiredApprovals: parsed.required_approvals as number,
    approvals: parsed.approvals as number,
    status: parsed.status as "Pending" | "Approved" | "Executed" | "Cancelled",
    daoId: parsed.dao_id as number | undefined,
  };
}

export async function getDaoVkProposal(daoId: number): Promise<{
  id: number;
  circuitId: string;
  circuitType: "Vote" | "Comment";
  proposedBy: string;
  proposedAt: number;
  executeAfter: number;
  requiredApprovals: number;
  approvals: number;
  status: "Pending" | "Approved" | "Executed" | "Cancelled";
} | null> {
  const args = [StellarSdk.nativeToScVal(daoId, { type: "u64" })];

  const response = await simulateContractCall("get_dao_vk_proposal", args);
  if (!response?.result) return null;

  const scVal = response.result.retval;
  if (!scVal.map()) return null;

  const mapEntries = scVal.map() ?? [];
  const parsed: Record<string, unknown> = {};

  for (const entry of mapEntries) {
    const key = entry.key().sym()?.toString() ?? "";
    const val = entry.val();
    switch (key) {
      case "id":
        parsed[key] = Number(val.u32()?.toString() ?? val.i32()?.toString() ?? 0);
        break;
      case "circuit_id":
        parsed[key] = val.str()?.toString() ?? val.sym()?.toString() ?? "";
        break;
      case "circuit_type":
        parsed[key] = val.sym()?.toString() ?? "";
        break;
      case "proposed_by":
        parsed[key] = val.addr()?.toString() ?? "";
        break;
      case "proposed_at":
      case "execute_after":
        parsed[key] = Number(val.u64()?.toString() ?? val.i64()?.toString() ?? 0);
        break;
      case "required_approvals":
      case "approvals":
        parsed[key] = Number(val.u32()?.toString() ?? val.i32()?.toString() ?? 0);
        break;
      case "status":
        parsed[key] = val.sym()?.toString() ?? "";
        break;
    }
  }

  return {
    id: parsed.id as number,
    circuitId: parsed.circuit_id as string,
    circuitType: (parsed.circuit_type as "Vote" | "Comment") ?? "Vote",
    proposedBy: parsed.proposed_by as string,
    proposedAt: parsed.proposed_at as number,
    executeAfter: parsed.execute_after as number,
    requiredApprovals: parsed.required_approvals as number,
    approvals: parsed.approvals as number,
    status: parsed.status as "Pending" | "Approved" | "Executed" | "Cancelled",
  };
}
