/**
 * Bridge Relay Service
 *
 * Watches EVM bridge contract for VoteForwarded events and
 * relays votes to the Soroban bridge contract.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import type { LoggerPort, RpcServerPort } from "./interfaces.js";

//__BRIDGE_DEPS_START__
/**
 * Dependencies injected via `initBridgeRelay` (#358) so this module never
 * imports the `stellar.js`/`config.js`/`logger.js` module singletons directly.
 */
export interface BridgeDeps {
  /** Active RPC server (pool-backed proxy in production). */
  server: RpcServerPort;
  /** Relayer keypair used to sign relay transactions. */
  relayerKeypair: { publicKey(): string } & Partial<StellarSdk.Keypair>;
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
  waitForTransaction(
    hash: string,
    timeoutSeconds?: number,
  ): Promise<{ status: string }>;
  /** Convert a U256 hex string into an ScVal argument. */
  u256ToScVal(hexString: string): StellarSdk.xdr.ScVal;
  /** Structured logger (called as `deps.log(level, event, meta)`). */
  log: LoggerPort["log"];
}

let bridgeDeps: BridgeDeps | null = null;

/** Explicitly wire the bridge relay service (composition root only). */
export function initBridgeRelay(d: BridgeDeps): void {
  bridgeDeps = d;
}

function deps(): BridgeDeps {
  if (!bridgeDeps) {
    throw new Error("bridge: initBridgeRelay() must be called before use");
  }
  return bridgeDeps;
}
//__BRIDGE_DEPS_END__

// ============================================
// TYPES
// ============================================

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

// ============================================
// RELAY STATE
// ============================================

let relayRunning = false;
let relayInterval: ReturnType<typeof setInterval> | null = null;
let lastProcessedBlock = 0;

// ============================================
// EVM EVENT POLLING
// ============================================

/**
 * Poll EVM bridge contract for VoteForwarded events
 * In production, use WebSocket or event subscription
 * For now, poll via RPC
 */
export async function pollEVMEvents(): Promise<EVMVoteEvent[]> {
  // In production, this would:
  // 1. Connect to Ethereum node via ethers.js
  // 2. Query Bridge contract events since last processed block
  // 3. Parse VoteForwarded events
  //
  // For now, return empty array (placeholder)
  deps().log("info", "evm_poll", { lastBlock: lastProcessedBlock });
  return [];
}

/**
 * Relay a single vote from EVM to Soroban
 */
export async function relayVote(event: EVMVoteEvent): Promise<RelayResult> {
  try {
    deps().log("info", "relay_vote_start", {
      daoId: event.daoId,
      proposalId: event.proposalId,
      nullifier: event.nullifier,
    });

    // Convert inputs to Soroban types
    const scNullifier = deps().u256ToScVal(event.nullifier);
    const scVoteRoot = deps().u256ToScVal(event.voteRoot);

    if (deps().testMode) {
      return { success: false, error: "Simulation failed (test mode)" };
    }

    // Build contract call to Soroban bridge
    const contract = new StellarSdk.Contract(deps().bridgeContractId!);

    const args = [
      StellarSdk.nativeToScVal(event.daoId, { type: "u64" }),
      StellarSdk.nativeToScVal(event.proposalId, { type: "u64" }),
      StellarSdk.nativeToScVal(event.voteChoice === 1, { type: "bool" }),
      scNullifier,
      scVoteRoot,
    ];

    const operation = contract.call("relay_vote", ...args);

    // Submit under sequence lock
    const { sendResult } = await deps().withSequenceLock(async () => {
      const account = await (deps().server as StellarSdk.rpc.Server).getAccount(
        deps().relayerKeypair.publicKey(),
      );

      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: "100000",
        networkPassphrase: deps().networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      // Simulate
      const simResult = await deps().callWithTimeout(
        () =>
          deps().simulateWithBackoff(() =>
            (deps().server as StellarSdk.rpc.Server).simulateTransaction(tx),
          ),
        "simulate_relay",
      );

      if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
        throw new Error(`SIMULATION_FAILED:${simResult.error}`);
      }

      // Prepare and sign
      const preparedTx = StellarSdk.rpc
        .assembleTransaction(tx, simResult)
        .build();
      preparedTx.sign(deps().relayerKeypair as StellarSdk.Keypair);

      // Submit
      const sr = await deps().callWithTimeout(
        () => (deps().server as StellarSdk.rpc.Server).sendTransaction(preparedTx),
        "send_relay",
      );

      if (sr.status === "ERROR") {
        throw new Error("SUBMIT_FAILED");
      }

      // Wait for confirmation
      const r = await deps().callWithTimeout(
        () => deps().waitForTransaction(sr.hash),
        "wait_relay",
      );

      return { sendResult: sr, result: r };
    });

    deps().log("info", "relay_vote_success", {
      stellarTxHash: sendResult.hash,
      daoId: event.daoId,
      proposalId: event.proposalId,
    });

    return { success: true, stellarTxHash: sendResult.hash };
  } catch (err) {
    const errMsg = (err as Error).message || "";
    deps().log("error", "relay_vote_failed", {
      daoId: event.daoId,
      proposalId: event.proposalId,
      error: errMsg,
    });

    let userMessage = "Relay failed";
    if (errMsg.startsWith("SIMULATION_FAILED:")) {
      userMessage = errMsg.slice("SIMULATION_FAILED:".length);
    } else if (errMsg === "SUBMIT_FAILED") {
      userMessage = "Transaction submission failed";
    }

    return { success: false, error: userMessage };
  }
}

// ============================================
// RELAY LOOP
// ============================================

/**
 * Process a batch of EVM events
 */
async function processEvents(): Promise<void> {
  if (relayRunning) return;
  relayRunning = true;

  try {
    const events = await pollEVMEvents();

    for (const event of events) {
      const result = await relayVote(event);
      if (!result.success) {
        deps().log("warn", "relay_event_failed", {
          txHash: event.txHash,
          error: result.error,
        });
      }
      lastProcessedBlock = Math.max(lastProcessedBlock, event.blockNumber);
    }
  } catch (err) {
    deps().log("error", "relay_loop_error", { error: (err as Error).message });
  } finally {
    relayRunning = false;
  }
}

/**
 * Start the relay service
 */
export function startRelay(intervalMs: number = 10000): void {
  if (relayInterval) return;

  deps().log("info", "relay_started", { intervalMs });
  relayInterval = setInterval(processEvents, intervalMs);

  // Process immediately
  processEvents();
}

/**
 * Stop the relay service
 */
export function stopRelay(): void {
  if (relayInterval) {
    clearInterval(relayInterval);
    relayInterval = null;
    deps().log("info", "relay_stopped");
  }
}
