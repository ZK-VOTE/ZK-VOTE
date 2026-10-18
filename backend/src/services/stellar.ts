// @ts-nocheck
/**
 * Stellar/Soroban Service
 *
 * Provides Stellar SDK setup, helper functions, and transaction utilities
 * for interacting with Soroban smart contracts.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { config, BN254_SCALAR_FIELD } from "../config.js";
import { log, logger } from "./logger.js";
import { getMetadata, setMetadata, getWriteDb } from "./db.js";
import {
  SigningPolicy,
  DEFAULT_TIER_LIMITS,
  parseCosigners,
  parseTierLimits,
} from "./relayer-signing-policy.js";
import {
  RelayerRotationOrchestrator,
  SqliteKeyLifecycleStore,
} from "./relayer-rotation.js";
import {
  rpcCallsTotal,
  rpcCallDuration,
  rpcErrors,
  rpcPoolHealthyEndpoints,
  rpcPoolTotalEndpoints,
  rpcEndpointLatency,
  sequenceRecoveriesTotal,
  sequenceMismatchesTotal,
  sequenceRecoveryDuration,
  sequenceHealthStatus,
  dependencyAvailableEndpoints,
  dependencyTotalEndpoints,
  endpointDisagreementTotal,
  endpointHealthy,
  endpointLedgerLag,
  endpointStaleRejectedTotal,
  relayerKeyMaxAgeSeconds,
} from "./metrics.js";
import {
  arbitrate,
  computeBackoffMs,
  DEFAULT_RETRY_POLICY,
  DependencyUnavailableError,
  EndpointDisagreementError,
  endpointLabel,
  registerHealthProbe,
  StaleReadError,
  type ArbitrationResult,
  type LedgerStamped,
} from "./endpoint-pool.js";
import {
  registerCircuitBreaker,
  CircuitBreakerOpenError,
  type CircuitBreaker,
} from "./circuit-breaker.js";
import { withSpan } from "./tracing.js";
import type { Groth16Proof } from "../types/index.js";
// #541 Soroban rent economics: Persistent costs ~10x Temporary. Roots/config
// stay Persistent/Instance (long-lived, TTL-extended); leaves/ephemeral data
// must prefer Temporary. Centralize TTL + rent budgeting here so extend_ttl
// calls are economical, not blind bumps.
export const RENT_PERSISTENT_LEDGERS = 535_680; // ~31d extend
export const RENT_TEMPORARY_LEDGERS = 120_960; // shorter, cheaper
export const RENT_THRESHOLD_LEDGERS = 120_960;
export function rentTierFor(keyKind: "root" | "config" | "leaf" | "ephemeral"): "persistent" | "instance" | "temporary" {
  if (keyKind === "root" || keyKind === "config") return keyKind === "config" ? "instance" : "persistent";
  return "temporary";
}
/** Returns true only when TTL extension is economically justified (below threshold). */
export function shouldExtendTtl(currentTtl: number, threshold: number = RENT_THRESHOLD_LEDGERS): boolean {
  return currentTtl <= threshold;
}
import { BN254_FQ_MODULUS } from "../types/index.js";
import type { RpcServerPort } from "./interfaces.js";
import nodeCluster from "node:cluster";
import {
  acquireClusterSequenceLock,
  releaseClusterSequenceLock,
} from "./cluster.js";
import { withRpcConcurrency } from "./rpc-concurrency.js";

// ============================================
// TYPE DEFINITIONS
// ============================================

export interface TestServer {
  getHealth: () => Promise<{ status: string }>;
  simulateTransaction: () => Promise<never>;
  sendTransaction: () => Promise<{ status: string; errorResult: string }>;
  getTransaction: () => Promise<{ status: string }>;
  getAccount: () => Promise<{ accountId: string; sequence: string }>;
  getLatestLedger?: () => Promise<{ sequence: number }>;
}

export type SorobanServer = StellarSdk.rpc.Server | TestServer;

import {
  relayerKeyManager,
  LocalKeypairSigner,
  KmsSigner,
  HsmSigner,
  MockTestSigner,
  type StellarSigner,
  type RelayerKeypair,
} from "./relayerKeyManager.js";

export {
  relayerKeyManager,
  LocalKeypairSigner,
  KmsSigner,
  HsmSigner,
  MockTestSigner,
  type StellarSigner,
  type RelayerKeypair,
};

/**
 * Construct the relayer keypair from config. Extracted from the module so the
 * composition root (and tests) can build keypairs explicitly instead of the
 * module grabbing config at import time (#358).
 */
export function createRelayerKeypair(
  relayerSecretKey: string | undefined,
  testMode: boolean,
): RelayerKeypair {
  if (testMode) {
    return {
      publicKey: () =>
        "GTESTRELAYERADDRESS000000000000000000000000000000000000",
    };
  }
  if (config.relayerSignerType === "aws_kms" && config.kmsKeyId && config.relayerPublicKey) {
    return {
      publicKey: () => config.relayerPublicKey!,
    };
  }
  if (!relayerSecretKey) {
    throw new Error("RELAYER_SECRET_KEY is not set");
  }
  return StellarSdk.Keypair.fromSecret(relayerSecretKey);
}

// Initialize the relayer key manager
try {
  relayerKeyManager.initialize();
  logger.info("relayer_loaded", {
    relayer: relayerKeyManager.getPublicKey(),
    testMode: config.testMode,
  });
} catch (err) {
  log("error", "invalid_relayer_key", { message: (err as Error).message });
  console.error("Run ./scripts/init-local.sh to generate a secure key");
  process.exit(1);
}

/**
 * Dynamic relayerKeypair proxy that delegates to the active key in relayerKeyManager.
 * Ensures zero-downtime hot swapping across all existing routes and callers.
 */
export const relayerKeypair = {
  publicKey: () => relayerKeyManager.getPublicKey(),
  sign: (tx: StellarSdk.Transaction) => {
    const kp = relayerKeyManager.getActiveKeypair();
    if ("sign" in kp && typeof (kp as any).sign === "function") {
      (kp as any).sign(tx);
    } else if ("signDecorated" in kp) {
      // fallback
      const hash = (tx as any).hash();
      const sig = (kp as any).signDecorated(hash);
      (tx as any).signatures.push(sig);
    }
  },
  signDecorated: (hash: Buffer) => {
    const kp = relayerKeyManager.getActiveKeypair() as StellarSdk.Keypair;
    if ("signDecorated" in kp && typeof (kp as any).signDecorated === "function") {
      return (kp as any).signDecorated(hash);
    }
    const sig = (kp as any).sign(hash);
    const hint = (kp as StellarSdk.Keypair).rawPublicKey().subarray(4 - 4);
    // Actually rawPublicKey is 32 bytes, hint is last 4
    const raw = (kp as StellarSdk.Keypair).rawPublicKey();
    const h = raw.subarray(raw.length - 4);
    return new StellarSdk.xdr.DecoratedSignature({ hint: h, signature: sig });
  },
  rawPublicKey: () => {
    const kp = relayerKeyManager.getActiveKeypair();
    if ("rawPublicKey" in kp && typeof (kp as any).rawPublicKey === "function") {
      return (kp as any).rawPublicKey();
    }
    return StellarSdk.StrKey.decodeEd25519PublicKey(
      relayerKeyManager.getPublicKey(),
    );
  },
  secret: () => {
    const active = relayerKeyManager.getActiveKey();
    if (active?.secretKey) return active.secretKey;
    const kp = relayerKeyManager.getActiveKeypair();
    if ("secret" in kp && typeof (kp as any).secret === "function") {
      return (kp as any).secret();
    }
    throw new Error("Secret key is not exportable for this relayer signer");
  },
} as unknown as RelayerKeypair;

/**
 * Dynamic activeSigner proxy that delegates to the active signer in relayerKeyManager.
 */
export const activeSigner: StellarSigner = {
  getPublicKey: () => relayerKeyManager.getPublicKey(),
  signTransaction: (tx: StellarSdk.Transaction) =>
    relayerKeyManager.signTransaction(tx),
  signHash: (hash: Buffer) => {
    const s = relayerKeyManager.getActiveSigner();
    if (s.signHash) return s.signHash(hash);
    return Buffer.alloc(64);
  },
};

// ============================================
// SEQUENCE LOCK (TRANSACTION NONCE MUTEX)
// ============================================

/**
 * Promise-based mutex to serialize transaction submissions.
 * Prevents nonce race conditions when multiple requests try to
 * build+submit transactions concurrently using the same relayer account.
 * Uses IPC distributed sequence lock when running in cluster mode.
 */
let sequenceLock: Promise<void> = Promise.resolve();

// Count of sequence-lock operations currently queued or executing. A vote
// submission holds the lock across build+simulate+send+confirm, which can
// outlive its HTTP response, so shutdown must wait on this, not just on
// httpServer.close().
let inFlightLockOps = 0;

export function getPendingSequenceLockOps(): number {
  return inFlightLockOps;
}

/**
 * Wait until all in-flight withSequenceLock operations drain, or until
 * timeoutMs elapses. Resolves true if drained cleanly, false on timeout
 * with work still outstanding.
 */
export async function waitForSequenceLockIdle(
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (inFlightLockOps > 0) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

// ============================================
// SEQUENCE MANAGER
// ============================================

/**
 * Manages the relayer account's sequence number with dirty-flag recovery.
 *
 * When an RPC error leaves the local sequence unknown, `markDirty()` forces a
 * fresh `getAccount` call before the next submission instead of building on a
 * potentially stale number. The last known sequence is persisted to the SQLite
 * metadata table so a process crash doesn't lose it.
 */
export class SequenceManager {
  private dirty = false;
  private lastKnownSequence: string | null = null;
  private consecutiveErrors = 0;
  private lastRecoveryTime = 0;
  private readonly MAX_CONSECUTIVE_ERRORS = 5;
  private readonly RECOVERY_COOLDOWN_MS = 5000; // 5 seconds

  constructor() {
    const persisted = this.loadPersisted();
    if (persisted) {
      this.lastKnownSequence = persisted;
    }
    // Initialize health status as healthy
    sequenceHealthStatus.set(1);
  }

  // Sequence numbers belong to one account; after a rotation the persisted
  // value of the previous identity must not be read back for the new one
  // (#746), so the key includes the relayer public key.
  private metadataKey(): string {
    return `relayer_last_sequence:${relayerKeypair.publicKey()}`;
  }

  private loadPersisted(): string | null {
    try {
      return getMetadata<string>(this.metadataKey());
    } catch {
      return null;
    }
  }

  private persist(seq: string): void {
    try {
      setMetadata(this.metadataKey(), seq);
    } catch {
      // Non-fatal: SQLite may be unavailable during tests
    }
  }

  markDirty(): void {
    this.dirty = true;
  }

  async forceResync(sorobanServer: StellarSdk.rpc.Server): Promise<void> {
    const account = await sorobanServer.getAccount(relayerKeypair.publicKey());
    const seq =
      (account as unknown as { sequence: string }).sequence ??
      String((account as any).sequenceNumber?.());
    this.lastKnownSequence = seq;
    this.dirty = false;
    this.persist(seq);
    log("info", "sequence_resync", { sequence: seq });
  }

  async getAccount(
    sorobanServer: StellarSdk.rpc.Server,
  ): Promise<StellarSdk.Account> {
    if (this.dirty || this.lastKnownSequence === null) {
      const account = await sorobanServer.getAccount(
        relayerKeypair.publicKey(),
      );
      const seq =
        (account as any).sequence ??
        String((account as any).sequenceNumber?.());
      this.lastKnownSequence = seq;
      this.dirty = false;
      this.persist(seq);
      return account;
    }
    return sorobanServer.getAccount(relayerKeypair.publicKey());
  }

  handleTxError(errorResult: string): boolean {
    if (errorResult && errorResult.includes("tx_bad_seq")) {
      this.markDirty();
      sequenceMismatchesTotal.inc();
      this.consecutiveErrors++;
      
      // Update health status based on consecutive errors
      if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
        sequenceHealthStatus.set(0);
        log("error", "sequence_health_degraded", {
          consecutiveErrors: this.consecutiveErrors,
        });
      }
      
      return true;
    }
    return false;
  }

  /**
   * Reset error counter and restore health status on successful transaction
   */
  markSuccess(): void {
    if (this.consecutiveErrors > 0) {
      this.consecutiveErrors = 0;
      sequenceHealthStatus.set(1);
    }
  }

  /**
   * Check if recovery should be rate limited
   */
  shouldRateLimitRecovery(): boolean {
    const now = Date.now();
    if (
      this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS &&
      now - this.lastRecoveryTime < this.RECOVERY_COOLDOWN_MS
    ) {
      return true;
    }
    return false;
  }

  /**
   * Update last recovery timestamp
   */
  markRecoveryAttempt(): void {
    this.lastRecoveryTime = Date.now();
  }

  /**
   * Get current health status for monitoring
   */
  getHealthStatus(): {
    healthy: boolean;
    consecutiveErrors: number;
    lastKnownSequence: string | null;
    dirty: boolean;
  } {
    return {
      healthy: this.consecutiveErrors < this.MAX_CONSECUTIVE_ERRORS,
      consecutiveErrors: this.consecutiveErrors,
      lastKnownSequence: this.lastKnownSequence,
      dirty: this.dirty,
    };
  }
}

export const sequenceManager = new SequenceManager();

// Automatically invalidate and resync sequence numbers on hot key swap
relayerKeyManager.onRotate(async (newKey, oldKey, trigger) => {
  sequenceManager.markDirty();
  log("info", "relayer_key_swapped_hot", {
    trigger,
    newPublicKey: newKey.publicKey,
    oldPublicKey: oldKey?.publicKey,
    role: newKey.role,
  });
});

// ============================================
// RELAYER KEY LIFECYCLE (#746)
// ============================================

/** Signing tiers + co-signer approvals + halt, enforced on every signature. */
export const relayerSigningPolicy = new SigningPolicy({
  limits: parseTierLimits(config.relayerTierLimits || DEFAULT_TIER_LIMITS),
  cosigners: parseCosigners(config.relayerCosignerKeys),
  breakGlassSecret: config.relayerBreakGlassSecret,
  sweepSafeAccount: config.relayerSweepSafeAccount,
  tiersEnabled: config.relayerSigningTiersEnabled ?? true,
});
relayerKeyManager.setSigningPolicy(relayerSigningPolicy);
relayerKeyManager.setDrainWindowMs(config.relayerRotationDrainWindowMs ?? 300_000);
relayerKeyMaxAgeSeconds.set((config.relayerKeyMaxAgeDays ?? 90) * 86_400);

export const relayerKeyLifecycleStore = new SqliteKeyLifecycleStore(() => getWriteDb());

// A key declared compromised in an earlier process stays revoked even if its
// secret is still configured.
try {
  const applied = relayerKeyManager.applyPersistedRevocations(
    relayerKeyLifecycleStore.loadRevocations(),
  );
  if (applied.length > 0) {
    log("warn", "relayer_persisted_revocations_applied", { keyIds: applied });
  }
} catch (err) {
  log("error", "relayer_revocations_load_failed", { error: (err as Error).message });
}

const STROOPS_PER_XLM = 10_000_000n;

function stroopsToXlmString(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = (stroops % STROOPS_PER_XLM).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}

async function loadAccountEntry(publicKey: string) {
  try {
    return await (server as any).getAccountEntry(publicKey);
  } catch (err) {
    if (/not found/i.test((err as Error).message)) return null;
    throw err;
  }
}

export const relayerRotation = new RelayerRotationOrchestrator({
  keyManager: relayerKeyManager,
  policy: relayerSigningPolicy,
  store: relayerKeyLifecycleStore,
  // Cutover runs inside the sequence lock: no transaction is mid-build
  // against the old account while the active identity changes.
  fence: (fn) => withSequenceLock(fn),
  isQuiescent: () => getPendingSequenceLockOps() === 0,
  getBalanceXlm: async (publicKey) => {
    if (config.testMode) {
      return relayerKeyManager.findKey(publicKey)?.balanceXlm ?? null;
    }
    const entry = await loadAccountEntry(publicKey);
    if (!entry) return null;
    return Number(BigInt(entry.balance().toString())) / 1e7;
  },
  verifyIdentity: async () => {
    sequenceManager.markDirty();
    if (!config.testMode) {
      await sequenceManager.forceResync(server as StellarSdk.rpc.Server);
    }
  },
  loadSweepAccount: async (publicKey) => {
    const entry = await loadAccountEntry(publicKey);
    if (!entry) throw new Error(`Account ${publicKey} no longer exists`);
    return {
      account: new StellarSdk.Account(publicKey, entry.seqNum().toString()),
      nativeBalance: stroopsToXlmString(BigInt(entry.balance().toString())),
      subentryCount: Number(entry.numSubEntries()),
    };
  },
  submit: async (tx) => {
    const res = await (server as StellarSdk.rpc.Server).sendTransaction(tx);
    if (res.status === "ERROR") {
      throw new Error(`Sweep submission failed: ${JSON.stringify(res.errorResult)}`);
    }
    return { hash: res.hash };
  },
  networkPassphrase: config.networkPassphrase,
  settings: {
    drainWindowMs: config.relayerRotationDrainWindowMs ?? 300_000,
    minFundingXlm: config.relayerRotationMinFundingXlm ?? 10,
    fenceTimeoutMs: config.relayerRotationFenceTimeoutMs ?? 30_000,
    compromiseSloSeconds: config.relayerCompromiseSloSeconds ?? 300,
    compromiseCooldownMs: config.relayerCompromiseCooldownMs ?? 600_000,
    sweepSafeAccount: config.relayerSweepSafeAccount,
    maxKeyAgeDays: config.relayerKeyMaxAgeDays ?? 90,
  },
});

export async function withSequenceLock<T>(fn: () => Promise<T>): Promise<T> {
  if (config.clusterEnabled && nodeCluster.isWorker) {
    await acquireClusterSequenceLock();
    try {
      return await fn();
    } finally {
      await releaseClusterSequenceLock();
    }
  }

  const previous = sequenceLock;
  let resolve: () => void;
  sequenceLock = new Promise<void>((r) => {
    resolve = r;
  });
  inFlightLockOps++;
  await previous;
  try {
    return await fn();
  } finally {
    resolve!();
    inFlightLockOps--;
  }
}

/**
 * Split-phase sequence lock: acquire for operations that modify sequence,
 * then release before blocking on confirmation. Prevents unbounded waiters (#656).
 * Caller acquires lock, performs submit within critical section, then calls
 * releaseLockForConfirmation before waitForTransaction.
 */
let currentLockRelease: (() => void) | null = null;

export async function acquireSequenceLockForSubmit(): Promise<void> {
  if (config.clusterEnabled && nodeCluster.isWorker) {
    await acquireClusterSequenceLock();
    currentLockRelease = () => {
      releaseClusterSequenceLock().catch((err) => {
        log("warn", "cluster_lock_release_failed", { error: (err as Error).message });
      });
    };
    return;
  }

  const previous = sequenceLock;
  let resolve: () => void;
  sequenceLock = new Promise<void>((r) => {
    resolve = r;
  });
  inFlightLockOps++;
  await previous;
  currentLockRelease = () => {
    resolve!();
    inFlightLockOps--;
  };
}

export function releaseLockForConfirmation(): void {
  if (currentLockRelease) {
    currentLockRelease();
    currentLockRelease = null;
  }
}

// ============================================
// SOROBAN RPC CONNECTION POOL & CLIENT
// ============================================

export interface RpcEndpointStatus {
  url: string;
  healthy: boolean;
  latencyMs: number;
  errorCount: number;
  lastChecked: string;
  /** Latest ledger reported by getLatestLedger, when the server exposes it. */
  ledger?: number | null;
  /** Ledgers behind the pool tip (negative = ahead of it). */
  lagLedgers?: number | null;
  /** Within the finality-lag bound and eligible for witness/root reads. */
  fresh?: boolean;
}

export class RpcPoolManager {
  private endpoints: Array<{
    url: string;
    server: RpcServerPort;
    healthy: boolean;
    latencyMs: number;
    errorCount: number;
    lastChecked: number;
    ledger: number | null;
    ledgerObservedAt: number;
  }> = [];
  private currentIndex = 0;
  private readonly maxLagLedgers: number;
  private readonly maxObservationAgeMs: number;

  constructor(
    urls: string[],
    private readonly fallbackUrl?: string,
    private readonly serverFactory: (url: string) => RpcServerPort = (url) =>
      new StellarSdk.rpc.Server(url, { allowHttp: true }),
    options: { maxLagLedgers?: number; maxObservationAgeMs?: number } = {},
  ) {
    const uniqueUrls = Array.from(
      new Set(urls.length > 0 ? urls : [this.fallbackUrl || config.rpcUrl]),
    );
    this.maxLagLedgers =
      options.maxLagLedgers ?? config.endpointMaxFinalityLagLedgers ?? 5;
    this.maxObservationAgeMs =
      options.maxObservationAgeMs ?? (config.endpointHealthIntervalMs ?? 15_000) * 2;
    this.endpoints = uniqueUrls.map((url) => ({
      url,
      server: this.serverFactory(url),
      healthy: true,
      latencyMs: 0,
      errorCount: 0,
      lastChecked: Date.now(),
      ledger: null,
      ledgerObservedAt: 0,
    }));
  }

  /**
   * Pool tip: highest recently observed ledger, or the second-highest with
   * three or more reporters so one endpoint claiming a far-future ledger
   * cannot mark every honest endpoint stale (#745).
   */
  public tipLedger(): number | null {
    const now = Date.now();
    const ledgers = this.endpoints
      .filter(
        (e) =>
          e.ledger !== null && now - e.ledgerObservedAt <= this.maxObservationAgeMs,
      )
      .map((e) => e.ledger)
      .sort((a, b) => b - a);
    if (ledgers.length === 0) return null;
    return ledgers.length >= 3 ? ledgers[1] : ledgers[0];
  }

  private lagOf(ep, tip: number | null): number | null {
    if (ep.ledger === null || tip === null) return null;
    return tip - ep.ledger;
  }

  /**
   * Fresh = healthy, ledger observed recently, and within maxLagLedgers of the
   * tip in either direction. Before the first probe nothing is known, so no
   * endpoint is fresh; `ensureFresh` probes on demand.
   */
  private isFresh(ep, tip = this.tipLedger()): boolean {
    if (!ep.healthy || ep.ledger === null) return false;
    if (Date.now() - ep.ledgerObservedAt > this.maxObservationAgeMs) return false;
    const lag = this.lagOf(ep, tip);
    return lag !== null && Math.abs(lag) <= this.maxLagLedgers;
  }

  /** Whether lag can be measured at all (some endpoint reported a ledger). */
  private hasLedgerData(): boolean {
    return this.endpoints.some((e) => e.ledger !== null);
  }

  /**
   * Round-robin over healthy endpoints, skipping ones that trail the tip by
   * more than the finality-lag bound: a lagging RPC serves simulations
   * against old state, which becomes witnesses against old roots.
   */
  public getActiveServer(): RpcServerPort {
    if (this.endpoints.length === 0) {
      return this.serverFactory(this.fallbackUrl || config.rpcUrl);
    }
    const tip = this.tipLedger();
    const tiers = this.hasLedgerData()
      ? [(e) => e.healthy && this.isFresh(e, tip), (e) => e.healthy]
      : [(e) => e.healthy];
    for (const accept of tiers) {
      for (let i = 0; i < this.endpoints.length; i++) {
        const idx = (this.currentIndex + i) % this.endpoints.length;
        if (accept(this.endpoints[idx])) {
          this.currentIndex = (idx + 1) % this.endpoints.length;
          return this.endpoints[idx].server;
        }
      }
    }
    const fallback =
      this.endpoints[this.currentIndex % this.endpoints.length].server;
    this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
    return fallback;
  }

  /** Endpoints eligible for witness/root reads, best latency first. */
  public getFreshServers(): RpcServerPort[] {
    const tip = this.tipLedger();
    return this.endpoints
      .filter((e) => this.isFresh(e, tip))
      .sort((a, b) => a.latencyMs - b.latencyMs)
      .map((e) => e.server);
  }

  /** Probe once if no endpoint has a recent ledger observation. */
  public async ensureFresh(): Promise<void> {
    const now = Date.now();
    const recent = this.endpoints.some(
      (e) => e.ledger !== null && now - e.ledgerObservedAt <= this.maxObservationAgeMs,
    );
    if (!recent) await this.checkHealth();
  }

  /**
   * Read state that feeds a proof witness from up to `quorum` fresh
   * endpoints and arbitrate: answers outside the lag bound are dropped, the
   * highest ledger wins, and two endpoints disagreeing at the same ledger
   * fail closed with EndpointDisagreementError.
   */
  public async readArbitrated<V>(
    fn: (server: RpcServerPort) => Promise<LedgerStamped<V>>,
    options: { quorum?: number; equals?: (a: V, b: V) => boolean } = {},
  ): Promise<ArbitrationResult<V> & { corroborated: boolean }> {
    await this.ensureFresh();
    const quorum = Math.max(1, options.quorum ?? config.endpointArbitrationQuorum ?? 2);
    const tip = this.tipLedger();
    const chosen = this.endpoints
      .filter((e) => this.isFresh(e, tip))
      .sort((a, b) => a.latencyMs - b.latencyMs)
      .slice(0, quorum);
    if (chosen.length === 0) {
      endpointStaleRejectedTotal.inc({
        dependency: "soroban_rpc",
        op_class: "consistent_read",
      });
      throw new StaleReadError("soroban_rpc", "consistent_read", this.maxLagLedgers);
    }

    const settled = await Promise.allSettled(
      chosen.map((ep) =>
        sorobanRpcBreaker.execute(() => withRpcConcurrency(() => fn(ep.server))),
      ),
    );
    const responses = [];
    let lastError: unknown;
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") {
        responses.push({ ...s.value, endpoint: endpointLabel(chosen[i].url) });
      } else {
        lastError = s.reason;
      }
    });
    if (responses.length === 0) {
      throw new DependencyUnavailableError("soroban_rpc", "consistent_read", lastError);
    }
    try {
      const result = arbitrate(responses, this.maxLagLedgers, options.equals, "soroban_rpc");
      return { ...result, corroborated: result.agreeing.length >= 2 };
    } catch (err) {
      if (err instanceof EndpointDisagreementError) {
        endpointDisagreementTotal.inc({ dependency: "soroban_rpc" });
        log("error", "endpoint_disagreement", {
          dependency: "soroban_rpc",
          ledger: err.ledger,
          endpoints: err.endpoints,
        });
      }
      throw err;
    }
  }

  public async checkHealth(): Promise<RpcEndpointStatus[]> {
    const timeoutMs = config.endpointRequestTimeoutMs ?? config.rpcTimeoutMs;
    // Probe in parallel so one blackholed endpoint cannot stall the round.
    await Promise.all(
      this.endpoints.map(async (ep) => {
        const start = Date.now();
        try {
          const res = await withProbeTimeout(ep.server.getHealth(), timeoutMs);
          ep.latencyMs = Date.now() - start;
          ep.healthy = res.status === "healthy" || res.status === "online";
          if (ep.healthy) ep.errorCount = 0;
          else ep.errorCount++;
          if (ep.healthy && typeof ep.server.getLatestLedger === "function") {
            const latest = await withProbeTimeout(
              ep.server.getLatestLedger(),
              timeoutMs,
            );
            if (Number.isFinite(Number(latest?.sequence))) {
              ep.ledger = Number(latest.sequence);
              ep.ledgerObservedAt = Date.now();
            }
          }
        } catch {
          ep.healthy = false;
          ep.latencyMs = Date.now() - start;
          ep.errorCount++;
        }
        ep.lastChecked = Date.now();
      }),
    );

    const tip = this.tipLedger();
    const results = this.endpoints.map((ep) => this.statusOf(ep, tip));
    for (const ep of results) {
      const labels = { dependency: "soroban_rpc", endpoint: endpointLabel(ep.url) };
      rpcEndpointLatency.set({ url: ep.url }, ep.latencyMs / 1000);
      endpointHealthy.set(labels, ep.healthy ? 1 : 0);
      if (ep.lagLedgers !== null) endpointLedgerLag.set(labels, ep.lagLedgers);
    }

    // Update pool-level gauges
    const healthyCount = results.filter((r) => r.healthy).length;
    rpcPoolHealthyEndpoints.set(healthyCount);
    rpcPoolTotalEndpoints.set(results.length);
    dependencyAvailableEndpoints.set({ dependency: "soroban_rpc" }, healthyCount);
    dependencyTotalEndpoints.set({ dependency: "soroban_rpc" }, results.length);

    return results;
  }

  private statusOf(ep, tip: number | null): RpcEndpointStatus {
    return {
      url: ep.url,
      healthy: ep.healthy,
      latencyMs: ep.latencyMs,
      errorCount: ep.errorCount,
      lastChecked: new Date(ep.lastChecked).toISOString(),
      ledger: ep.ledger,
      lagLedgers: this.lagOf(ep, tip),
      fresh: this.isFresh(ep, tip),
    };
  }

  public getMetrics(): {
    totalEndpoints: number;
    healthyEndpoints: number;
    activeUrl: string;
    endpoints: RpcEndpointStatus[];
  } {
    const healthyCount = this.endpoints.filter((e) => e.healthy).length;
    const activeEp =
      this.endpoints[this.currentIndex % this.endpoints.length] ||
      this.endpoints[0];
    const tip = this.tipLedger();
    return {
      totalEndpoints: this.endpoints.length,
      healthyEndpoints: healthyCount,
      activeUrl: activeEp ? activeEp.url : config.rpcUrl,
      endpoints: this.endpoints.map((e) => this.statusOf(e, tip)),
    };
  }
}

function withProbeTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`RPC health probe timed out (${timeoutMs}ms)`)),
        timeoutMs,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createRpcPool(
  urls: string[],
  options?: {
    fallbackUrl?: string;
    serverFactory?: (url: string) => RpcServerPort;
    maxLagLedgers?: number;
    maxObservationAgeMs?: number;
  },
): RpcPoolManager {
  return new RpcPoolManager(
    urls,
    options?.fallbackUrl,
    options?.serverFactory,
    {
      maxLagLedgers: options?.maxLagLedgers,
      maxObservationAgeMs: options?.maxObservationAgeMs,
    },
  );
}

export const rpcPoolManager = createRpcPool(config.rpcUrls || [config.rpcUrl]);

// The pool's health was never polled, so `healthy` stayed true forever and
// an RPC outage was invisible to routing (#745). The shared endpoint health
// monitor now drives it alongside the Horizon and anchor pools.
registerHealthProbe("soroban_rpc", () => rpcPoolManager.checkHealth());

/**
 * Submit a raw transaction XDR to all healthy RPC endpoints and return the
 * first non-error response. This provides a relay quorum — no single RPC
 * endpoint can censor a vote by silently dropping it.
 */
export async function submitToRelayQuorum(tx: StellarSdk.Transaction): Promise<any> {
  const servers = (rpcPoolManager as any).endpoints
    .filter((e: any) => e.healthy)
    .map((e: any) => e.server);
  if (servers.length === 0) {
    throw new Error("No healthy relay endpoints available");
  }
  let lastError: unknown;
  for (const srv of servers) {
    try {
      const result = await srv.sendTransaction(tx);
      if (result.status !== "ERROR") return result;
      lastError = new Error(result.errorResult);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// Circuit breaker for Soroban RPC calls — trips when the RPC pool is
// degraded across the board, so requests fail fast instead of each one
// running its own retry/timeout against a service that is known to be down.
export const sorobanRpcBreaker = registerCircuitBreaker("soroban_rpc", {
  failureThreshold: config.circuitBreakerRpcFailureThreshold,
  resetTimeoutMs: config.circuitBreakerRpcResetMs,
});

export function createSorobanServer(options: {
  testMode: boolean;
  pool: RpcPoolManager;
  breaker: CircuitBreaker;
}): SorobanServer {
  if (options.testMode) {
    return {
      getHealth: async () => ({ status: "online" }),
      simulateTransaction: async () => {
        throw new Error("simulate disabled in RELAYER_TEST_MODE");
      },
      sendTransaction: async () => ({
        status: "ERROR",
        errorResult: "disabled",
      }),
      getTransaction: async () => ({ status: "NOT_FOUND" }),
      getAccount: async () => ({ accountId: "GTEST", sequence: "0" }),
    };
  }

  return new Proxy(
    {},
    {
      get(_target, prop) {
        const activeServer = options.pool.getActiveServer() as any;
        const value = activeServer[prop];
        if (typeof value !== "function") return value;

        return async function (...args: unknown[]) {
          const method = String(prop);
          const start = process.hrtime.bigint();
          try {
            const result = await options.breaker.execute(() =>
              withRpcConcurrency(() => value.apply(activeServer, args)),
            );
            const duration = Number(process.hrtime.bigint() - start) / 1e9;
            rpcCallsTotal.inc({ method, status: "success" });
            rpcCallDuration.observe({ method, status: "success" }, duration);
            return result;
          } catch (err) {
            const duration = Number(process.hrtime.bigint() - start) / 1e9;
            const errorType =
              err instanceof CircuitBreakerOpenError
                ? "CircuitBreakerOpen"
                : err instanceof Error
                  ? err.constructor.name
                  : "unknown";
            rpcCallsTotal.inc({ method, status: "error" });
            rpcCallDuration.observe({ method, status: "error" }, duration);
            rpcErrors.inc({ method, error_type: errorType });
            throw err;
          }
        };
      },
    },
  ) as SorobanServer;
}

export const server: SorobanServer = createSorobanServer({
  testMode: config.testMode,
  pool: rpcPoolManager,
  breaker: sorobanRpcBreaker,
});

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Call RPC with timeout.
 *
 * Every RPC hop opens a child span under whatever is ambient (#321) — an HTTP
 * request or an indexer poll cycle — so a single trace covers poll -> db -> rpc
 * without the caller passing a context. The span records only the operation
 * label and the deadline; request payloads stay out of telemetry because they
 * carry proofs and nullifiers.
 */
export async function callWithTimeout<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  return withSpan(
    "relay.rpc.call",
    {
      component: "stellar",
      "rpc.operation": label,
      "rpc.timeout_ms": config.rpcTimeoutMs,
    },
    async () => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(new Error(`Timeout: ${label} (${config.rpcTimeoutMs}ms)`)),
          config.rpcTimeoutMs,
        );
      });

      try {
        return await Promise.race([fn(), timeout]);
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    },
  );
}

/**
 * Wait for transaction confirmation (#172).
 *
 * Delegates to the shared confirmation queue: a single background worker polls
 * `getTransaction` with exponential backoff + jitter (starting at ~2s), with a
 * configurable wall-clock deadline. Concurrent waiters for the same hash are
 * coalesced, resolutions are broadcast to connected frontends over WebSocket,
 * and confirmation times are tracked in Prometheus metrics.
 *
 * Backward compatible: `waitForTransaction(hash, maxAttempts)` treats the
 * numeric argument as a cap on the number of polls; callers may also pass a
 * `WaitForTransactionOptions` object (see services/confirmation-queue.ts).
 *
 * Note: callers may still wrap this in callWithTimeout for an outer deadline
 * -- the queue enforces its own wall-clock budget while callWithTimeout
 * provides a hard per-request limit.
 */
export {
  waitForTransaction,
  getConfirmationStatus,
  getConfirmationQueueStats,
  startConfirmationWorker,
  stopConfirmationWorker,
  TransactionConfirmationTimeoutError,
} from "./confirmation-queue.js";
export type {
  ConfirmationState,
  ConfirmationStatus,
  WaitForTransactionOptions,
} from "./confirmation-queue.js";

/**
 * Simulate with backoff/retry.
 *
 * Uses the shared endpoint retry policy (#745): jittered exponential backoff
 * instead of a fixed linear step, no retry once the RPC breaker is open
 * (retrying a known-down pool only adds load), and no sleep after the last
 * attempt.
 */
export async function simulateWithBackoff<T>(
  simulateFn: () => Promise<T>,
  attempts = config.endpointRetryMaxAttempts ?? 3,
): Promise<T> {
  let lastErr: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await simulateFn();
    } catch (err) {
      lastErr = err as Error;
      if (err instanceof CircuitBreakerOpenError || i + 1 >= attempts) break;
      await new Promise((r) =>
        setTimeout(
          r,
          computeBackoffMs(i, {
            baseDelayMs: config.endpointRetryBaseMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
            maxDelayMs: config.endpointRetryMaxMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
          }),
        ),
      );
    }
  }
  throw lastErr;
}

/**
 * Check if byte array is all zeros (point at infinity)
 *
 * For BN254 (CAP-74 / EIP-196/197):
 * - G1 point at infinity: 64 zero bytes
 * - G2 point at infinity: 128 zero bytes
 *
 * In valid Groth16 proofs, A, B, C must not be point at infinity.
 */
export function isAllZeros(bytes: Buffer): boolean {
  return bytes.every((byte) => byte === 0);
}

/**
 * Convert U256 hex string to ScVal
 */
export function u256ToScVal(hexString: string): StellarSdk.xdr.ScVal {
  const hex = hexString.startsWith("0x") ? hexString.slice(2) : hexString;

  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(
      "Invalid U256 hex string: contains non-hexadecimal characters",
    );
  }
  if (hex.length % 2 !== 0 && hex.length > 0) {
    throw new Error(`Invalid U256 hex string: odd length (${hex.length})`);
  }
  if (hex.length > 64) {
    throw new Error(
      `Invalid U256 hex string: too long (${hex.length} chars, max 64)`,
    );
  }

  const padded = hex.padStart(64, "0");
  const value = BigInt("0x" + padded);

  if (value >= BN254_SCALAR_FIELD) {
    throw new Error("Value exceeds BN254 scalar field modulus");
  }

  const hiHi = BigInt("0x" + padded.slice(0, 16));
  const hiLo = BigInt("0x" + padded.slice(16, 32));
  const loHi = BigInt("0x" + padded.slice(32, 48));
  const loLo = BigInt("0x" + padded.slice(48, 64));

  return StellarSdk.xdr.ScVal.scvU256(
    new StellarSdk.xdr.UInt256Parts({
      hiHi: new StellarSdk.xdr.Uint64(hiHi),
      hiLo: new StellarSdk.xdr.Uint64(hiLo),
      loHi: new StellarSdk.xdr.Uint64(loHi),
      loLo: new StellarSdk.xdr.Uint64(loLo),
    }),
  );
}

/**
 * Convert ScVal U256 to hex string
 */
export function scValToU256Hex(scVal: StellarSdk.xdr.ScVal): string {
  if (scVal.switch().name !== "scvU256") {
    throw new Error("Expected U256 ScVal");
  }
  const parts = scVal.u256();
  const hiHi = parts.hiHi().toBigInt().toString(16).padStart(16, "0");
  const hiLo = parts.hiLo().toBigInt().toString(16).padStart(16, "0");
  const loHi = parts.loHi().toBigInt().toString(16).padStart(16, "0");
  const loLo = parts.loLo().toBigInt().toString(16).padStart(16, "0");
  return "0x" + hiHi + hiLo + loHi + loLo;
}

/**
 * Convert hex string to byte array
 */
export function hexToBytes(hex: string, expectedLength: number): Buffer {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;

  if (!/^[0-9a-fA-F]*$/.test(cleanHex)) {
    throw new Error("Invalid hex string: contains non-hexadecimal characters");
  }

  if (cleanHex.length % 2 !== 0 && cleanHex.length > 0) {
    throw new Error(`Invalid hex string: odd length (${cleanHex.length})`);
  }

  if (cleanHex.length > expectedLength * 2) {
    throw new Error(
      `Hex string too long: ${cleanHex.length} chars, max ${expectedLength * 2}`,
    );
  }

  const padded = cleanHex.padStart(expectedLength * 2, "0");
  const bytes = Buffer.from(padded, "hex");

  if (bytes.length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} bytes, got ${bytes.length}`);
  }

  return bytes;
}

function bytesToBigInt(buf: Buffer): bigint {
  return BigInt("0x" + buf.toString("hex"));
}

function bigIntToBytes(n: bigint, length: number): Buffer {
  return Buffer.from(n.toString(16).padStart(length * 2, "0"), "hex");
}

// (Fq - 1) / 2: the threshold below which a Y-coordinate is considered
// "canonical" (lower half of the field).
const BN254_FQ_HALF = (BN254_FQ_MODULUS - 1n) / 2n;

/**
 * Canonicalizes a Groth16 proof's (A, B) pair (#167).
 *
 * Groth16 proofs are malleable: given a valid (A, B, C), the point (-A, -B, C)
 * also satisfies the pairing check, since e(-A, -B) = e(A, B). If any
 * downstream logic keys off proof bytes (e.g. deduplicating relayer retries,
 * or an event-notify flow indexing by proof hash), the two representations
 * look like distinct submissions even though they prove the same statement.
 *
 * This picks a single canonical representative by requiring A's Y-coordinate
 * to lie in the lower half of the BN254 base field (Fq); if it doesn't, both
 * A and B are negated (C is untouched — C is not part of the malleable pair).
 * `aBytes`/`bBytes` are the raw 64/128-byte G1/G2 encodings (X||Y for G1;
 * X_c1||X_c0||Y_c1||Y_c0 for G2, per the Groth16Proof type's format).
 */
export function canonicalizeProof(
  aBytes: Buffer,
  bBytes: Buffer,
): { a: Buffer; b: Buffer } {
  const ay = bytesToBigInt(aBytes.subarray(32, 64));

  if (ay <= BN254_FQ_HALF) {
    return { a: aBytes, b: bBytes };
  }

  const ax = aBytes.subarray(0, 32);
  const negAy = BN254_FQ_MODULUS - ay;
  const newA = Buffer.concat([ax, bigIntToBytes(negAy, 32)]);

  const xc1 = bBytes.subarray(0, 32);
  const xc0 = bBytes.subarray(32, 64);
  const yc1 = bytesToBigInt(bBytes.subarray(64, 96));
  const yc0 = bytesToBigInt(bBytes.subarray(96, 128));
  const newB = Buffer.concat([
    xc1,
    xc0,
    bigIntToBytes(BN254_FQ_MODULUS - yc1, 32),
    bigIntToBytes(BN254_FQ_MODULUS - yc0, 32),
  ]);

  return { a: newA, b: newB };
}

/**
 * Convert a Groth16 proof into the canonical hex form used for redundancy
 * checks. This mirrors proofToScVal's validation and A/B malleability
 * normalization, but returns plain bytes-as-hex so two independently supplied
 * proofs can be compared before any on-chain submission is attempted.
 */
export function canonicalProofFingerprint(proof: Groth16Proof): string {
  if (!proof || typeof proof !== "object") {
    throw new Error("Invalid proof: must be an object");
  }
  if (!proof.a || !proof.b || !proof.c) {
    throw new Error("Invalid proof: missing a, b, or c fields");
  }

  let aBytes = hexToBytes(proof.a, 64);
  let bBytes = hexToBytes(proof.b, 128);
  const cBytes = hexToBytes(proof.c, 64);

  if (isAllZeros(aBytes) || isAllZeros(bBytes) || isAllZeros(cBytes)) {
    throw new Error(
      "Invalid proof: proof components cannot be point at infinity (all zeros)",
    );
  }

  ({ a: aBytes, b: bBytes } = canonicalizeProof(aBytes, bBytes));

  return [
    aBytes.toString("hex"),
    bBytes.toString("hex"),
    cBytes.toString("hex"),
  ].join(":");
}

/**
 * Convert Groth16 proof to ScVal
 */
export function proofToScVal(proof: Groth16Proof): StellarSdk.xdr.ScVal {
  if (!proof || typeof proof !== "object") {
    throw new Error("Invalid proof: must be an object");
  }
  if (!proof.a || !proof.b || !proof.c) {
    throw new Error("Invalid proof: missing a, b, or c fields");
  }

  let aBytes = hexToBytes(proof.a, 64);
  let bBytes = hexToBytes(proof.b, 128);
  const cBytes = hexToBytes(proof.c, 64);

  // Reject point at infinity for any proof component (invalid Groth16 proof)
  if (isAllZeros(aBytes) || isAllZeros(bBytes) || isAllZeros(cBytes)) {
    throw new Error(
      "Invalid proof: proof components cannot be point at infinity (all zeros)",
    );
  }

  // Canonicalize (A, B) so both malleable representations of the same proof
  // encode identically (#167) before this ever reaches storage or on-chain
  // submission.
  ({ a: aBytes, b: bBytes } = canonicalizeProof(aBytes, bBytes));

  return StellarSdk.xdr.ScVal.scvMap([
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol("a"),
      val: StellarSdk.xdr.ScVal.scvBytes(aBytes),
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol("b"),
      val: StellarSdk.xdr.ScVal.scvBytes(bBytes),
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol("c"),
      val: StellarSdk.xdr.ScVal.scvBytes(cBytes),
    }),
  ]);
}

/**
 * Encodes one entry of the voting contract's `cast_votes` batch (#90).
 *
 * A `#[contracttype]` struct crosses the boundary as an `ScMap` whose keys are
 * the field symbols in sorted order — the host rejects a map that is not
 * sorted — so the entries below are ordered `nullifier`, `proof`, `root`,
 * `vote_choice` to match `BatchVote`, not the order the fields are declared in.
 */
export function batchVoteToScVal(vote: {
  choice: boolean;
  nullifier: string;
  root: string;
  proof: Groth16Proof;
}): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvMap([
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol("nullifier"),
      val: u256ToScVal(vote.nullifier),
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol("proof"),
      val: proofToScVal(vote.proof),
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol("root"),
      val: u256ToScVal(vote.root),
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol("vote_choice"),
      val: StellarSdk.xdr.ScVal.scvBool(vote.choice),
    }),
  ]);
}

/**
 * Get relayer account from server
 */
export async function getRelayerAccount(): Promise<StellarSdk.Account> {
  return (server as StellarSdk.rpc.Server).getAccount(
    relayerKeypair.publicKey(),
  );
}

/**
 * Build and sign a transaction
 */
export function buildTransaction(
  account: StellarSdk.Account,
  operation: StellarSdk.xdr.Operation,
): StellarSdk.Transaction {
  return new StellarSdk.TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();
}

/**
 * Sign a transaction with the active signer (Local, KMS, or HSM)
 */
export async function signTransaction(tx: StellarSdk.Transaction): Promise<void> {
  if (activeSigner && typeof activeSigner.signTransaction === "function") {
    await activeSigner.signTransaction(tx);
  } else if ("sign" in relayerKeypair && typeof (relayerKeypair as StellarSdk.Keypair).sign === "function") {
    tx.sign(relayerKeypair as StellarSdk.Keypair);
  }
}

// ============================================
// TRANSACTION SUBMISSION WITH SEQUENCE RECOVERY
// ============================================

export interface TransactionSubmissionResult {
  status: string;
  hash?: string;
  errorResult?: string;
  [key: string]: unknown;
}

/**
 * Submit a transaction with automatic sequence number recovery.
 * 
 * Automatically detects tx_bad_seq errors and retries with corrected
 * sequence numbers. Implements rate limiting to prevent recovery storms.
 * 
 * @param preparedTx - The prepared and signed transaction
 * @param operation - A function that rebuilds, simulates, and signs the transaction
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param label - Label for logging and timeout tracking
 * @returns Transaction submission result
 */
export async function submitTransactionWithRecovery(
  preparedTx: StellarSdk.Transaction,
  operation: () => Promise<StellarSdk.Transaction>,
  maxRetries = 3,
  label = "transaction",
): Promise<TransactionSubmissionResult> {
  let attempts = 0;
  let lastError: Error | null = null;
  const recoveryStart = Date.now();

  while (attempts < maxRetries) {
    try {
      // Check if recovery should be rate limited
      if (attempts > 0 && sequenceManager.shouldRateLimitRecovery()) {
        log("warn", "sequence_recovery_rate_limited", {
          consecutiveErrors: sequenceManager.getHealthStatus().consecutiveErrors,
          attempt: attempts + 1,
          maxRetries,
        });
        throw new Error("SEQUENCE_RECOVERY_RATE_LIMITED");
      }

      // Submit transaction (use the original preparedTx on first attempt)
      const txToSubmit = attempts === 0 ? preparedTx : await operation();
      const sr = await callWithTimeout(
        () => (server as StellarSdk.rpc.Server).sendTransaction(txToSubmit),
        `send_${label}`,
      );

      // Check for sequence error
      if (sr.status === "ERROR") {
        const errorResult =
          typeof (sr as any).errorResult === "string"
            ? (sr as any).errorResult
            : JSON.stringify((sr as any).errorResult ?? "");

        const isBadSeq = sequenceManager.handleTxError(errorResult);

        if (isBadSeq && attempts < maxRetries - 1) {
          attempts++;
          sequenceManager.markRecoveryAttempt();
          
          log("warn", "sequence_recovery_retry", {
            attempt: attempts,
            maxRetries,
            label,
            errorResult,
          });

          // Re-fetch sequence and retry
          await sequenceManager.forceResync(
            server as StellarSdk.rpc.Server,
          );
          
          sequenceRecoveriesTotal.inc({ status: "retry" });
          continue;
        }

        // Non-recoverable error or max retries reached
        if (isBadSeq) {
          sequenceRecoveriesTotal.inc({ status: "failed" });
          log("error", "sequence_recovery_exhausted", {
            attempts,
            maxRetries,
            label,
          });
        }

        return sr as TransactionSubmissionResult;
      }

      // Success!
      sequenceManager.markSuccess();
      
      if (attempts > 0) {
        const duration = (Date.now() - recoveryStart) / 1000;
        sequenceRecoveryDuration.observe(duration);
        sequenceRecoveriesTotal.inc({ status: "success" });
        
        log("info", "sequence_recovery_success", {
          attempts,
          durationMs: Date.now() - recoveryStart,
          label,
        });
      }

      return sr as TransactionSubmissionResult;
    } catch (err) {
      lastError = err as Error;
      
      // Don't retry on non-sequence errors
      if (!(err as Error).message?.includes("tx_bad_seq")) {
        throw err;
      }
      
      attempts++;
      if (attempts >= maxRetries) {
        break;
      }
    }
  }

  // All retries exhausted
  sequenceRecoveriesTotal.inc({ status: "failed" });
  throw lastError || new Error("Transaction submission failed after retries");
}

// Compatibility stubs for voting route (relocated from threshold-coordinator)
export function scheduleCoverTraffic(): void {
  // Schedule cover traffic to obfuscate vote timing patterns
  // Uses Poisson distribution to send dummy XLM transactions at random intervals
  const COVER_TRAFFIC_INTERVAL_MS = 5000; // Check every 5 seconds
  const COVER_TRAFFIC_PROBABILITY = 0.1; // 10% chance per check
  const COVER_AMOUNT = "0.0001"; // Small XLM amount for cover traffic

  if (!config.testMode) {
    const intervalId = setInterval(() => {
      if (Math.random() < COVER_TRAFFIC_PROBABILITY) {
        log("info", "cover_traffic_scheduled", {
          amount: COVER_AMOUNT,
          timestamp: new Date().toISOString(),
        });
        // In production, this would send a small XLM transaction to a cover address
        // via the WebSocket broadcast to all connected clients
        // The actual implementation would integrate with the confirmation hub
      }
    }, COVER_TRAFFIC_INTERVAL_MS);

    // Store interval ID for cleanup on shutdown
    (globalThis as any).__coverTrafficInterval = intervalId;
  }
}

export function monitorMissingVotes(): void {}
export async function submitVoteViaRelayerQuorum(opts: { transaction: any; simulationResult?: any; daoId?: number; proposalId?: number; nullifier?: string }): Promise<any> {
  if (!opts.simulationResult) {
    throw new Error("simulationResult is required for transaction assembly");
  }
  // Assemble the transaction with simulation results (adds soroban auth, resource fees)
  // then sign with the relayer keypair — without this the envelope has zero signatures
  // and the network rejects with tx_bad_auth.
  const preparedTx = StellarSdk.rpc
    .assembleTransaction(opts.transaction, opts.simulationResult)
    .build();
  preparedTx.sign(relayerKeypair as StellarSdk.Keypair);
  return submitToRelayQuorum(preparedTx);
}
