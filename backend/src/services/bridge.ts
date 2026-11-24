/**
 * Bridge Relay Service
 *
 * Watches EVM bridge contract for VoteForwarded events and
 * relays votes to the Soroban bridge contract.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import type { LoggerPort, RpcServerPort } from "./interfaces.js";
import {
  BridgeRelayStore,
  VOTE_FORWARDED_TOPIC,
  decodeVoteForwardedLog,
  runRelayCycle,
  type EvmRpc,
  type RelayCycleResult,
  type RelayRecord,
} from "./bridge-evm.js";

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
  /**
   * EVM side (#887): Bridge.sol's JSON-RPC endpoint and address. Without it
   * the relay loop has nothing to watch and does not run.
   */
  evm?: {
    rpc: EvmRpc;
    contractAddress: string;
    confirmations: number;
    startBlock: number;
    maxBlockRange: number;
    maxAttempts: number;
    store?: BridgeRelayStore;
  };
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
  /** u64 on Soroban; decimal string when it comes from an EVM uint256. */
  daoId: number | string;
  proposalId: number | string;
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
let defaultStore: BridgeRelayStore | null = null;

function relayStore(): BridgeRelayStore {
  return deps().evm?.store ?? (defaultStore ??= new BridgeRelayStore());
}

// ============================================
// EVM EVENT POLLING
// ============================================

/**
 * Reads the finalized VoteForwarded events after the relayer's checkpoint,
 * without advancing it (the relay cycle owns the checkpoint). Returns an
 * empty list when the EVM side is not configured.
 */
export async function pollEVMEvents(): Promise<EVMVoteEvent[]> {
  const evm = deps().evm;
  if (!evm) return [];
  const head = await evm.rpc.blockNumber();
  const finalized = head - evm.confirmations;
  const checkpoint = relayStore().getCheckpoint(evm.contractAddress);
  const from = checkpoint ? checkpoint.blockNumber + 1 : evm.startBlock;
  if (from > finalized) return [];
  const logs = await evm.rpc.getLogs({
    address: evm.contractAddress,
    fromBlock: from,
    toBlock: Math.min(finalized, from + evm.maxBlockRange - 1),
    topics: [VOTE_FORWARDED_TOPIC],
  });
  const events: EVMVoteEvent[] = [];
  for (const log of logs) {
    if (log.removed) continue;
    try {
      const vote = decodeVoteForwardedLog(log);
      events.push({
        daoId: vote.daoId,
        proposalId: vote.proposalId,
        nullifier: vote.nullifier,
        voteChoice: vote.voteChoice,
        voteRoot: vote.voteRoot,
        txHash: vote.txHash,
        blockNumber: vote.blockNumber,
      });
    } catch {
      /* not a well-formed VoteForwarded log; the relay cycle logs these */
    }
  }
  return events;
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
      StellarSdk.nativeToScVal(BigInt(event.daoId), { type: "u64" }),
      StellarSdk.nativeToScVal(BigInt(event.proposalId), { type: "u64" }),
      StellarSdk.nativeToScVal(event.voteChoice === 1, { type: "bool" }),
      scNullifier,
      scVoteRoot,
      StellarSdk.Address.fromString(deps().relayerKeypair.publicKey()).toScVal(),
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

const toEvent = (vote: RelayRecord): EVMVoteEvent => ({
  daoId: vote.daoId,
  proposalId: vote.proposalId,
  nullifier: vote.nullifier,
  voteChoice: vote.voteChoice,
  voteRoot: vote.voteRoot,
  txHash: vote.evmTxHash,
  blockNumber: vote.blockNumber,
});

/**
 * One relay pass (#887): reorg check, scan of finalized blocks, then a
 * Soroban `relay_vote` per pending vote, with status tracked per vote.
 * Returns null when the EVM side is not configured or a pass is running.
 */
export async function processEvents(): Promise<RelayCycleResult | null> {
  const evm = deps().evm;
  if (!evm || relayRunning) return null;
  relayRunning = true;

  try {
    const result = await runRelayCycle({
      rpc: evm.rpc,
      store: relayStore(),
      contract: evm.contractAddress,
      confirmations: evm.confirmations,
      startBlock: evm.startBlock,
      maxBlockRange: evm.maxBlockRange,
      maxAttempts: evm.maxAttempts,
      relay: (vote) => relayVote(toEvent(vote)),
      log: (level, event, meta) => deps().log(level, event, meta),
    });
    if (result.observed || result.relayed || result.failed || result.reorg) {
      deps().log("info", "relay_cycle", { ...result });
    }
    return result;
  } catch (err) {
    deps().log("error", "relay_loop_error", { error: (err as Error).message });
    return null;
  } finally {
    relayRunning = false;
  }
}

/** Relay state for the status route. */
export function getRelayStatus() {
  const evm = deps().evm;
  if (!evm) return { configured: false as const };
  return {
    configured: true as const,
    contractAddress: evm.contractAddress,
    confirmations: evm.confirmations,
    checkpoint: relayStore().getCheckpoint(evm.contractAddress),
    votes: relayStore().counts(),
  };
}

/** Status of one forwarded vote, or null when the relayer has not seen it. */
export function getRelayedVote(daoId: string, proposalId: string, nullifier: string) {
  return relayStore().get(daoId, proposalId, nullifier);
}

/**
 * Start the relay service
 */
export function startRelay(intervalMs: number = 10000): void {
  if (relayInterval || !deps().evm) return;

  deps().log("info", "relay_started", { intervalMs });
  relayInterval = setInterval(() => void processEvents(), intervalMs);

  // Process immediately
  void processEvents();
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
