// @ts-nocheck
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
  /**
   * Explicit test-mode flag. Defaults to RELAYER_TEST_MODE so the deterministic
   * mock provider can never be selected implicitly in production.
   */
  testMode?: boolean;
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
  deps = {
    ...d,
    testMode: d.testMode ?? process.env.RELAYER_TEST_MODE === "true",
  };
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

/** Thrown when the registry cannot be read. Always fail closed. */
export class CircuitRegistryUnavailableError extends Error {
  readonly status = 503;
  readonly code = "CIRCUIT_REGISTRY_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "CircuitRegistryUnavailableError";
  }
}

/** Thrown when a client asks for a VK version that has been rotated out. */
export class StaleVkError extends Error {
  readonly status = 410;
  readonly code = "STALE_VK_VERSION";
  constructor(
    public readonly circuitId: string,
    public readonly requestedVersion: number,
    public readonly currentVersion: number,
  ) {
    super(
      `Stale VK: ${circuitId} v${requestedVersion} is no longer current (current v${currentVersion})`,
    );
    this.name = "StaleVkError";
  }
}

/** Rich on-chain record returned by the additive `get_vk_record` contract fn. */
export interface VkRecord extends CircuitVKResult {
  circuitId: string;
  circuitType: "Vote" | "Comment";
  version: number;
  registeredAt: number;
  ceremonyTranscriptHash?: string;
}

export interface ResolveVkParams {
  daoId?: number;
  circuitId: string;
  circuitType?: "Vote" | "Comment";
  /** Omit to resolve the DAO/circuit's current version. */
  version?: number;
}

export interface ResolvedVk extends VkRecord {
  hash: string;
  currentVersion: number;
  daoId?: number;
  /** "on-chain" | "test-mode-mock" — synthetic keys are always labelled. */
  source: string;
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

// Version tracking + centralized, fail-closed VK resolution (ZK-013).
const versionCache = new Map<string, { version: number; fetchedAt: number }>();
const VERSION_TTL_MS = 60_000;

/**
 * Resolved VK cache. Entries are keyed by DAO + circuit + circuit type +
 * version so a rotation for one DAO can never leak a stale key into another.
 */
const resolvedVkCache = new Map<string, ResolvedVk>();

function versionKey(circuitId: string, circuitType: string): string {
  return `${circuitId}:${circuitType}`;
}

function resolvedKey(params: {
  daoId?: number;
  circuitId: string;
  circuitType?: string;
  version: number;
}): string {
  return `${params.daoId ?? "*"}:${params.circuitId}:${params.circuitType ?? "Vote"}:${params.version}`;
}

export function getCache(): CircuitRegistryCache {
  return cache;
}

/** Deterministic preimage for the canonical VK hash (shared with SDK/client). */
export function stableStringifyVk(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyVk(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringifyVk(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Canonical SHA-256 of the on-chain VK record: domain + circuitId + version +
 * ceremony transcript hash + stable-stringified VK. Never a mock template.
 */
export async function computeCanonicalVkHash(input: {
  vk: CircuitVKResult["vk"];
  circuitId: string;
  version: number;
  ceremonyTranscriptHash?: string;
}): Promise<string> {
  const preimage = [
    "zkvote-vk-v1",
    input.circuitId,
    String(input.version),
    input.ceremonyTranscriptHash ?? "",
    stableStringifyVk(input.vk),
  ].join("\n");
  const bytes = new TextEncoder().encode(preimage);
  const cryptoApi = (globalThis as unknown as { crypto?: { subtle: SubtleCrypto } }).crypto;
  if (!cryptoApi?.subtle) {
    throw new CircuitRegistryUnavailableError(
      "Canonical VK hashing requires Web Crypto (globalThis.crypto.subtle)",
    );
  }
  const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Deterministic test-mode versions. Never consulted when testMode is false. */
const TEST_MODE_VERSIONS: Record<string, number> = {
  vote_v1: 1,
  vote_v2: 2,
  weighted_vote: 1,
  bridge: 1,
  comment: 1,
  comment_v2: 2,
};

/**
 * Resolve the current version from the registry. In production an unavailable
 * registry throws (fail closed); only explicit test mode may use the labelled
 * deterministic mock table.
 */
export async function getCurrentVersion(
  circuitId: string,
  circuitType: "Vote" | "Comment" = "Vote",
): Promise<number> {
  const key = versionKey(circuitId, circuitType);
  const cached = versionCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < VERSION_TTL_MS) {
    return cached.version;
  }

  const { testMode } = getDeps();
  if (testMode) {
    const ver = TEST_MODE_VERSIONS[circuitId] ?? 1;
    versionCache.set(key, { version: ver, fetchedAt: Date.now() });
    getDeps().logger.warn("circuit_registry_mock_version", {
      circuitId,
      circuitType,
      version: ver,
      source: "test-mode-mock",
    });
    return ver;
  }

  try {
    const record = await getVkRecord(circuitId, circuitType);
    versionCache.set(key, { version: record.version, fetchedAt: Date.now() });
    return record.version;
  } catch (error) {
    throw new CircuitRegistryUnavailableError(
      `Cannot resolve current version for ${circuitId}/${circuitType}: ${(error as Error).message}`,
    );
  }
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
  if (!circuitId) {
    versionCache.clear();
    return;
  }
  for (const key of versionCache.keys()) {
    if (key === circuitId || key.startsWith(`${circuitId}:`)) {
      versionCache.delete(key);
    }
  }
}

/**
 * Invalidate resolved VK cache entries. With no arguments everything is
 * dropped (rotation safety net); with a scope only matching DAO/circuit/type/
 * version entries are dropped.
 */
export function invalidateVkCache(
  scope: {
    daoId?: number;
    circuitId?: string;
    circuitType?: string;
    version?: number;
  } = {},
): void {
  const scoped = Object.keys(scope).some((key) => scope[key] !== undefined);
  if (!scoped) {
    resolvedVkCache.clear();
    return;
  }
  for (const key of Array.from(resolvedVkCache.keys())) {
    const [dao, circuit, type, ver] = key.split(":");
    if (scope.daoId !== undefined && dao !== String(scope.daoId)) continue;
    if (scope.circuitId !== undefined && circuit !== scope.circuitId) continue;
    if (scope.circuitType !== undefined && type !== scope.circuitType) continue;
    if (scope.version !== undefined && ver !== String(scope.version)) continue;
    resolvedVkCache.delete(key);
  }
}

/**
 * Central VK resolution used by routes and clients. All consumers get the same
 * `{ vk, hash, version, numPublicSignals, currentVersion }` for a given
 * DAO/circuit/version. Fails closed when the registry is unavailable.
 */
export async function resolveVk(params: ResolveVkParams): Promise<ResolvedVk> {
  const {
    daoId,
    circuitId,
    circuitType = "Vote",
    version,
  } = params;
  const { testMode } = getDeps();
  const currentVersion = await getCurrentVersion(circuitId, circuitType);
  const resolvedVersion = version ?? currentVersion;

  if (isStaleVersion(resolvedVersion, currentVersion)) {
    throw new StaleVkError(circuitId, resolvedVersion, currentVersion);
  }

  const key = resolvedKey({ daoId, circuitId, circuitType, version: resolvedVersion });
  const cached = resolvedVkCache.get(key);
  if (cached) return cached;

  const record = await getVkRecord(circuitId, circuitType);
  if (record.version !== resolvedVersion) {
    // The on-chain record has rotated past the requested version.
    throw new StaleVkError(circuitId, resolvedVersion, record.version);
  }

  const hash = await computeCanonicalVkHash({
    vk: record.vk,
    circuitId,
    version: resolvedVersion,
    ceremonyTranscriptHash: record.ceremonyTranscriptHash,
  });

  const resolved: ResolvedVk = {
    ...record,
    circuitId,
    circuitType,
    version: resolvedVersion,
    currentVersion,
    daoId,
    hash,
    source: testMode ? "test-mode-mock" : "on-chain",
  };
  resolvedVkCache.set(key, resolved);
  return resolved;
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

/** Parse a Groth16 VerificationKey ScVal map into hex strings. */
function parseVkScVal(vkVal: StellarSdk.xdr.ScVal): CircuitVKResult["vk"] {
  const vkMap = vkVal.map() ?? [];
  const vk: Record<string, unknown> = {};
  for (const vkEntry of vkMap) {
    const vkKey = vkEntry.key().sym()?.toString() ?? "";
    const val = vkEntry.val();
    if (vkKey === "ic") {
      vk.ic = (val.vec() ?? []).map((elem: StellarSdk.xdr.ScVal) =>
        Buffer.from(elem.bytes() ?? []).toString("hex"),
      );
    } else {
      vk[vkKey] = Buffer.from(val.bytes() ?? []).toString("hex");
    }
  }
  return vk as CircuitVKResult["vk"];
}

/** Parse the richer `get_vk_record` return map. */
function parseVkRecordScVal(
  scVal: StellarSdk.xdr.ScVal,
  circuitId: string,
  circuitType: "Vote" | "Comment",
): VkRecord {
  const parsed: Record<string, unknown> = {};
  for (const entry of scVal.map() ?? []) {
    const key = entry.key().sym()?.toString() ?? "";
    const val = entry.val();
    try {
      if (key === "vk") parsed.vk = parseVkScVal(val);
      else if (key === "num_public_signals") {
        parsed.numPublicSignals = Number(val.u32() ?? val.i32() ?? 0);
      } else if (key === "version") {
        parsed.version = Number(val.u32() ?? val.i32() ?? 1) || 1;
      } else if (
        key === "ceremony_transcript_hash" ||
        key === "ceremony_hash"
      ) {
        parsed.ceremonyTranscriptHash =
          val.str()?.toString() ?? Buffer.from(val.bytes() ?? []).toString("hex") ?? "";
      } else if (key === "registered_at") {
        parsed.registeredAt = Number(val.u64()?.toString() ?? val.i64()?.toString() ?? 0);
      } else if (key === "circuit_id") {
        parsed.circuitId = val.str()?.toString() ?? "";
      }
    } catch {
      // Ignore fields we cannot decode; required fields are validated below.
    }
  }
  if (!parsed.vk || typeof parsed.numPublicSignals !== "number") {
    throw new CircuitRegistryUnavailableError(
      `Malformed VK record for ${circuitId}/${circuitType}`,
    );
  }
  return {
    vk: parsed.vk as CircuitVKResult["vk"],
    numPublicSignals: parsed.numPublicSignals,
    version: (parsed.version as number) ?? 1,
    registeredAt: (parsed.registeredAt as number) ?? 0,
    circuitId: (parsed.circuitId as string) || circuitId,
    circuitType,
    ceremonyTranscriptHash: (parsed.ceremonyTranscriptHash as string) || undefined,
  };
}

/** Deterministic, clearly-labelled mock record — test mode ONLY. */
function testModeVkRecord(circuitId: string, circuitType: "Vote" | "Comment"): VkRecord {
  const version = TEST_MODE_VERSIONS[circuitId] ?? 1;
  const seed = `${circuitId}:${circuitType}:${version}`;
  return {
    vk: {
      alpha: `mock-alpha-${Buffer.from(seed).toString("hex")}`,
      beta: `mock-beta-${Buffer.from(seed).toString("hex")}`,
      gamma: `mock-gamma-${Buffer.from(seed).toString("hex")}`,
      delta: `mock-delta-${Buffer.from(seed).toString("hex")}`,
      ic: [`mock-ic-0-${Buffer.from(seed).toString("hex")}`],
    },
    numPublicSignals: circuitId.includes("weighted") ? 3 : circuitId.includes("v2") || circuitId.includes("comment") ? 6 : 5,
    version,
    registeredAt: 0,
    circuitId,
    circuitType,
    ceremonyTranscriptHash: undefined,
  };
}

/**
 * Read the full on-chain VK record. Production fails closed if the registry is
 * not configured or the call fails; test mode returns a labelled mock record.
 */
export async function getVkRecord(
  circuitId: string,
  circuitType: "Vote" | "Comment",
): Promise<VkRecord> {
  const { testMode, logger } = getDeps();
  if (testMode) {
    // Deterministic, clearly-labelled provider: no RPC and no on-chain reads.
    logger.warn("circuit_registry_mock_vk", {
      circuitId,
      circuitType,
      source: "test-mode-mock",
    });
    return testModeVkRecord(circuitId, circuitType);
  }

  const args = [
    StellarSdk.nativeToScVal(circuitId, { type: "string" }),
    StellarSdk.nativeToScVal(circuitType, { type: "symbol" }),
  ];

  const response = await simulateContractCall("get_vk_record", args);
  if (response?.result?.retval) {
    return parseVkRecordScVal(response.result.retval, circuitId, circuitType);
  }

  throw new CircuitRegistryUnavailableError(
    `Circuit registry unavailable: cannot read VK record for ${circuitId}/${circuitType}`,
  );
}

/**
 * Backwards-compatible thin wrapper around the canonical record read.
 * Fail-closed: errors from the registry propagate instead of being swallowed
 * into a synthetic or empty result.
 */
export async function getVK(
  circuitId: string,
  circuitType: "Vote" | "Comment",
): Promise<CircuitVKResult | null> {
  const record = await getVkRecord(circuitId, circuitType);
  return { vk: record.vk, numPublicSignals: record.numPublicSignals };
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

  // Rotation just happened on-chain: drop every cached VK/version for the
  // affected DAO + circuit. The full clear is a safety net so no stale entry
  // can survive a proposal whose metadata could not be read back.
  try {
    const proposal = await getVkProposal(proposalId);
    if (proposal) {
      invalidateVkCache({
        daoId: proposal.daoId,
        circuitId: proposal.circuitId,
        circuitType: proposal.circuitType,
      });
      invalidateVersionCache(proposal.circuitId);
    }
  } catch {
    /* best effort: the unconditional clear below still applies */
  }
  invalidateVkCache();
  invalidateVersionCache();
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
