/**
 * Bridge Relay Service
 *
 * Watches EVM bridge contract for VoteForwarded events and
 * relays votes to the Soroban bridge contract.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import type { LoggerPort, RpcServerPort } from "./interfaces.js";
/**
 * Dependencies injected via `initBridgeRelay` (#358) so this module never
 * imports the `stellar.js`/`config.js`/`logger.js` module singletons directly.
 */
export interface BridgeDeps {
    /** Active RPC server (pool-backed proxy in production). */
    server: RpcServerPort;
    /** Relayer keypair used to sign relay transactions. */
    relayerKeypair: {
        publicKey(): string;
    } & Partial<StellarSdk.Keypair>;
    /** Config: relayer test mode (relay short-circuits as failed). */
    testMode: boolean;
    /** Config: Soroban bridge contract id (C...). */
    bridgeContractId?: string;
    /** Config: Stellar network passphrase. */
    networkPassphrase: string;
    /** Run `fn` with a timeout, labelled for logs/metrics. */
    callWithTimeout<T>(fn: () => Promise<T>, label: string): Promise<T>;
    /** Serialize transaction submissions against the relayer account. */
    withSequenceLock<T>(fn: () => Promise<T>): Promise<T>;
    /** Simulate a transaction with retry/backoff. */
    simulateWithBackoff<T>(fn: () => Promise<T>, attempts?: number): Promise<T>;
    /** Wait for an on-chain transaction to settle. */
    waitForTransaction(hash: string, timeoutSeconds?: number): Promise<{
        status: string;
    }>;
    /** Convert a U256 hex string into an ScVal argument. */
    u256ToScVal(hexString: string): StellarSdk.xdr.ScVal;
    /** Structured logger (called as `deps.log(level, event, meta)`). */
    log: LoggerPort["log"];
}
/** Explicitly wire the bridge relay service (composition root only). */
export declare function initBridgeRelay(d: BridgeDeps): void;
export interface EVMVoteEvent {
    daoId: number;
    proposalId: number;
    nullifier: string;
    voteChoice: number;
    voteRoot: string;
    txHash: string;
    blockNumber: number;
}
export interface RelayResult {
    success: boolean;
    stellarTxHash?: string;
    error?: string;
}
/**
 * Poll EVM bridge contract for VoteForwarded events
 * In production, use WebSocket or event subscription
 * For now, poll via RPC
 */
export declare function pollEVMEvents(): Promise<EVMVoteEvent[]>;
/**
 * Relay a single vote from EVM to Soroban
 */
export declare function relayVote(event: EVMVoteEvent): Promise<RelayResult>;
/**
 * Start the relay service
 */
export declare function startRelay(intervalMs?: number): void;
/**
 * Stop the relay service
 */
export declare function stopRelay(): void;
//# sourceMappingURL=bridge.d.ts.map