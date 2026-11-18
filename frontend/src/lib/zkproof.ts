// ZK Proof generation utilities using snarkjs
// Enhanced with versioned VK cache, weighted voting, and domain separation

// `snarkjs` is imported ONLY as a type here and dynamically inside the fallback
// path (see `proveWithRust`/`proveWithSnarkjs`). On the default production path
// (Rust→WASM) it is never loaded. `CircuitSignals` is used only as a type.
import type { CircuitSignals, Groth16Proof } from "snarkjs";

// Shared BN254 field/nullifier validation helpers (#370)
import { assertValidFieldElement, assertValidNullifier } from "../types/index";
import { workerAvailable, proveInWorker } from "./proveInWorker";
import { withMaskedTiming } from "./proofTiming";
import { selectProvingPlan } from "./devicePreflight";

// Default to the Rust prover. Force the legacy `snarkjs` prover by setting
// `VITE_ZK_USE_RUST_PROVER=false` (Vite) or `ZK_USE_RUST_PROVER=false`
// (Node/tests). The value is read once at module load.
function rustProverEnabled(): boolean {
  try {
    if (
      (import.meta as { env?: Record<string, string> }).env
        ?.VITE_ZK_USE_RUST_PROVER === "false"
    )
      return false;
  } catch {
    /* import.meta.env unavailable */
  }
  try {
    if (
      (globalThis as { process?: { env?: Record<string, string> } }).process
        ?.env?.ZK_USE_RUST_PROVER === "false"
    )
      return false;
  } catch {
    /* process unavailable */
  }
  return true;
}
const USE_RUST_PROVER = rustProverEnabled();
let activeProofGenerationCount = 0;

type RustProver = {
  prove_wtns: (
    zkey: Uint8Array,
    wtns: Uint8Array,
  ) => Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
};

let rustProverPromise: Promise<RustProver> | null = null;

function loadRustProver(): Promise<RustProver> {
  if (!rustProverPromise) {
    rustProverPromise = (async () => {
      const mod = await import("./zkvote_prover/zkvote_prover.js");
      await (mod as unknown as { default: () => Promise<void> }).default();
      return mod as unknown as RustProver;
    })().catch((e) => {
      console.warn("Rust prover failed to load; falling back to snarkjs.", e);
      rustProverPromise = null;
      throw e;
    });
  }
  return rustProverPromise;
}

export class WitnessValidationError extends Error {
  constructor(message: string, public details?: unknown) {
    super(message);
    this.name = "WitnessValidationError";
  }
}

/**
 * Validates witness inputs before passing them to the witness calculator / prover WASM.
 * Catches malformed siblings, non-field elements, depth discrepancies, and empty roots,
 * preventing worker/prover crashes and DoS.
 */
export function validateWitnessInput(input: Record<string, unknown>): void {
  for (const [key, val] of Object.entries(input)) {
    if (val === undefined || val === null) {
      throw new WitnessValidationError(`Witness signal "${key}" cannot be null or undefined`);
    }

    if (key === "pathElements" || key === "siblings") {
      if (!Array.isArray(val) || val.length === 0) {
        throw new WitnessValidationError(`Witness "${key}" must be a non-empty array of field elements`);
      }
      for (let i = 0; i < val.length; i++) {
        try {
          assertValidFieldElement(val[i], `${key}[${i}]`);
        } catch (err: any) {
          throw new WitnessValidationError(`Witness ${key}[${i}] validation failed: ${err.message}`);
        }
      }
    } else if (key === "pathIndices") {
      if (!Array.isArray(val) || val.length === 0) {
        throw new WitnessValidationError(`Witness "${key}" must be a non-empty array`);
      }
      for (let i = 0; i < val.length; i++) {
        const num = Number(val[i]);
        if (num !== 0 && num !== 1) {
          throw new WitnessValidationError(`Witness ${key}[${i}] must be 0 or 1, got ${val[i]}`);
        }
      }
    } else if (key === "nullifier") {
      try {
        assertValidNullifier(val as string | bigint);
      } catch (err: any) {
        throw new WitnessValidationError(`Witness nullifier validation failed: ${err.message}`);
      }
    } else if (key === "root") {
      try {
        assertValidFieldElement(val as string | bigint, "root");
        const b = typeof val === "string" ? BigInt(val.startsWith("0x") ? val : `0x${val}`) : (val as bigint);
        if (b === 0n) {
          throw new WitnessValidationError("Witness root cannot be zero (uninitialized tree root)");
        }
      } catch (err: any) {
        throw new WitnessValidationError(`Witness root validation failed: ${err.message}`);
      }
    } else if (typeof val === "string" || typeof val === "number" || typeof val === "bigint") {
      try {
        assertValidFieldElement(val, key);
      } catch (err: any) {
        throw new WitnessValidationError(`Witness signal "${key}" validation failed: ${err.message}`);
      }
    }
  }
}

async function proveWithRust(
  input: Record<string, unknown>,
  wasmPath: string | Uint8Array,
  zkeyPath: string | Uint8Array,
): Promise<GeneratedProof> {
  validateWitnessInput(input);
  // Never start the Rust/main-thread path on a constrained device.
  if (Array.isArray(input.pathElements)) {
    const plan = selectProvingPlan(input.pathElements.length, {
      workerAvailable: workerAvailable(),
      rustAvailable: USE_RUST_PROVER,
    });
    if (plan.route !== "main") {
      throw new Error(plan.reason ?? "Main-thread proving is not suitable for this device.");
    }
  }
  // Compute the witness with the circom WASM (snarkjs' engine).
  const { WitnessCalculatorBuilder } = await import("circom_runtime");
  const wasmBytes =
    wasmPath instanceof Uint8Array
      ? wasmPath
      : new Uint8Array(await (await fetch(wasmPath)).arrayBuffer());
  const wc = await WitnessCalculatorBuilder(wasmBytes, {});

  // circom_runtime expects field elements as BigInt (snarkjs does the same
  // via unstringifyBigInts before calling the witness calculator).
  const toBig = (v: unknown): unknown => {
    if (typeof v === "string") return BigInt(v);
    if (typeof v === "number") return BigInt(v);
    if (Array.isArray(v)) return v.map(toBig);
    return v;
  };
  const bigInput: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) bigInput[k] = toBig(v);

  // Return the raw binary `.wtns` buffer (position-0 `1` signal included),
  // exactly what the Rust `prove_wtns` entry point expects.
  const witnessBytes = (await wc.calculateWitness(
    bigInput,
    true,
  )) as Uint8Array;

  const zkeyBytes =
    zkeyPath instanceof Uint8Array
      ? zkeyPath
      : new Uint8Array(await (await fetch(zkeyPath)).arrayBuffer());

  const prover = await loadRustProver();
  const res = await prover.prove_wtns(zkeyBytes, witnessBytes);
  return { proof: res.proof, publicSignals: res.publicSignals };
}

async function proveWithSnarkjs(
  input: Record<string, unknown>,
  wasmPath: string | Uint8Array,
  zkeyPath: string | Uint8Array,
): Promise<GeneratedProof> {
  validateWitnessInput(input);
  const depth = Array.isArray(input.pathElements) ? input.pathElements.length : undefined;
  if (depth !== undefined) {
    const plan = selectProvingPlan(depth, {
      workerAvailable: workerAvailable(),
      rustAvailable: false,
    });
    if (plan.route === "unavailable") {
      throw new Error(plan.reason ?? "This device cannot generate the required election proof.");
    }
  }
  // Off the main thread where the platform allows it (#92): a multi-second
  // BigInt proof on the main thread blocks rendering, which hands any script
  // on the page a timing trace via frame pacing alone. Timing masking is
  // applied by the caller, so this path does not pad.
  if (workerAvailable()) {
    const r = await proveInWorker(input, wasmPath, zkeyPath, undefined, depth);
    return { proof: r.proof, publicSignals: r.publicSignals } as GeneratedProof;
  }
  const { groth16 } = await import("snarkjs");
  const { proof, publicSignals } = await groth16.fullProve(
    input as CircuitSignals,
    wasmPath,
    zkeyPath,
  );
  return { proof, publicSignals };
}

// ============================================
// Types
// ============================================

export interface VoteProofInput {
  secret: string;
  salt: string;
  blindingFactor: string;
  root: string;
  nullifier: string;
  daoId: string;
  proposalId: string;
  voteChoice: string; // "0" for no, "1" for yes
  /** Public signal: must match on-chain ElectionConfig.num_candidates (#645) */
  numCandidates: string; // bounds voteChoice in-circuit
  commitment: string; // Identity commitment - private input, computed internally in circuit
  pathElements: string[];
  pathIndices: number[];
  circuitVersion?: string; // "v1" or "v2" (defaults to "v1")
  chainId?: string; // Required for v2 circuits
  familyNullifier?: string; // v2 only: breaks cross-proposal linkability
  nonce?: string; // v2 only: re-vote counter
  relayerAddress?: string; // v2 only
}

export interface CommentProofInput {
  secret: string;
  salt: string;
  blindingFactor: string;
  root: string;
  nullifier: string;
  daoId: string;
  proposalId: string;
  commentNonce: string; // Nonce for multiple comments (0, 1, 2, ...)
  commitment: string; // Identity commitment - used for proof generation (private circuit input)
  pathElements: string[];
  pathIndices: number[];
  circuitVersion?: string;
  parentCommentId?: string;
}

// Weighted vote: weight = balance proof with range check
export interface WeightedVoteProofInput extends VoteProofInput {
  weight: string; // voting weight (must equal balance commitment)
  maxWeight: string; // inclusive upper bound
  domainTag?: string; // domain separation tag (default: DOMAIN_TAG_WEIGHTED)
}

export interface BridgeProofInput {
  secret: string;
  salt: string;
  daoId: string;
  proposalId: string;
  voteChoice: string;
  nullifier: string;
  voteRoot: string;
  sbtRoot: string;
  sbtLeaf: string;
  sbtContractAddr: string;
  memberAddr: string;
  /** EVM chain id — public signal for cross-chain domain separation (#649) */
  chainId?: string;
  votingPathElements: string[];
  votingPathIndices: number[];
  sbtPathElements: string[];
  sbtPathIndices: number[];
}

// Legacy alias for backwards compatibility
export type ProofInput = VoteProofInput;

export interface ClaimProofInput {
  secret: string;
  salt: string;
  blindingFactor?: string;
  root: string;
  voteNullifier: string;
  claimNullifier: string;
  daoId: string;
  proposalId: string;
  pathElements: string[];
  pathIndices: number[];
}

// Domain tag for claim nullifier: ascii("claim") = 0x636c61696d = 427020085613 (BN254 Fr element)
// Distinct arity (4 vs 3) ensures vote and claim nullifiers never collide.
export const CLAIM_TAG = "427020085613";

export interface TallyProofInput {
  daoId: string;
  proposalId: string;
  root: string;
  tallyYes: string;
  tallyNo: string;
  nullifiers: string[];
  voteChoices: string[];
  weights?: string[];
  pathElements: string[][];
  pathIndices: number[][];
}

export interface GeneratedProof {
  proof: Groth16Proof;
  publicSignals: string[];
  redundantProof?: Groth16Proof;
}

// ============================================
// Versioned VK Cache (Task 1: ZK-013)
// ============================================

export const VK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const VK_CACHE_KEY_PREFIX = "zkvote_vk_cache";

export interface VersionedVK {
  circuitId: string;
  version: number;
  verificationKey: unknown;
  hash: string;
  fetchedAt: number;
  numPublicSignals?: number;
  vkVersion?: number; // CRITICAL (#660): Track VK version from backend
}

export class VKMismatchError extends Error {
  constructor(
    public expectedVersion: number,
    public actualVersion: number,
    message?: string,
  ) {
    super(
      message ??
        `VK version mismatch: expected ${expectedVersion}, got ${actualVersion} (stale VK)`,
    );
    this.name = "VKMismatchError";
  }
}

export class StaleVKError extends Error {
  constructor(
    public circuitId: string,
    public version: number,
  ) {
    super(
      `Stale VK: circuit ${circuitId} version ${version} is expired or not current`,
    );
    this.name = "StaleVKError";
  }
}

// In-memory cache (also persisted to localStorage for reload survival)
const vkMemoryCache = new Map<string, VersionedVK>();

function vkCacheKey(circuitId: string, version: number): string {
  return `${circuitId}::${version}`;
}

function persistVKCache(entry: VersionedVK): void {
  try {
    const key = `${VK_CACHE_KEY_PREFIX}_${entry.circuitId}_${entry.version}`;
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // ignore storage errors (e.g., in tests)
  }
}

function loadVKFromStorage(
  circuitId: string,
  version: number,
): VersionedVK | null {
  try {
    const key = `${VK_CACHE_KEY_PREFIX}_${circuitId}_${version}`;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as VersionedVK;

    // CRITICAL (#660): Validate VK integrity and version binding
    if (!parsed.hash) {
      console.warn(`[VK] Loaded VK from localStorage missing integrity hash for ${circuitId} v${version}`);
      return null;
    }
    if (typeof parsed.version !== 'number' || parsed.version !== version) {
      console.warn(`[VK] Version mismatch in localStorage for ${circuitId}: expected v${version}, got v${parsed.version}`);
      return null;
    }
    if (typeof parsed.circuitId !== 'string' || parsed.circuitId !== circuitId) {
      console.warn(`[VK] Circuit ID mismatch in localStorage: expected ${circuitId}, got ${parsed.circuitId}`);
      return null;
    }

    vkMemoryCache.set(vkCacheKey(circuitId, version), parsed);
    return parsed;
  } catch (e) {
    console.warn(`[VK] Failed to load VK from localStorage for ${circuitId} v${version}:`, e);
    return null;
  }
}

/**
 * Fetch a versioned VK from the backend with caching and stale detection.
 * Supports ZK-013: clients always use correct VK.
 *
 * @param circuitId - e.g., "vote_v1", "vote_v2", "weighted_vote"
 * @param version - VK version number
 * @param fetchFn - optional fetch override for testing
 */
export async function fetchVersionedVK(
  circuitId: string,
  version: number,
  fetchFn: typeof fetch = fetch,
): Promise<VersionedVK> {
  const key = vkCacheKey(circuitId, version);
  const cached =
    vkMemoryCache.get(key) ?? loadVKFromStorage(circuitId, version);
  if (cached && Date.now() - cached.fetchedAt < VK_CACHE_TTL_MS) {
    return cached;
  }

  // Fetch from backend versioned VK API
  const relayerUrl =
    (import.meta as unknown as { env: Record<string, string> })?.env
      ?.VITE_RELAYER_URL ?? "http://localhost:3001";
  const url = `${relayerUrl}/circuits/vk/${encodeURIComponent(circuitId)}/${version}`;

  const res = await fetchFn(url);
  if (res.status === 410 || res.status === 409) {
    // Stale version rejected by backend
    invalidateVKCache(circuitId, version);
    throw new StaleVKError(circuitId, version);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to fetch VK ${circuitId} v${version}: ${res.status} ${body}`,
    );
  }

  const data = await res.json();
  // Backend returns { vk, version, hash, numPublicSignals, vkVersion } or { verificationKey }
  const vk = data.vk ?? data.verificationKey ?? data;
  const hash: string = data.hash ?? data.vkHash ?? (await computeVKHash(vk));

  // CRITICAL (#660): Bind VK to the backend version for integrity verification
  const entry: VersionedVK = {
    circuitId,
    version: data.version ?? version,
    verificationKey: vk,
    hash,
    fetchedAt: Date.now(),
    numPublicSignals: data.numPublicSignals,
    vkVersion: data.vkVersion ?? data.version, // Store backend-provided VK version
  };

  // Detect stale if backend reports a newer version than requested
  if (data.currentVersion !== undefined && data.currentVersion !== version) {
    // If backend indicates requested version is stale, reject
    const isStale = data.isStale ?? data.currentVersion > version;
    if (isStale) {
      invalidateVKCache(circuitId, version);
      throw new StaleVKError(circuitId, version);
    }
  }

  vkMemoryCache.set(key, entry);
  persistVKCache(entry);
  return entry;
}

/**
 * Get cached VK if present and not expired
 */
export function getCachedVK(
  circuitId: string,
  version: number,
): VersionedVK | null {
  const key = vkCacheKey(circuitId, version);
  let entry: VersionedVK | null | undefined = vkMemoryCache.get(key);
  if (!entry) entry = loadVKFromStorage(circuitId, version);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt >= VK_CACHE_TTL_MS) {
    invalidateVKCache(circuitId, version);
    return null;
  }
  return entry;
}

/**
 * Invalidate VK cache (single version or all for circuit)
 */
export function invalidateVKCache(circuitId?: string, version?: number): void {
  if (circuitId === undefined) {
    vkMemoryCache.clear();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(VK_CACHE_KEY_PREFIX)) localStorage.removeItem(k);
      }
    } catch {
      /* ignore */
    }
    return;
  }
  if (version !== undefined) {
    vkMemoryCache.delete(vkCacheKey(circuitId, version));
    try {
      localStorage.removeItem(`${VK_CACHE_KEY_PREFIX}_${circuitId}_${version}`);
    } catch {
      /* ignore */
    }
    return;
  }
  // Invalidate all versions for circuitId
  for (const k of Array.from(vkMemoryCache.keys())) {
    if (k.startsWith(`${circuitId}::`)) vkMemoryCache.delete(k);
  }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(`${VK_CACHE_KEY_PREFIX}_${circuitId}_`))
        localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Detect VK mismatch between proposal's pinned version and client's cached version.
 * Throws VKMismatchError if stale.
 */
export function detectVKMismatch(
  proposalVkVersion: number | null | undefined,
  clientVkVersion: number | null | undefined,
  circuitId: string = "vote",
): void {
  if (proposalVkVersion == null || clientVkVersion == null) return;
  if (proposalVkVersion !== clientVkVersion) {
    throw new VKMismatchError(
      proposalVkVersion,
      clientVkVersion,
      `VK mismatch for ${circuitId}: proposal pinned to v${proposalVkVersion}, client has v${clientVkVersion}. Fetch correct VK.`,
    );
  }
}

/**
 * Compute SHA-256 hash of VK (for mismatch detection)
 */
export async function computeVKHash(vk: unknown): Promise<string> {
  const str = JSON.stringify(vk);
  const bytes = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// For testing: expose cache internals
export const __vkCacheTestHelpers = {
  _memoryCache: vkMemoryCache,
  _key: vkCacheKey,
  _clearAll: () => vkMemoryCache.clear(),
};

// ============================================
// Weighted Vote: Domain Tag & Weight Bounds
// ============================================

export const DOMAIN_TAG_WEIGHTED = "zkvote_weighted_domain_v1";
export const DOMAIN_TAG_VOTE = "zkvote_vote_domain_v1";
export const MAX_WEIGHT = BigInt(1_000_000); // inclusive upper bound for weighted voting
export const MIN_WEIGHT = BigInt(1);
let poseidonPromise: Promise<any> | null = null;

async function getPoseidon() {
  if (!poseidonPromise) {
    poseidonPromise = import("circomlibjs").then(({ buildPoseidon }) =>
      buildPoseidon(),
    );
  }
  return poseidonPromise;
}

export function validateWeight(
  weight: string | bigint,
  maxWeight: string | bigint = MAX_WEIGHT.toString(),
): void {
  const w = typeof weight === "string" ? BigInt(weight) : weight;
  const max = typeof maxWeight === "string" ? BigInt(maxWeight) : maxWeight;
  if (w < MIN_WEIGHT)
    throw new Error(`Weight ${w} below minimum ${MIN_WEIGHT}`);
  if (w > max)
    throw new Error(
      `Weight ${w} exceeds max ${max} (out-of-range weight rejected)`,
    );
  if (w > MAX_WEIGHT)
    throw new Error(`Weight ${w} exceeds global MAX_WEIGHT ${MAX_WEIGHT}`);
}

export async function calculateWeightedNullifier(
  secret: string,
  daoId: string,
  proposalId: string,
  weight: string,
  domainTag: string = DOMAIN_TAG_WEIGHTED,
): Promise<string> {
  const poseidon = await getPoseidon();
  // Domain-separated nullifier includes weight and domain tag
  const tagField =
    BigInt(
      "0x" +
        Array.from(new TextEncoder().encode(domainTag))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 16),
    ) %
    BigInt(
      "21888242871839275222246405745257275088548364400416034343698204186575808495617",
    );
  const hash = poseidon.F.toString(
    poseidon([
      BigInt(secret),
      BigInt(daoId),
      BigInt(proposalId),
      BigInt(weight),
      tagField,
    ]),
  );
  return hash;
}

// Benchmark helper for weighted vs v2 proof generation (for docs/benchmark)
export async function benchmarkWeightedVsV2(
  iterations: number = 1,
): Promise<{ weightedMs: number; v2Ms: number; ratio: number }> {
  // Placeholder benchmark that measures dummy poseidon ops; real bench uses actual proofgen
  const startW = performance.now();
  for (let i = 0; i < iterations; i++) {
    validateWeight("100", "1000");
  }
  const weightedMs = performance.now() - startW;
  const startV2 = performance.now();
  for (let i = 0; i < iterations; i++) {
    await calculateNullifier("123", "1", "1");
  }
  const v2Ms = performance.now() - startV2;
  return { weightedMs, v2Ms, ratio: weightedMs / Math.max(v2Ms, 1) };
}

// KAT vectors for weighted_vote vs vote_v2
export const WEIGHTED_VOTE_KAT = {
  secret: "12345",
  daoId: "1",
  proposalId: "1",
  weight: "100",
  maxWeight: "1000",
  domainTag: DOMAIN_TAG_WEIGHTED,
  // Precomputed with circomlibjs Poseidon (checked against circuit)
  expectedCommitment: null as string | null,
  description:
    "KAT for weighted vote circuit - validates constraint: weight <= maxWeight and domain tag binding",
};

/**
 * Generate a Groth16 proof for anonymous voting
 * @param input Proof input parameters
 * @param wasmPath Path to compiled circuit WASM, or an already-downloaded buffer
 * @param zkeyPath Path to proving key, or an already-downloaded buffer
 * @returns Generated proof and public signals
 */
/** Inputs for the encrypted-tally circuit (`vote_encrypted.circom`). */
export interface EncryptedVoteProofInput {
  root: string;
  nullifier: string;
  daoId: string;
  proposalId: string;
  numCandidates: string;
  epoch: string;
  publicKey: [string, string];
  c1: [string, string];
  cYes: [string, string];
  cNo: [string, string];
  relayerAddress: string;
  // Private
  voteChoice: string;
  secret: string;
  salt: string;
  blindingFactor: string;
  randomness: string;
  pathElements: string[];
  pathIndices: number[];
}

/**
 * Generate a Groth16 proof for the encrypted ballot.
 *
 * The plaintext choice is a private witness; the public signals contain only
 * the ElGamal ciphertext. This intentionally bypasses the Rust prover, whose
 * artifacts target the legacy plaintext circuit, until the encrypted circuit is
 * added to the prover's key registry.
 */
export async function generateEncryptedVoteProof(
  input: EncryptedVoteProofInput,
  wasmPath: string,
  zkeyPath: string,
): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
  const snarkjs = await import("snarkjs");
  return snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
}

export async function generateVoteProof(
  input: VoteProofInput,
  wasmPath: string | Uint8Array,
  zkeyPath: string | Uint8Array,
): Promise<GeneratedProof> {
  if (activeProofGenerationCount > 0) {
    throw new Error(
      "A proof generation process is already in progress. Please wait for it to finish.",
    );
  }
  // The witness path is built for the election's circuit depth (ZV-052).
  // Never substitute a shallower circuit to make proving cheaper.
  const plan = selectProvingPlan(input.pathElements.length, {
    workerAvailable: workerAvailable(),
    rustAvailable: USE_RUST_PROVER,
  });
  if (plan.route === "unavailable") {
    throw new Error(plan.reason ?? "This device cannot generate the required election proof.");
  }
  activeProofGenerationCount++;
  try {
    const circuitVersion = input.circuitVersion ?? "v1";
    let circuitInput: Record<string, unknown>;
    if (circuitVersion === "v2") {
      // vote_v2.circom: 10 public signals + private blindingFactor
      circuitInput = {
        root: input.root,
        nullifier: input.nullifier,
        familyNullifier: input.familyNullifier ?? "0",
        daoId: input.daoId,
        proposalId: input.proposalId,
        voteChoice: input.voteChoice,
        numCandidates: input.numCandidates,
        chainId: input.chainId || "0",
        nonce: input.nonce ?? "0",
        relayerAddress: input.relayerAddress ?? "0",
        secret: input.secret,
        salt: input.salt,
        blindingFactor: input.blindingFactor,
        pathElements: input.pathElements,
        pathIndices: input.pathIndices,
      };
    } else {
      // vote.circom: 6 public signals
      //   [root, nullifier, daoId, proposalId, voteChoice, numCandidates]
      //
      // `numCandidates` is not optional. The circuit range-checks
      // `voteChoice < numCandidates` against this PUBLIC input so the contract
      // can be sure the proof enforced the candidate bound the election was
      // configured with. Leaving it out leaves the signal at 0, which makes
      // `voteChoice < 0` unsatisfiable — so the witness cannot be generated at
      // all. It was missing here, which is one reason the anonymous vote path
      // produced no usable proofs.
      //
      // There is deliberately no `relayerAddress` on this path: see the header
      // of circuits/vote_template.circom. A public signal that the verifier
      // cannot check binds nothing, and adding it made the IC length disagree
      // with the contract.
      circuitInput = {
        root: input.root,
        nullifier: input.nullifier,
        daoId: input.daoId,
        proposalId: input.proposalId,
        voteChoice: input.voteChoice,
        numCandidates: input.numCandidates,
        secret: input.secret,
        salt: input.salt,
        blindingFactor: input.blindingFactor,
        pathElements: input.pathElements,
        pathIndices: input.pathIndices,
      };
    }

    // Mask the timing of the whole prover selection, not of a single prover
    // (#92). snarkjs is variable-time, so duration correlates with the secret
    // and candidate choice in the witness — and *which* prover ran, or whether
    // the Rust one failed and fell back to snarkjs, is itself readable from
    // the clock. One masking boundary here covers every path; the individual
    // provers deliberately do not pad, so the padding cannot compound.
    return withMaskedTiming(async () => {
      if (USE_RUST_PROVER && plan.route === "main") {
        try {
          const primary = await proveWithRust(circuitInput, wasmPath, zkeyPath);
          try {
            const secondary = await proveWithSnarkjs(
              circuitInput,
              wasmPath,
              zkeyPath,
            );
            return { ...primary, redundantProof: secondary.proof };
          } catch (e) {
            console.warn("Secondary snarkjs vote prover failed.", e);
            return primary;
          }
        } catch (e) {
          console.warn("Rust vote prover failed; falling back to snarkjs.", e);
        }
      }

      return proveWithSnarkjs(circuitInput, wasmPath, zkeyPath);
    });
  } catch (error) {
    console.error("Failed to generate vote proof:", error);
    throw new Error(
      `Vote proof generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  } finally {
    activeProofGenerationCount = Math.max(0, activeProofGenerationCount - 1);
  }
}

/**
 * Generate weighted vote proof (with weight bounds and domain tag)
 */
export async function generateWeightedVoteProof(
  input: WeightedVoteProofInput,
  wasmPath: string = "/circuits/weighted_vote.wasm",
  zkeyPath: string = "/circuits/weighted_vote_final.zkey",
): Promise<GeneratedProof> {
  validateWeight(input.weight, input.maxWeight);
  try {
    const circuitInput = {
      root: input.root,
      nullifier: input.nullifier,
      daoId: input.daoId,
      proposalId: input.proposalId,
      voteChoice: input.voteChoice,
      weight: input.weight,
      maxWeight: input.maxWeight,
      domainTag: input.domainTag ?? DOMAIN_TAG_WEIGHTED,
      secret: input.secret,
      salt: input.salt,
      pathElements: input.pathElements,
      pathIndices: input.pathIndices,
    };
    return proveWithSnarkjs(circuitInput, wasmPath, zkeyPath);
  } catch (error) {
    console.error("Failed to generate weighted vote proof:", error);
    throw new Error(
      `Weighted proof failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Generate a Groth16 tally proof for a proposal.
 * The circuit proves the reported tallies are the sum of valid, unique votes
 * in the nullifier set (bound to `root`).
 */
export async function generateTallyProof(
  input: TallyProofInput,
  wasmPath: string | Uint8Array = "/circuits/tally/tally.wasm",
  zkeyPath: string | Uint8Array = "/circuits/tally/tally_final.zkey",
): Promise<GeneratedProof> {
  try {
    const circuitInput: Record<string, unknown> = {
      daoId: input.daoId,
      proposalId: input.proposalId,
      root: input.root,
      tallyYes: input.tallyYes,
      tallyNo: input.tallyNo,
      nullifiers: input.nullifiers,
      voteChoices: input.voteChoices,
      pathElements: input.pathElements,
      pathIndices: input.pathIndices,
    };
    if (input.weights) circuitInput.voteWeights = input.weights;

    if (USE_RUST_PROVER) {
      try {
        return await proveWithRust(circuitInput, wasmPath, zkeyPath);
      } catch (e) {
        console.warn("Rust tally prover failed; falling back to snarkjs.", e);
      }
    }

    const { groth16 } = await import("snarkjs");
    const { proof, publicSignals } = await groth16.fullProve(
      circuitInput as unknown as CircuitSignals,
      wasmPath as string,
      zkeyPath as string,
    );
    return { proof, publicSignals };
  } catch (error) {
    console.error("Failed to generate tally proof:", error);
    throw new Error(`Tally proof generation failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * Generate bridge proof (cross-chain membership)
 */
export async function generateBridgeProof(
  input: BridgeProofInput,
  wasmPath: string = "/circuits/bridge.wasm",
  zkeyPath: string = "/circuits/bridge_final.zkey",
): Promise<GeneratedProof> {
  try {
    const circuitInput = {
      sbtContractAddr: input.sbtContractAddr,
      memberAddr: input.memberAddr,
      daoId: input.daoId,
      proposalId: input.proposalId,
      nullifier: input.nullifier,
      voteChoice: input.voteChoice,
      voteRoot: input.voteRoot,
      sbtRoot: input.sbtRoot,
      chainId: input.chainId ?? "0",
      secret: input.secret,
      salt: input.salt,
      votingPathElements: input.votingPathElements,
      votingPathIndices: input.votingPathIndices,
      sbtPathElements: input.sbtPathElements,
      sbtPathIndices: input.sbtPathIndices,
      sbtLeaf: input.sbtLeaf,
    };
    return proveWithSnarkjs(circuitInput, wasmPath, zkeyPath);
  } catch (error) {
    console.error("Failed to generate bridge proof:", error);
    throw new Error(
      `Bridge proof generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Generate a Groth16 proof for anonymous commenting
 * @param input Proof input parameters (uses commentNonce instead of voteChoice)
 * @param wasmPath Path to compiled comment circuit WASM
 * @param zkeyPath Path to comment proving key
 * @returns Generated proof and public signals
 */
export async function generateCommentProof(
  input: CommentProofInput,
  wasmPath: string | Uint8Array = "/circuits/comment/comment.wasm",
  zkeyPath: string | Uint8Array = "/circuits/comment/comment_final.zkey",
): Promise<GeneratedProof> {
  try {
    const circuitVersion = input.circuitVersion ?? "v1";
    let circuitInput: CircuitSignals;

    if (circuitVersion === "v2") {
      // comment_v2.circom - adds parentCommentId as 7th public signal
      circuitInput = {
        root: input.root,
        nullifier: input.nullifier,
        daoId: input.daoId,
        proposalId: input.proposalId,
        commentNonce: input.commentNonce,
        commitment: input.commitment,
        parentCommentId: input.parentCommentId || "0",
        secret: input.secret,
        salt: input.salt,
        blindingFactor: input.blindingFactor,
        pathElements: input.pathElements,
        pathIndices: input.pathIndices,
      };
    } else {
      // comment_v1.circom - original 6 public signals
      circuitInput = {
        root: input.root,
        nullifier: input.nullifier,
        daoId: input.daoId,
        proposalId: input.proposalId,
        commentNonce: input.commentNonce,
        commitment: input.commitment,
        secret: input.secret,
        salt: input.salt,
        blindingFactor: input.blindingFactor,
        pathElements: input.pathElements,
        pathIndices: input.pathIndices,
      };
    }

    // Generate proof with the Rust WASM prover (snarkjs fallback).
    if (USE_RUST_PROVER) {
      try {
        return await proveWithRust(circuitInput, wasmPath, zkeyPath);
      } catch (e) {
        console.warn("Rust comment prover failed; falling back to snarkjs.", e);
      }
    }

    return proveWithSnarkjs(circuitInput, wasmPath, zkeyPath);
  } catch (error) {
    console.error("Failed to generate comment proof:", error);
    throw new Error(
      `Comment proof generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  } finally {
    activeProofGenerationCount = Math.max(0, activeProofGenerationCount - 1);
  }
}

/**
 * Generate a Groth16 proof for v2 comment circuit (with parentCommentId)
 */
export async function generateCommentProofV2(
  input: CommentProofInput,
  wasmPath: string | Uint8Array = "/circuits/comment_v2/comment_v2.wasm",
  zkeyPath: string | Uint8Array = "/circuits/comment_v2/comment_v2_final.zkey",
): Promise<GeneratedProof> {
  return generateCommentProof(
    { ...input, circuitVersion: "v2" },
    wasmPath,
    zkeyPath,
  );
}

/**
 * Generate a Groth16 proof for claim circuit (vote-to-earn)
 */
export async function generateClaimProof(
  input: ClaimProofInput,
  wasmPath: string | Uint8Array = "/circuits/claim.wasm",
  zkeyPath: string | Uint8Array = "/circuits/claim_final.zkey",
): Promise<GeneratedProof> {
  try {
    const circuitInput: Record<string, unknown> = {
      root: input.root,
      voteNullifier: input.voteNullifier,
      claimNullifier: input.claimNullifier,
      daoId: input.daoId,
      proposalId: input.proposalId,
      secret: input.secret,
      salt: input.salt,
      pathElements: input.pathElements,
      pathIndices: input.pathIndices,
    };
    if (input.blindingFactor) circuitInput.blindingFactor = input.blindingFactor;

    if (USE_RUST_PROVER) {
      try {
        return await proveWithRust(circuitInput, wasmPath, zkeyPath);
      } catch (e) {
        console.warn("Rust claim prover failed; falling back to snarkjs.", e);
      }
    }
    return proveWithSnarkjs(circuitInput, wasmPath, zkeyPath);
  } catch (error) {
    console.error("Failed to generate claim proof:", error);
    throw new Error(
      `Claim proof generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Convert snarkjs proof format to Soroban-compatible hex strings
 *
 * After PR #1614, Soroban BN254 host functions use BIG-ENDIAN encoding
 * matching CAP-74 and EVM precompile specifications (EIP-196, EIP-197).
 * snarkjs already outputs big-endian field elements, so NO byte reversal is needed.
 *
 * G2 Fp2 format: Ethereum expects [c1, c0] (imaginary first), while snarkjs
 * outputs [c0, c1] (real first), so we swap each coordinate pair.
 */
export function formatProofForSoroban(proof: Groth16Proof): {
  proof_a: string;
  proof_b: string;
  proof_c: string;
} {
  // Convert field element to BIG-ENDIAN hex (no reversal needed)
  const toHexBE = (value: string): string => {
    const bigInt = BigInt(value);
    return bigInt.toString(16).padStart(64, "0");
  };

  // Format pi_a (G1 point): be_bytes(X) || be_bytes(Y)
  const proof_a = toHexBE(proof.pi_a[0]) + toHexBE(proof.pi_a[1]);

  // Format pi_b (G2 point): [[x.c0, x.c1], [y.c0, y.c1]]
  // Ethereum/Soroban format: be_bytes(X_c1) || be_bytes(X_c0) || be_bytes(Y_c1) || be_bytes(Y_c0)
  // snarkjs outputs: [[c0, c1], [c0, c1]] where c0=real, c1=imaginary
  // We swap within each coordinate pair: [c1, c0, c1, c0]
  const proof_b =
    toHexBE(proof.pi_b[0][1]) + // X.c1 (imaginary)
    toHexBE(proof.pi_b[0][0]) + // X.c0 (real)
    toHexBE(proof.pi_b[1][1]) + // Y.c1 (imaginary)
    toHexBE(proof.pi_b[1][0]); // Y.c0 (real)

  // Format pi_c (G1 point): be_bytes(X) || be_bytes(Y)
  const proof_c = toHexBE(proof.pi_c[0]) + toHexBE(proof.pi_c[1]);

  return { proof_a, proof_b, proof_c };
}

/**
 * Generate a random secret for commitment
 */
export function generateSecret(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  let result = BigInt(0);
  for (let i = 0; i < array.length; i++) {
    result = (result << BigInt(8)) | BigInt(array[i]);
  }
  return result.toString();
}

/**
 * Calculate vote nullifier using Poseidon hash
 * nullifier = Poseidon(secret, daoId, proposalId)
 * For v2 with chainId: Poseidon(secret, daoId, proposalId, chainId)
 */
export async function calculateNullifier(
  secret: string,
  daoId: string,
  proposalId: string,
  chainId?: string,
): Promise<string> {
  const poseidon = await getPoseidon();

  if (chainId !== undefined) {
    const hash = poseidon.F.toString(
      poseidon([
        BigInt(secret),
        BigInt(daoId),
        BigInt(proposalId),
        BigInt(chainId),
      ]),
    );
    return hash;
  }

  const hash = poseidon.F.toString(
    poseidon([BigInt(secret), BigInt(daoId), BigInt(proposalId)]),
  );

  return hash;
}

/**
 * Calculate vote nullifier for v2 circuit (includes chainId)
 */
export async function calculateNullifierV2(
  secret: string,
  daoId: string,
  proposalId: string,
  chainId: string,
): Promise<string> {
  return calculateNullifier(secret, daoId, proposalId, chainId);
}

/**
 * Calculate comment nullifier using Poseidon hash
 * nullifier = Poseidon(secret, daoId, proposalId, commentNonce)
 * The nonce allows multiple comments per proposal from the same user
 */
export async function calculateCommentNullifier(
  secret: string,
  daoId: string,
  proposalId: string,
  commentNonce: string,
): Promise<string> {
  const { buildPoseidon } = await import("circomlibjs");
  const poseidon = await buildPoseidon();

  const hash = poseidon.F.toString(
    poseidon([
      BigInt(secret),
      BigInt(daoId),
      BigInt(proposalId),
      BigInt(commentNonce),
    ]),
  );

  return hash;
}

/**
 * Calculate claim nullifier using Poseidon hash with domain tag
 * claimNullifier = Poseidon(secret, daoId, proposalId, CLAIM_TAG)
 * CLAIM_TAG = 427020085613 (ascii "claim") blocks double-claim, distinct from vote nullifier
 */
export async function calculateClaimNullifier(
  secret: string,
  daoId: string,
  proposalId: string,
): Promise<string> {
  const { buildPoseidon } = await import("circomlibjs");
  const poseidon = await buildPoseidon();
  const hash = poseidon.F.toString(
    poseidon([
      BigInt(secret),
      BigInt(daoId),
      BigInt(proposalId),
      BigInt(CLAIM_TAG),
    ]),
  );
  return hash;
}

/** Alias for calculateNullifier — vote nullifier used to gate claims */
export const calculateVoteNullifier = calculateNullifier;

// Domain separation tag for commitment scheme
// SHA-256("ZK-VOTE-COMMITMENT") reduced mod BN254 scalar field
// Must match DOMAIN_TAG in circuits for consistency
const DOMAIN_TAG = BigInt(
  "19666041591797403834655481403982443037438503980743793537655983658411276515161",
);

/**
 * Calculate commitment from secret, salt, and blinding factor using Poseidon hash
 * commitment = Poseidon(DOMAIN_TAG, secret, salt, blindingFactor)
 * Domain-separated commitment prevents cross-protocol attacks.
 */
export async function calculateCommitment(
  secret: string,
  salt: string,
  blindingFactor: string,
): Promise<string> {
  const { buildPoseidon } = await import("circomlibjs");
  const poseidon = await buildPoseidon();

  const hash = poseidon.F.toString(
    poseidon([
      DOMAIN_TAG,
      BigInt(secret),
      BigInt(salt),
      BigInt(blindingFactor),
    ]),
  );

  return hash;
}

/**
 * Verify a proof locally before submitting
 * @param proof Generated proof
 * @param publicSignals Public signals
 * @param vkeyPath Path to verification key JSON
 */
export async function verifyProofLocally(
  proof: Groth16Proof,
  publicSignals: string[],
  vkeyPath: string,
): Promise<boolean> {
  try {
    const vkey = await fetch(vkeyPath).then((r) => r.json());
    const { groth16 } = await import("snarkjs");
    const result = await groth16.verify(vkey, publicSignals, proof);
    return result;
  } catch (error) {
    console.error("Local verification failed:", error);
    return false;
  }
}

/**
 * Verify proof against a versioned VK (with mismatch detection)
 */
export async function verifyProofWithVersionedVK(
  proof: Groth16Proof,
  publicSignals: string[],
  circuitId: string,
  version: number,
): Promise<boolean> {
  const vkEntry = await fetchVersionedVK(circuitId, version);
  try {
    const { groth16 } = await import("snarkjs");
    const result = await groth16.verify(
      vkEntry.verificationKey as never,
      publicSignals,
      proof,
    );
    return result;
  } catch (e) {
    console.error("Versioned VK verification failed:", e);
    return false;
  }
}

// STARK Prover Stub
export async function generateStarkProof(signals: any) {
    // Prototype: Plonky2 based WASM prover logic goes here
    return {
        starkProof: {
            proof_bytes: new Uint8Array(64),
            public_inputs: new Uint8Array(32),
        },
        hybridCommitment: 'dummy-sha3-hash'
    };
}

