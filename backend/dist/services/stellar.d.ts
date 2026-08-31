/**
 * Stellar/Soroban Service
 *
 * Provides Stellar SDK setup, helper functions, and transaction utilities
 * for interacting with Soroban smart contracts.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import type { Groth16Proof } from "../types/index.js";
export interface TestServer {
    getHealth: () => Promise<{
        status: string;
    }>;
    simulateTransaction: () => Promise<never>;
    sendTransaction: () => Promise<{
        status: string;
        errorResult: string;
    }>;
    getTransaction: () => Promise<{
        status: string;
    }>;
    getAccount: () => Promise<{
        accountId: string;
        sequence: string;
    }>;
    getLatestLedger?: () => Promise<{
        sequence: number;
    }>;
}
export type SorobanServer = StellarSdk.rpc.Server | TestServer;
export declare const relayerKeypair: StellarSdk.Keypair | {
    publicKey: () => string;
};
export declare function getPendingSequenceLockOps(): number;
/**
 * Wait until all in-flight withSequenceLock operations drain, or until
 * timeoutMs elapses. Resolves true if drained cleanly, false on timeout
 * with work still outstanding.
 */
export declare function waitForSequenceLockIdle(timeoutMs: number): Promise<boolean>;
/**
 * Manages the relayer account's sequence number with dirty-flag recovery.
 *
 * When an RPC error leaves the local sequence unknown, `markDirty()` forces a
 * fresh `getAccount` call before the next submission instead of building on a
 * potentially stale number. The last known sequence is persisted to the SQLite
 * metadata table so a process crash doesn't lose it.
 */
export declare class SequenceManager {
    private dirty;
    private lastKnownSequence;
    constructor();
    private loadPersisted;
    private persist;
    markDirty(): void;
    forceResync(sorobanServer: StellarSdk.rpc.Server): Promise<void>;
    getAccount(sorobanServer: StellarSdk.rpc.Server): Promise<StellarSdk.Account>;
    handleTxError(errorResult: string): boolean;
}
export declare const sequenceManager: SequenceManager;
export declare function withSequenceLock<T>(fn: () => Promise<T>): Promise<T>;
export interface RpcEndpointStatus {
    url: string;
    healthy: boolean;
    latencyMs: number;
    errorCount: number;
    lastChecked: string;
}
export declare class RpcPoolManager {
    private endpoints;
    private currentIndex;
    constructor(urls: string[]);
    getActiveServer(): StellarSdk.rpc.Server;
    checkHealth(): Promise<RpcEndpointStatus[]>;
    getMetrics(): {
        totalEndpoints: number;
        healthyEndpoints: number;
        activeUrl: string;
        endpoints: RpcEndpointStatus[];
    };
}
export declare const rpcPoolManager: RpcPoolManager;
export declare const sorobanRpcBreaker: import("./circuit-breaker.js").CircuitBreaker;
export declare const server: SorobanServer;
/**
 * Call RPC with timeout
 */
export declare function callWithTimeout<T>(fn: () => Promise<T>, label: string): Promise<T>;
/**
 * Wait for transaction confirmation.
 *
 * Polls getTransaction up to maxAttempts times (1 second apart).
 * Note: callers may also wrap this in callWithTimeout for an outer
 * deadline -- the two timeouts are intentionally independent: this
 * loop controls polling cadence while callWithTimeout enforces a
 * hard wall-clock limit.
 */
export declare function waitForTransaction(hash: string, maxAttempts?: number): Promise<StellarSdk.rpc.Api.GetTransactionResponse>;
/**
 * Simulate with backoff/retry
 */
export declare function simulateWithBackoff<T>(simulateFn: () => Promise<T>, attempts?: number): Promise<T>;
/**
 * Check if byte array is all zeros (point at infinity)
 *
 * For BN254 (CAP-74 / EIP-196/197):
 * - G1 point at infinity: 64 zero bytes
 * - G2 point at infinity: 128 zero bytes
 *
 * In valid Groth16 proofs, A, B, C must not be point at infinity.
 */
export declare function isAllZeros(bytes: Buffer): boolean;
/**
 * Convert U256 hex string to ScVal
 */
export declare function u256ToScVal(hexString: string): StellarSdk.xdr.ScVal;
/**
 * Convert ScVal U256 to hex string
 */
export declare function scValToU256Hex(scVal: StellarSdk.xdr.ScVal): string;
/**
 * Convert hex string to byte array
 */
export declare function hexToBytes(hex: string, expectedLength: number): Buffer;
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
export declare function canonicalizeProof(aBytes: Buffer, bBytes: Buffer): {
    a: Buffer;
    b: Buffer;
};
/**
 * Convert Groth16 proof to ScVal
 */
export declare function proofToScVal(proof: Groth16Proof): StellarSdk.xdr.ScVal;
/**
 * Get relayer account from server
 */
export declare function getRelayerAccount(): Promise<StellarSdk.Account>;
/**
 * Build and sign a transaction
 */
export declare function buildTransaction(account: StellarSdk.Account, operation: StellarSdk.xdr.Operation): StellarSdk.Transaction;
/**
 * Sign a transaction with the relayer keypair
 */
export declare function signTransaction(tx: StellarSdk.Transaction): void;
//# sourceMappingURL=stellar.d.ts.map