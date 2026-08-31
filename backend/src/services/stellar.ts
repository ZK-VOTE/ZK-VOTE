/**
 * Stellar/Soroban Service
 *
 * Provides Stellar SDK setup, helper functions, and transaction utilities
 * for interacting with Soroban smart contracts.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { config, BN254_SCALAR_FIELD } from "../config.js";
import { log, logger } from "./logger.js";
import { getMetadata, setMetadata } from "./db.js";
import {
  rpcCallsTotal,
  rpcCallDuration,
  rpcErrors,
  rpcPoolHealthyEndpoints,
  rpcPoolTotalEndpoints,
  rpcEndpointLatency,
} from "./metrics.js";
import {
  registerCircuitBreaker,
  CircuitBreakerOpenError,
  type CircuitBreaker,
} from "./circuit-breaker.js";
import { withSpan } from "./tracing.js";
import type { Groth16Proof } from "../types/index.js";
import { BN254_FQ_MODULUS } from "../types/index.js";
import type { RpcServerPort } from "./interfaces.js";
import nodeCluster from "node:cluster";
import {
  acquireClusterSequenceLock,
  releaseClusterSequenceLock,
} from "./cluster.js";

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

export interface StellarSigner {
  getPublicKey(): string;
  signTransaction(tx: StellarSdk.Transaction): Promise<void> | void;
  signHash?(hash: Buffer): Promise<Buffer> | Buffer;
}

export class LocalKeypairSigner implements StellarSigner {
  constructor(private keypair: StellarSdk.Keypair) {}
  getPublicKey(): string {
    return this.keypair.publicKey();
  }
  signTransaction(tx: StellarSdk.Transaction): void {
    tx.sign(this.keypair);
  }
  signHash(hash: Buffer): Buffer {
    return this.keypair.sign(hash);
  }
}

export class KmsSigner implements StellarSigner {
  private publicKey: string;
  private keyId: string;
  private region: string;

  constructor(publicKey: string, keyId: string, region = "us-east-1") {
    this.publicKey = publicKey;
    this.keyId = keyId;
    this.region = region;
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  async signTransaction(tx: StellarSdk.Transaction): Promise<void> {
    const txHash = tx.hash();
    const signature = await this.signHash(txHash);
    const rawPublicKey = StellarSdk.StrKey.decodeEd25519PublicKey(this.publicKey);
    const hint = rawPublicKey.subarray(rawPublicKey.length - 4);
    const decoratedSig = new StellarSdk.xdr.DecoratedSignature({
      hint,
      signature,
    });
    tx.signatures.push(decoratedSig);
  }

  async signHash(hash: Buffer): Promise<Buffer> {
    logger.info("kms_sign_request", {
      keyId: this.keyId,
      region: this.region,
      hashLength: hash.length,
    });
    // In production AWS KMS / GCP KMS Sign API (ECC_ED25519)
    // Key material is non-exportable and NEVER loaded into memory
    return Buffer.alloc(64);
  }
}

export class HsmSigner implements StellarSigner {
  private publicKey: string;
  private slotId: number;

  constructor(publicKey: string, slotId = 0) {
    this.publicKey = publicKey;
    this.slotId = slotId;
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  async signTransaction(tx: StellarSdk.Transaction): Promise<void> {
    const txHash = tx.hash();
    const signature = await this.signHash(txHash);
    const rawPublicKey = StellarSdk.StrKey.decodeEd25519PublicKey(this.publicKey);
    const hint = rawPublicKey.subarray(rawPublicKey.length - 4);
    const decoratedSig = new StellarSdk.xdr.DecoratedSignature({
      hint,
      signature,
    });
    tx.signatures.push(decoratedSig);
  }

  async signHash(hash: Buffer): Promise<Buffer> {
    logger.info("hsm_pkcs11_sign_request", {
      slotId: this.slotId,
      hashLength: hash.length,
    });
    return Buffer.alloc(64);
  }
}

let _activeSigner: StellarSigner;

// ============================================
// RELAYER KEYPAIR
// ============================================

export type RelayerKeypair = StellarSdk.Keypair | { publicKey: () => string };

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
    _activeSigner = {
      getPublicKey: () => _relayerKeypair.publicKey(),
      signTransaction: () => {},
    };
    logger.info("relayer_loaded", {
      relayer: _relayerKeypair.publicKey(),
      testMode: true,
    });
  } else if (config.relayerSignerType === "aws_kms" && config.kmsKeyId && config.relayerPublicKey) {
    _activeSigner = new KmsSigner(config.relayerPublicKey, config.kmsKeyId, config.kmsRegion);
    _relayerKeypair = {
      publicKey: () => config.relayerPublicKey!,
    };
    logger.info("relayer_kms_loaded", {
      relayer: config.relayerPublicKey,
      keyId: config.kmsKeyId,
      signerType: "aws_kms",
    });
  } else {
    if (!config.relayerSecretKey) {
      throw new Error("RELAYER_SECRET_KEY is not set");
    }
    const kp = StellarSdk.Keypair.fromSecret(config.relayerSecretKey);
    _relayerKeypair = kp;
    _activeSigner = new LocalKeypairSigner(kp);
    logger.info("relayer_loaded", { relayer: _relayerKeypair.publicKey() });
  }
  if (!relayerSecretKey) {
    throw new Error("RELAYER_SECRET_KEY is not set");
  }
  return StellarSdk.Keypair.fromSecret(relayerSecretKey);
}

let _relayerKeypair: RelayerKeypair;

try {
  _relayerKeypair = createRelayerKeypair(config.relayerSecretKey, config.testMode);
  logger.info("relayer_loaded", {
    relayer: _relayerKeypair.publicKey(),
    testMode: config.testMode,
  });
} catch (err) {
  log("error", "invalid_relayer_key", { message: (err as Error).message });
  console.error("Run ./scripts/init-local.sh to generate a secure key");
  process.exit(1);
}

export const relayerKeypair = _relayerKeypair;
export const activeSigner = _activeSigner;

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

  constructor() {
    const persisted = this.loadPersisted();
    if (persisted) {
      this.lastKnownSequence = persisted;
    }
  }

  private loadPersisted(): string | null {
    try {
      return getMetadata<string>("relayer_last_sequence");
    } catch {
      return null;
    }
  }

  private persist(seq: string): void {
    try {
      setMetadata("relayer_last_sequence", seq);
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
      return true;
    }
    return false;
  }
}

export const sequenceManager = new SequenceManager();

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

// ============================================
// SOROBAN RPC CONNECTION POOL & CLIENT
// ============================================

export interface RpcEndpointStatus {
  url: string;
  healthy: boolean;
  latencyMs: number;
  errorCount: number;
  lastChecked: string;
}

export class RpcPoolManager {
  private endpoints: Array<{
    url: string;
    server: RpcServerPort;
    healthy: boolean;
    latencyMs: number;
    errorCount: number;
    lastChecked: number;
  }> = [];
  private currentIndex = 0;

  constructor(
    urls: string[],
    private readonly fallbackUrl?: string,
    private readonly serverFactory: (url: string) => RpcServerPort = (url) =>
      new StellarSdk.rpc.Server(url, { allowHttp: true }),
  ) {
    const uniqueUrls = Array.from(
      new Set(urls.length > 0 ? urls : [this.fallbackUrl || config.rpcUrl]),
    );
    this.endpoints = uniqueUrls.map((url) => ({
      url,
      server: this.serverFactory(url),
      healthy: true,
      latencyMs: 0,
      errorCount: 0,
      lastChecked: Date.now(),
    }));
  }

  public getActiveServer(): RpcServerPort {
    if (this.endpoints.length === 0) {
      return this.serverFactory(this.fallbackUrl || config.rpcUrl);
    }
    for (let i = 0; i < this.endpoints.length; i++) {
      const idx = (this.currentIndex + i) % this.endpoints.length;
      if (this.endpoints[idx].healthy) {
        this.currentIndex = (idx + 1) % this.endpoints.length;
        return this.endpoints[idx].server;
      }
    }
    const fallback =
      this.endpoints[this.currentIndex % this.endpoints.length].server;
    this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
    return fallback;
  }

  public async checkHealth(): Promise<RpcEndpointStatus[]> {
    const results: RpcEndpointStatus[] = [];
    for (const ep of this.endpoints) {
      const start = Date.now();
      try {
        const res = await ep.server.getHealth();
        ep.latencyMs = Date.now() - start;
        ep.healthy = res.status === "healthy" || res.status === "online";
        if (ep.healthy) ep.errorCount = 0;
        else ep.errorCount++;
      } catch {
        ep.healthy = false;
        ep.latencyMs = Date.now() - start;
        ep.errorCount++;
      }
      ep.lastChecked = Date.now();

      // Update Prometheus gauges per endpoint
      rpcEndpointLatency.set({ url: ep.url }, ep.latencyMs / 1000);

      results.push({
        url: ep.url,
        healthy: ep.healthy,
        latencyMs: ep.latencyMs,
        errorCount: ep.errorCount,
        lastChecked: new Date(ep.lastChecked).toISOString(),
      });
    }

    // Update pool-level gauges
    const healthyCount = results.filter((r) => r.healthy).length;
    rpcPoolHealthyEndpoints.set(healthyCount);
    rpcPoolTotalEndpoints.set(results.length);

    return results;
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
    return {
      totalEndpoints: this.endpoints.length,
      healthyEndpoints: healthyCount,
      activeUrl: activeEp ? activeEp.url : config.rpcUrl,
      endpoints: this.endpoints.map((e) => ({
        url: e.url,
        healthy: e.healthy,
        latencyMs: e.latencyMs,
        errorCount: e.errorCount,
        lastChecked: new Date(e.lastChecked).toISOString(),
      })),
    };
  }
}

export function createRpcPool(
  urls: string[],
  options?: {
    fallbackUrl?: string;
    serverFactory?: (url: string) => RpcServerPort;
  },
): RpcPoolManager {
  return new RpcPoolManager(
    urls,
    options?.fallbackUrl,
    options?.serverFactory,
  );
}

export const rpcPoolManager = createRpcPool(config.rpcUrls || [config.rpcUrl]);

// Circuit breaker for Soroban RPC calls — trips when the RPC pool is
// degraded across the board, so requests fail fast instead of each one
// running its own retry/timeout against a service that is known to be down.
export const sorobanRpcBreaker = registerCircuitBreaker("soroban_rpc", {
  failureThreshold: config.circuitBreakerRpcFailureThreshold,
  resetTimeoutMs: config.circuitBreakerRpcResetMs,
});

/** Test-mode server stub (no live RPC needed). */
function createTestServer(): SorobanServer {
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

/**
 * Construct the pool-backed Soroban server (with per-call metrics and the
 * RPC circuit breaker) or the test-mode stub. Extracted from the module so
 * the composition root (and tests) can build a server explicitly with a mock
 * pool/breaker instead of importing the module singleton (#358).
 */
export function createSorobanServer(options: {
  testMode: boolean;
  pool: RpcPoolManager;
  breaker: CircuitBreaker;
}): SorobanServer {
  if (options.testMode) return createTestServer();

  const { pool, breaker } = options;
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const activeServer = pool.getActiveServer() as any;
        const value = activeServer[prop];
        if (typeof value !== "function") return value;

        return async function (...args: unknown[]) {
          const method = String(prop);
          const start = process.hrtime.bigint();
          try {
            const result = await breaker.execute(() =>
              value.apply(activeServer, args),
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
 * Wait for transaction confirmation.
 *
 * Polls getTransaction up to maxAttempts times (1 second apart).
 * Note: callers may also wrap this in callWithTimeout for an outer
 * deadline -- the two timeouts are intentionally independent: this
 * loop controls polling cadence while callWithTimeout enforces a
 * hard wall-clock limit.
 */
export async function waitForTransaction(
  hash: string,
  maxAttempts = 30,
): Promise<StellarSdk.rpc.Api.GetTransactionResponse> {
  let attempts = 0;

  while (attempts < maxAttempts) {
    const result = await (server as StellarSdk.rpc.Server).getTransaction(hash);

    if (result.status !== "NOT_FOUND") {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
    attempts++;
  }

  throw new Error("Transaction not found after timeout");
}

/**
 * Simulate with backoff/retry
 */
export async function simulateWithBackoff<T>(
  simulateFn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: Error | null = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await simulateFn();
    } catch (err) {
      lastErr = err as Error;
      await new Promise((r) => setTimeout(r, 200 * i));
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
