/**
 * Stellar/Soroban Service
 *
 * Provides Stellar SDK setup, helper functions, and transaction utilities
 * for interacting with Soroban smart contracts.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { type CircuitBreaker } from "./circuit-breaker.js";
import type { Groth16Proof } from "../types/index.js";
import type { RpcServerPort } from "./interfaces.js";
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
import { relayerKeyManager, LocalKeypairSigner, KmsSigner, HsmSigner, MockTestSigner, type StellarSigner, type RelayerKeypair } from "./relayerKeyManager.js";
export { relayerKeyManager, LocalKeypairSigner, KmsSigner, HsmSigner, MockTestSigner, type StellarSigner, type RelayerKeypair, };
/**
 * Construct the relayer keypair from config. Extracted from the module so the
 * composition root (and tests) can build keypairs explicitly instead of the
 * module grabbing config at import time (#358).
 */
export declare function createRelayerKeypair(relayerSecretKey: string | undefined, testMode: boolean): RelayerKeypair;
/**
 * Dynamic relayerKeypair proxy that delegates to the active key in relayerKeyManager.
 * Ensures zero-downtime hot swapping across all existing routes and callers.
 */
export declare const relayerKeypair: RelayerKeypair;
/**
 * Dynamic activeSigner proxy that delegates to the active signer in relayerKeyManager.
 */
export declare const activeSigner: StellarSigner;
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
    private consecutiveErrors;
    private lastRecoveryTime;
    private readonly MAX_CONSECUTIVE_ERRORS;
    private readonly RECOVERY_COOLDOWN_MS;
    constructor();
    private loadPersisted;
    private persist;
    markDirty(): void;
    forceResync(sorobanServer: StellarSdk.rpc.Server): Promise<void>;
    getAccount(sorobanServer: StellarSdk.rpc.Server): Promise<StellarSdk.Account>;
    handleTxError(errorResult: string): boolean;
    /**
     * Reset error counter and restore health status on successful transaction
     */
    markSuccess(): void;
    /**
     * Check if recovery should be rate limited
     */
    shouldRateLimitRecovery(): boolean;
    /**
     * Update last recovery timestamp
     */
    markRecoveryAttempt(): void;
    /**
     * Get current health status for monitoring
     */
    getHealthStatus(): {
        healthy: boolean;
        consecutiveErrors: number;
        lastKnownSequence: string | null;
        dirty: boolean;
    };
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
    private readonly fallbackUrl?;
    private readonly serverFactory;
    private endpoints;
    private currentIndex;
    constructor(urls: string[], fallbackUrl?: string | undefined, serverFactory?: (url: string) => RpcServerPort);
    getActiveServer(): RpcServerPort;
    checkHealth(): Promise<RpcEndpointStatus[]>;
    getMetrics(): {
        totalEndpoints: number;
        healthyEndpoints: number;
        activeUrl: string;
        endpoints: RpcEndpointStatus[];
    };
}
export declare function createRpcPool(urls: string[], options?: {
    fallbackUrl?: string;
    serverFactory?: (url: string) => RpcServerPort;
}): RpcPoolManager;
export declare const rpcPoolManager: RpcPoolManager;
/**
 * Submit a raw transaction XDR to all healthy RPC endpoints and return the
 * first non-error response. This provides a relay quorum — no single RPC
 * endpoint can censor a vote by silently dropping it.
 */
export declare function submitToRelayQuorum(tx: StellarSdk.Transaction): Promise<any>;
export declare const sorobanRpcBreaker: CircuitBreaker;
export declare function createSorobanServer(options: {
    testMode: boolean;
    pool: RpcPoolManager;
    breaker: CircuitBreaker;
}): SorobanServer;
export declare const server: SorobanServer;
/**
 * Call RPC with timeout.
 *
 * Every RPC hop opens a child span under whatever is ambient (#321) — an HTTP
 * request or an indexer poll cycle — so a single trace covers poll -> db -> rpc
 * without the caller passing a context. The span records only the operation
 * label and the deadline; request payloads stay out of telemetry because they
 * carry proofs and nullifiers.
 */
export declare function callWithTimeout<T>(fn: () => Promise<T>, label: string): Promise<T>;
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
export { waitForTransaction, getConfirmationStatus, getConfirmationQueueStats, startConfirmationWorker, stopConfirmationWorker, TransactionConfirmationTimeoutError, } from "./confirmation-queue.js";
export type { ConfirmationState, ConfirmationStatus, WaitForTransactionOptions, } from "./confirmation-queue.js";
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
 * Convert a Groth16 proof into the canonical hex form used for redundancy
 * checks. This mirrors proofToScVal's validation and A/B malleability
 * normalization, but returns plain bytes-as-hex so two independently supplied
 * proofs can be compared before any on-chain submission is attempted.
 */
export declare function canonicalProofFingerprint(proof: Groth16Proof): string;
/**
 * Convert Groth16 proof to ScVal
 */
export declare function proofToScVal(proof: Groth16Proof): StellarSdk.xdr.ScVal;
/**
 * Encodes one entry of the voting contract's `cast_votes` batch (#90).
 *
 * A `#[contracttype]` struct crosses the boundary as an `ScMap` whose keys are
 * the field symbols in sorted order — the host rejects a map that is not
 * sorted — so the entries below are ordered `nullifier`, `proof`, `root`,
 * `vote_choice` to match `BatchVote`, not the order the fields are declared in.
 */
export declare function batchVoteToScVal(vote: {
    choice: boolean;
    nullifier: string;
    root: string;
    proof: Groth16Proof;
}): StellarSdk.xdr.ScVal;
/**
 * Get relayer account from server
 */
export declare function getRelayerAccount(): Promise<StellarSdk.Account>;
/**
 * Build and sign a transaction
 */
export declare function buildTransaction(account: StellarSdk.Account, operation: StellarSdk.xdr.Operation): StellarSdk.Transaction;
/**
 * Sign a transaction with the active signer (Local, KMS, or HSM)
 */
export declare function signTransaction(tx: StellarSdk.Transaction): Promise<void>;
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
export declare function submitTransactionWithRecovery(preparedTx: StellarSdk.Transaction, operation: () => Promise<StellarSdk.Transaction>, maxRetries?: number, label?: string): Promise<TransactionSubmissionResult>;
//# sourceMappingURL=stellar.d.ts.map