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
import { rpcCallsTotal, rpcCallDuration, rpcErrors, rpcPoolHealthyEndpoints, rpcPoolTotalEndpoints, rpcEndpointLatency, } from "./metrics.js";
import { registerCircuitBreaker, CircuitBreakerOpenError, } from "./circuit-breaker.js";
import { BN254_FQ_MODULUS } from "../types/index.js";
import nodeCluster from "node:cluster";
import { acquireClusterSequenceLock, releaseClusterSequenceLock, } from "./cluster.js";
// ============================================
// RELAYER KEYPAIR
// ============================================
let _relayerKeypair;
try {
    if (config.testMode) {
        _relayerKeypair = {
            publicKey: () => "GTESTRELAYERADDRESS000000000000000000000000000000000000",
        };
        logger.info("relayer_loaded", {
            relayer: _relayerKeypair.publicKey(),
            testMode: true,
        });
    }
    else {
        if (!config.relayerSecretKey) {
            throw new Error("RELAYER_SECRET_KEY is not set");
        }
        _relayerKeypair = StellarSdk.Keypair.fromSecret(config.relayerSecretKey);
        logger.info("relayer_loaded", { relayer: _relayerKeypair.publicKey() });
    }
}
catch (err) {
    log("error", "invalid_relayer_key", { message: err.message });
    console.error("Run ./scripts/init-local.sh to generate a secure key");
    process.exit(1);
}
export const relayerKeypair = _relayerKeypair;
// ============================================
// SEQUENCE LOCK (TRANSACTION NONCE MUTEX)
// ============================================
/**
 * Promise-based mutex to serialize transaction submissions.
 * Prevents nonce race conditions when multiple requests try to
 * build+submit transactions concurrently using the same relayer account.
 * Uses IPC distributed sequence lock when running in cluster mode.
 */
let sequenceLock = Promise.resolve();
// Count of sequence-lock operations currently queued or executing. A vote
// submission holds the lock across build+simulate+send+confirm, which can
// outlive its HTTP response, so shutdown must wait on this, not just on
// httpServer.close().
let inFlightLockOps = 0;
export function getPendingSequenceLockOps() {
    return inFlightLockOps;
}
/**
 * Wait until all in-flight withSequenceLock operations drain, or until
 * timeoutMs elapses. Resolves true if drained cleanly, false on timeout
 * with work still outstanding.
 */
export async function waitForSequenceLockIdle(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (inFlightLockOps > 0) {
        if (Date.now() >= deadline)
            return false;
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
    dirty = false;
    lastKnownSequence = null;
    constructor() {
        const persisted = this.loadPersisted();
        if (persisted) {
            this.lastKnownSequence = persisted;
        }
    }
    loadPersisted() {
        try {
            return getMetadata("relayer_last_sequence");
        }
        catch {
            return null;
        }
    }
    persist(seq) {
        try {
            setMetadata("relayer_last_sequence", seq);
        }
        catch {
            // Non-fatal: SQLite may be unavailable during tests
        }
    }
    markDirty() {
        this.dirty = true;
    }
    async forceResync(sorobanServer) {
        const account = await sorobanServer.getAccount(relayerKeypair.publicKey());
        const seq = account.sequence ??
            String(account.sequenceNumber?.());
        this.lastKnownSequence = seq;
        this.dirty = false;
        this.persist(seq);
        log("info", "sequence_resync", { sequence: seq });
    }
    async getAccount(sorobanServer) {
        if (this.dirty || this.lastKnownSequence === null) {
            const account = await sorobanServer.getAccount(relayerKeypair.publicKey());
            const seq = account.sequence ??
                String(account.sequenceNumber?.());
            this.lastKnownSequence = seq;
            this.dirty = false;
            this.persist(seq);
            return account;
        }
        return sorobanServer.getAccount(relayerKeypair.publicKey());
    }
    handleTxError(errorResult) {
        if (errorResult && errorResult.includes("tx_bad_seq")) {
            this.markDirty();
            return true;
        }
        return false;
    }
}
export const sequenceManager = new SequenceManager();
export async function withSequenceLock(fn) {
    if (config.clusterEnabled && nodeCluster.isWorker) {
        await acquireClusterSequenceLock();
        try {
            return await fn();
        }
        finally {
            await releaseClusterSequenceLock();
        }
    }
    const previous = sequenceLock;
    let resolve;
    sequenceLock = new Promise((r) => {
        resolve = r;
    });
    inFlightLockOps++;
    await previous;
    try {
        return await fn();
    }
    finally {
        resolve();
        inFlightLockOps--;
    }
}
export class RpcPoolManager {
    endpoints = [];
    currentIndex = 0;
    constructor(urls) {
        const uniqueUrls = Array.from(new Set(urls.length > 0 ? urls : [config.rpcUrl]));
        this.endpoints = uniqueUrls.map((url) => ({
            url,
            server: new StellarSdk.rpc.Server(url, { allowHttp: true }),
            healthy: true,
            latencyMs: 0,
            errorCount: 0,
            lastChecked: Date.now(),
        }));
    }
    getActiveServer() {
        if (this.endpoints.length === 0) {
            return new StellarSdk.rpc.Server(config.rpcUrl, { allowHttp: true });
        }
        for (let i = 0; i < this.endpoints.length; i++) {
            const idx = (this.currentIndex + i) % this.endpoints.length;
            if (this.endpoints[idx].healthy) {
                this.currentIndex = (idx + 1) % this.endpoints.length;
                return this.endpoints[idx].server;
            }
        }
        const fallback = this.endpoints[this.currentIndex % this.endpoints.length].server;
        this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
        return fallback;
    }
    async checkHealth() {
        const results = [];
        for (const ep of this.endpoints) {
            const start = Date.now();
            try {
                const res = await ep.server.getHealth();
                ep.latencyMs = Date.now() - start;
                ep.healthy = res.status === "healthy" || res.status === "online";
                if (ep.healthy)
                    ep.errorCount = 0;
                else
                    ep.errorCount++;
            }
            catch {
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
    getMetrics() {
        const healthyCount = this.endpoints.filter((e) => e.healthy).length;
        const activeEp = this.endpoints[this.currentIndex % this.endpoints.length] ||
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
export const rpcPoolManager = new RpcPoolManager(config.rpcUrls || [config.rpcUrl]);
// Circuit breaker for Soroban RPC calls — trips when the RPC pool is
// degraded across the board, so requests fail fast instead of each one
// running its own retry/timeout against a service that is known to be down.
export const sorobanRpcBreaker = registerCircuitBreaker("soroban_rpc", {
    failureThreshold: config.circuitBreakerRpcFailureThreshold,
    resetTimeoutMs: config.circuitBreakerRpcResetMs,
});
export const server = config.testMode
    ? {
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
    }
    : new Proxy({}, {
        get(_target, prop) {
            const activeServer = rpcPoolManager.getActiveServer();
            const value = activeServer[prop];
            if (typeof value !== "function")
                return value;
            return async function (...args) {
                const method = String(prop);
                const start = process.hrtime.bigint();
                try {
                    const result = await sorobanRpcBreaker.execute(() => value.apply(activeServer, args));
                    const duration = Number(process.hrtime.bigint() - start) / 1e9;
                    rpcCallsTotal.inc({ method, status: "success" });
                    rpcCallDuration.observe({ method, status: "success" }, duration);
                    return result;
                }
                catch (err) {
                    const duration = Number(process.hrtime.bigint() - start) / 1e9;
                    const errorType = err instanceof CircuitBreakerOpenError
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
    });
// ============================================
// HELPER FUNCTIONS
// ============================================
/**
 * Call RPC with timeout
 */
export async function callWithTimeout(fn, label) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Timeout: ${label} (${config.rpcTimeoutMs}ms)`)), config.rpcTimeoutMs);
    });
    try {
        return await Promise.race([fn(), timeout]);
    }
    finally {
        if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
        }
    }
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
export async function waitForTransaction(hash, maxAttempts = 30) {
    let attempts = 0;
    while (attempts < maxAttempts) {
        const result = await server.getTransaction(hash);
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
export async function simulateWithBackoff(simulateFn, attempts = 3) {
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
        try {
            return await simulateFn();
        }
        catch (err) {
            lastErr = err;
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
export function isAllZeros(bytes) {
    return bytes.every((byte) => byte === 0);
}
/**
 * Convert U256 hex string to ScVal
 */
export function u256ToScVal(hexString) {
    const hex = hexString.startsWith("0x") ? hexString.slice(2) : hexString;
    if (!/^[0-9a-fA-F]*$/.test(hex)) {
        throw new Error("Invalid U256 hex string: contains non-hexadecimal characters");
    }
    if (hex.length % 2 !== 0 && hex.length > 0) {
        throw new Error(`Invalid U256 hex string: odd length (${hex.length})`);
    }
    if (hex.length > 64) {
        throw new Error(`Invalid U256 hex string: too long (${hex.length} chars, max 64)`);
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
    return StellarSdk.xdr.ScVal.scvU256(new StellarSdk.xdr.UInt256Parts({
        hiHi: new StellarSdk.xdr.Uint64(hiHi),
        hiLo: new StellarSdk.xdr.Uint64(hiLo),
        loHi: new StellarSdk.xdr.Uint64(loHi),
        loLo: new StellarSdk.xdr.Uint64(loLo),
    }));
}
/**
 * Convert ScVal U256 to hex string
 */
export function scValToU256Hex(scVal) {
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
export function hexToBytes(hex, expectedLength) {
    const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (!/^[0-9a-fA-F]*$/.test(cleanHex)) {
        throw new Error("Invalid hex string: contains non-hexadecimal characters");
    }
    if (cleanHex.length % 2 !== 0 && cleanHex.length > 0) {
        throw new Error(`Invalid hex string: odd length (${cleanHex.length})`);
    }
    if (cleanHex.length > expectedLength * 2) {
        throw new Error(`Hex string too long: ${cleanHex.length} chars, max ${expectedLength * 2}`);
    }
    const padded = cleanHex.padStart(expectedLength * 2, "0");
    const bytes = Buffer.from(padded, "hex");
    if (bytes.length !== expectedLength) {
        throw new Error(`Expected ${expectedLength} bytes, got ${bytes.length}`);
    }
    return bytes;
}
function bytesToBigInt(buf) {
    return BigInt("0x" + buf.toString("hex"));
}
function bigIntToBytes(n, length) {
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
export function canonicalizeProof(aBytes, bBytes) {
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
export function proofToScVal(proof) {
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
        throw new Error("Invalid proof: proof components cannot be point at infinity (all zeros)");
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
export async function getRelayerAccount() {
    return server.getAccount(relayerKeypair.publicKey());
}
/**
 * Build and sign a transaction
 */
export function buildTransaction(account, operation) {
    return new StellarSdk.TransactionBuilder(account, {
        fee: "100000",
        networkPassphrase: config.networkPassphrase,
    })
        .addOperation(operation)
        .setTimeout(30)
        .build();
}
/**
 * Sign a transaction with the relayer keypair
 */
export function signTransaction(tx) {
    tx.sign(relayerKeypair);
}
//# sourceMappingURL=stellar.js.map