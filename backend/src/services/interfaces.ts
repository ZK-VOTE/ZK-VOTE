/**
 * Dependency-surface interfaces for the ZKVote backend (#358).
 *
 * Services should depend on these ports — never on concrete global module
 * instances. The composition root (`src/composition-root.ts`) is the single
 * place that constructs the concrete implementations and wires them into the
 * services at startup.
 *
 * These types are *structural*: any mock or real implementation with the same
 * shape satisfies them, which is what makes the refactored services unit-
 * testable with mocks.
 */

import type * as StellarSdk from "@stellar/stellar-sdk";
import type { Logger } from "./logger.js";

// ===========================================================================
// RPC / Stellar surface
// ===========================================================================

/**
 * Minimal Soroban RPC client surface (the subset the backend uses of
 * `@stellar/stellar-sdk`'s `rpc.Server`, plus the test-mode stub shape).
 * Declared structurally so a mock `simulateTransaction`/`getAccount`/... can
 * be injected in unit tests without a live RPC endpoint.
 */
export interface RpcServerPort {
  getHealth(): Promise<{ status: string }>;
  simulateTransaction(...args: unknown[]): Promise<unknown>;
  sendTransaction(...args: unknown[]): Promise<{ status: string; hash?: string }>;
  getTransaction(...args: unknown[]): Promise<{ status: string }>;
  getAccount(...args: unknown[]): Promise<unknown>;
  getLatestLedger?(): Promise<{ sequence: number }>;
}

/** Per-endpoint health/status info as reported by the RPC pool. */
export interface RpcEndpointStatus {
  url: string;
  healthy: boolean;
  latencyMs: number;
  errorCount: number;
  lastChecked: string;
}

/** RPC connection-pool surface. */
export interface RpcPoolPort {
  getActiveServer(): RpcServerPort;
  checkHealth(): Promise<RpcEndpointStatus[]>;
  getMetrics(): {
    totalEndpoints: number;
    healthyEndpoints: number;
    activeUrl: string;
    endpoints: RpcEndpointStatus[];
  };
}

/**
 * The aggregate Stellar/Soroban surface that consumer services (bridge,
 * circuit-registry, ttl, claim route, ...) depend on. Provided as a single
 * injected object by the composition root so services never import the
 * `stellar.js` module singleton directly.
 */
export interface StellarContext {
  /** Active RPC server (pool-backed proxy in production, stub in test mode). */
  server: RpcServerPort;
  /** Relayer keypair used to sign transactions. */
  relayerKeypair: { publicKey(): string } & Partial<StellarSdk.Keypair>;
  /** Run `fn` with a timeout, labelled for logs/metrics. */
  callWithTimeout<T>(fn: () => Promise<T>, label: string): Promise<T>;
  /** Simulate an RPC call with retry/backoff. */
  simulateWithBackoff<T>(fn: () => Promise<T>): Promise<T>;
  /** Wait for an on-chain transaction to settle. */
  waitForTransaction(hash: string): Promise<{ status: string }>;
  /** Serialize transaction submissions against the relayer account. */
  withSequenceLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Wait until all in-flight sequence-lock ops drain, or `timeoutMs` elapses. */
  waitForSequenceLockIdle(timeoutMs: number): Promise<boolean>;
  /** Encode a u256 hex string as an ScVal. */
  u256ToScVal(hexString: string): StellarSdk.xdr.ScVal;
  /** Encode a Groth16 proof as an ScVal. */
  proofToScVal(proof: unknown): StellarSdk.xdr.ScVal;
  /** Count of in-flight sequence-lock operations (for shutdown draining). */
  getPendingSequenceLockOps(): number;
}

// ===========================================================================
// DB surface
// ===========================================================================

/**
 * The database access surface the backend services consume. This is a subset
 * of `db.ts`'s exported functions; extend it as more services are migrated.
 */
export interface DbPort {
  /** Read a string from the key/value metadata store (or null). */
  getMetadata(key: string): Promise<string | null>;
  /** Write a string to the key/value metadata store. */
  setMetadata(key: string, value: string): Promise<void>;
}

// ===========================================================================
// Logger / metrics surface
// ===========================================================================

/** Logger port — structurally satisfied by `createLogger()` instances. */
export type LoggerPort = Logger;

/**
 * Optional Prometheus metrics sink. Services that emit metrics should accept
 * a sink (or individual metric callbacks) so they remain testable without
 * prom-client registered. Mirrors the existing `DbMetricsSink` convention.
 */
export interface MetricsSink {
  [key: string]: (...args: unknown[]) => void;
}
