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
export declare function withSequenceLock<T>(fn: () => Promise<T>): Promise<T>;
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