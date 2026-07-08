/**
 * Stellar/Soroban Service
 *
 * Provides Stellar SDK setup, helper functions, and transaction utilities
 * for interacting with Soroban smart contracts.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { config, BN254_SCALAR_FIELD } from "../config.js";
import { log, logger } from "./logger.js";
import type { Groth16Proof } from "../types/index.js";

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

// ============================================
// RELAYER KEYPAIR
// ============================================

let _relayerKeypair: StellarSdk.Keypair | { publicKey: () => string };

try {
  if (config.testMode) {
    _relayerKeypair = {
      publicKey: () =>
        "GTESTRELAYERADDRESS000000000000000000000000000000000000",
    };
    logger.info("relayer_loaded", {
      relayer: _relayerKeypair.publicKey(),
      testMode: true,
    });
  } else {
    if (!config.relayerSecretKey) {
      throw new Error("RELAYER_SECRET_KEY is not set");
    }
    _relayerKeypair = StellarSdk.Keypair.fromSecret(config.relayerSecretKey);
    logger.info("relayer_loaded", { relayer: _relayerKeypair.publicKey() });
  }
} catch (err) {
  log("error", "invalid_relayer_key", { message: (err as Error).message });
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
 */
let sequenceLock: Promise<void> = Promise.resolve();

export async function withSequenceLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = sequenceLock;
  let resolve: () => void;
  sequenceLock = new Promise<void>((r) => {
    resolve = r;
  });
  await previous;
  try {
    return await fn();
  } finally {
    resolve!();
  }
}

// ============================================
// SOROBAN RPC CLIENT
// ============================================

export const server: SorobanServer = config.testMode
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
  : new StellarSdk.rpc.Server(config.rpcUrl, { allowHttp: true });

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Call RPC with timeout
 */
export async function callWithTimeout<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Timeout: ${label} (${config.rpcTimeoutMs}ms)`)),
      config.rpcTimeoutMs,
    ),
  );
  return Promise.race([fn(), timeout]);
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

  const aBytes = hexToBytes(proof.a, 64);
  const bBytes = hexToBytes(proof.b, 128);
  const cBytes = hexToBytes(proof.c, 64);

  // Reject point at infinity for any proof component (invalid Groth16 proof)
  if (isAllZeros(aBytes) || isAllZeros(bBytes) || isAllZeros(cBytes)) {
    throw new Error(
      "Invalid proof: proof components cannot be point at infinity (all zeros)",
    );
  }

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
 * Sign a transaction with the relayer keypair
 */
export function signTransaction(tx: StellarSdk.Transaction): void {
  tx.sign(relayerKeypair as StellarSdk.Keypair);
}
