/**
 * Membership SBT transfer-attempt detection + alerts (#357)
 *
 * The membership-sbt contract is soulbound: `transfer`, `transfer_from`, and
 * `approve` always panic (contracts/membership-sbt/src/lib.rs). A panicking
 * invocation rolls back every storage write *and* every event published
 * earlier in the same call, so there is no committed on-chain event to watch
 * for — detection has to look at what a transaction *attempted* to invoke,
 * not at what it committed.
 *
 * The transaction envelope records the attempted invocation (contract
 * address + function name + args) independently of whether the call
 * ultimately succeeded, so `server.getTransactions()` — which returns
 * `envelopeXdr` for both successful and failed transactions — is enough to
 * detect every attempt, without needing a dedicated on-chain event.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { isValidContractId } from "../config.js";
import type { RpcServerPort, LoggerPort } from "./interfaces.js";
import type { EventInput } from "./db.js";

/**
 * Dependencies of the SBT transfer-watch service, injected explicitly via
 * `initSbtGuard` (called by the composition root) so this module never
 * imports the `stellar.js`/`db.js`/`service-health.js` module singletons
 * to get what it needs (#358).
 */
export interface SbtGuardDeps {
  /** Active RPC server (pool-backed proxy in production). */
  server: RpcServerPort;
  /** Config: relayer test mode (disables the background watch loop). */
  testMode: boolean;
  /** Config: membership SBT contract ID (watch target). */
  membershipSbtContractId?: string;
  /** Config: default poll interval (ms). */
  sbtTransferWatchIntervalMs: number;
  /** Config: admin alert webhook URL (optional). */
  adminAlertWebhookUrl?: string;
  /** Event persistence (events table, DAO-partitioned). */
  addEvent(event: EventInput): boolean;
  /** Health reporting for the watch loop. */
  health: {
    markHealthy(service: "sbt_transfer_watch"): void;
    markDegraded(service: "sbt_transfer_watch", reason?: string): void;
  };
  /** Structured logger (called as `deps.log(level, event, meta)`). */
  log: LoggerPort["log"];
}

let sbtDeps: SbtGuardDeps | null = null;

/** Explicitly wire the SBT guard's dependencies (composition root only). */
export function initSbtGuard(d: SbtGuardDeps): void {
  sbtDeps = d;
}

/** Internal accessor — throws if the composition root has not wired deps. */
function deps(): SbtGuardDeps {
  if (!sbtDeps) {
    throw new Error("sbt-guard: initSbtGuard() must be called before use");
  }
  return sbtDeps;
}


/** The three SEP-41-shaped entrypoints the contract stubs out and always rejects. */
export const SBT_GUARDED_FUNCTIONS: ReadonlySet<string> = new Set([
  "transfer",
  "transfer_from",
  "approve",
]);

export interface DetectedAttempt {
  functionNames: string[];
  daoId: number | null;
}

/**
 * Walk a transaction envelope's operations and return the invoked-contract
 * function name for every `InvokeHostFunction` operation that targets
 * `contractId`. Never throws — an envelope shape this doesn't recognize
 * (fee-bump wrapping, a non-invoke operation, a differently-versioned
 * envelope) yields an empty list rather than aborting the caller's poll loop.
 */
export function extractInvokedFunctionNames(
  envelope: StellarSdk.xdr.TransactionEnvelope,
  contractId: string,
): string[] {
  const names: string[] = [];

  try {
    const tx =
      envelope.switch().name === "envelopeTypeTxFeeBump"
        ? envelope.feeBump().tx().innerTx().v1().tx()
        : envelope.v1().tx();

    for (const op of tx.operations()) {
      const body = op.body();
      if (body.switch().name !== "invokeHostFunction") continue;

      const hostFn = body.invokeHostFunctionOp().hostFunction();
      if (hostFn.switch().name !== "hostFunctionTypeInvokeContract") continue;

      const invocation = hostFn.invokeContract();
      const address = invocation.contractAddress();
      if (address.switch().name !== "scAddressTypeContract") continue;

      const invokedContractId = StellarSdk.StrKey.encodeContract(
        Buffer.from(address.contractId() as unknown as Buffer),
      );
      if (invokedContractId !== contractId) continue;

      names.push(invocation.functionName().toString());
    }
  } catch (err) {
    deps().log("debug", "sbt_guard_envelope_parse_failed", {
      error: (err as Error).message,
    });
    return [];
  }

  return names;
}

/**
 * Best-effort extraction of the DAO ID an attempt targeted. All three
 * guarded functions take `dao_id: u64` as their first argument
 * (contracts/membership-sbt/src/lib.rs), so a fixed argument position works
 * across every guarded function without per-function decoding rules.
 * Returns null on any decode failure — the attempt is still detected and
 * alerted, just without a DAO attribution.
 */
export function extractDaoId(
  envelope: StellarSdk.xdr.TransactionEnvelope,
  contractId: string,
): number | null {
  try {
    const tx =
      envelope.switch().name === "envelopeTypeTxFeeBump"
        ? envelope.feeBump().tx().innerTx().v1().tx()
        : envelope.v1().tx();

    for (const op of tx.operations()) {
      const body = op.body();
      if (body.switch().name !== "invokeHostFunction") continue;

      const hostFn = body.invokeHostFunctionOp().hostFunction();
      if (hostFn.switch().name !== "hostFunctionTypeInvokeContract") continue;

      const invocation = hostFn.invokeContract();
      const address = invocation.contractAddress();
      if (address.switch().name !== "scAddressTypeContract") continue;

      const invokedContractId = StellarSdk.StrKey.encodeContract(
        Buffer.from(address.contractId() as unknown as Buffer),
      );
      if (invokedContractId !== contractId) continue;

      const functionName = invocation.functionName().toString();
      if (!SBT_GUARDED_FUNCTIONS.has(functionName)) continue;

      const args = invocation.args();
      if (args.length === 0) continue;

      const daoId = StellarSdk.scValToNative(args[0]);
      if (typeof daoId === "bigint") return Number(daoId);
      if (typeof daoId === "number") return daoId;
      return null;
    }
  } catch (err) {
    deps().log("debug", "sbt_guard_dao_id_decode_failed", {
      error: (err as Error).message,
    });
  }
  return null;
}

/** True if any invoked function name matches a guarded entrypoint. */
export function isTransferAttempt(functionNames: string[]): boolean {
  return functionNames.some((name) => SBT_GUARDED_FUNCTIONS.has(name));
}

/**
 * Send an admin alert for a detected transfer attempt. Always logs at error
 * level; additionally POSTs to `ADMIN_ALERT_WEBHOOK_URL` when configured.
 * Never throws — a failed webhook delivery marks the service degraded
 * (graceful degradation, consistent with the rest of the backend) rather
 * than surfacing to the poll loop.
 */
export async function alertAdmin(
  payload: Record<string, unknown>,
): Promise<void> {
  deps().log("error", "sbt_transfer_attempt_detected", payload);

  const webhookUrl = deps().adminAlertWebhookUrl;
  if (!webhookUrl) return;

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "sbt_transfer_attempt", ...payload }),
    });
    if (!res.ok) {
      throw new Error(`webhook responded ${res.status}`);
    }
    deps().health.markHealthy("sbt_transfer_watch");
  } catch (err) {
    deps().health.markDegraded("sbt_transfer_watch", (err as Error).message);
    deps().log("warn", "sbt_alert_webhook_failed", {
      error: (err as Error).message,
    });
  }
}

/**
 * Persist a flagged attempt to the events table (type "sbt_transfer_attempt").
 * The events table is DAO-partitioned and rejects a DAO ID outside 1..999999
 * (services/db.ts's validateDaoId), so an attempt whose DAO couldn't be
 * decoded from the envelope is not persisted here — it is still alerted via
 * `alertAdmin` regardless, which doesn't need a DAO attribution to be useful.
 */
export function recordTransferAttempt(
  attempt: DetectedAttempt,
  txHash: string,
  ledger: number,
  successful: boolean,
): boolean {
  if (attempt.daoId === null) return false;

  // dao_id is attacker-controlled operation-arg data (the contract call
  // never executes far enough to validate it), so an out-of-range value must
  // not be allowed to throw out of the poll loop.
  try {
    return deps().addEvent({
      daoId: attempt.daoId,
      type: "sbt_transfer_attempt",
      data: {
        functionNames: attempt.functionNames,
        successful,
      },
      ledger,
      txHash,
      verified: true,
    });
  } catch (err) {
    deps().log("debug", "sbt_guard_record_failed", {
      daoId: attempt.daoId,
      error: (err as Error).message,
    });
    return false;
  }
}

/** Minimal shape this module needs from a `deps().server.getTransactions()` entry. */
export interface TransactionLike {
  envelopeXdr: StellarSdk.xdr.TransactionEnvelope;
  txHash: string;
  ledger: number;
  status: string;
}

/**
 * Full pipeline for one transaction: detect, persist, alert. Returns true if
 * the transaction was flagged as a transfer attempt.
 */
export async function processTransactionForTransferAttempts(
  tx: TransactionLike,
  contractId: string,
): Promise<boolean> {
  const functionNames = extractInvokedFunctionNames(tx.envelopeXdr, contractId);
  if (!isTransferAttempt(functionNames)) return false;

  const daoId = extractDaoId(tx.envelopeXdr, contractId);
  const attempt: DetectedAttempt = { functionNames, daoId };
  const successful = tx.status === "SUCCESS";

  recordTransferAttempt(attempt, tx.txHash, tx.ledger, successful);
  await alertAdmin({
    contractId,
    functionNames,
    daoId,
    txHash: tx.txHash,
    ledger: tx.ledger,
    successful,
  });

  return true;
}

// ── Poll loop ────────────────────────────────────────────────────────────

let cursor: string | null = null;
let watchTimerId: ReturnType<typeof setInterval> | null = null;

/** Reset the in-memory cursor (tests). */
export function resetSbtWatchCursor(): void {
  cursor = null;
}

export async function checkForTransferAttempts(): Promise<{
  checked: number;
  flagged: number;
}> {
  if (deps().testMode) return { checked: 0, flagged: 0 };

  const contractId = deps().membershipSbtContractId;
  if (!contractId || !isValidContractId(contractId)) {
    return { checked: 0, flagged: 0 };
  }

  try {
    const rpcServer = deps().server as StellarSdk.rpc.Server;
    const request = cursor
      ? { pagination: { cursor, limit: 50 } }
      : { startLedger: 0, pagination: { limit: 50 } };
    // Soroban RPC ignores an explicit startLedger of 0 in favor of the
    // retention window's oldest ledger on a cold start.
    const response = await rpcServer.getTransactions(
      request as StellarSdk.rpc.Api.GetTransactionsRequest,
    );

    let flagged = 0;
    for (const tx of response.transactions) {
      const wasFlagged = await processTransactionForTransferAttempts(
        {
          envelopeXdr: tx.envelopeXdr,
          txHash: tx.txHash,
          ledger: tx.ledger,
          status: tx.status,
        },
        contractId,
      );
      if (wasFlagged) flagged++;
    }

    cursor = response.cursor;
    deps().health.markHealthy("sbt_transfer_watch");
    return { checked: response.transactions.length, flagged };
  } catch (err) {
    deps().health.markDegraded("sbt_transfer_watch", (err as Error).message);
    deps().log("error", "sbt_transfer_watch_check_failed", {
      error: (err as Error).message,
    });
    return { checked: 0, flagged: 0 };
  }
}

export function startSbtTransferWatch(intervalMs?: number): void {
  if (deps().testMode) return;

  const interval = intervalMs ?? deps().sbtTransferWatchIntervalMs;

  void checkForTransferAttempts();
  watchTimerId = setInterval(() => {
    void checkForTransferAttempts();
  }, interval);

  deps().log("info", "sbt_transfer_watch_started", { intervalMs: interval });
}

export function stopSbtTransferWatch(): void {
  if (watchTimerId) {
    clearInterval(watchTimerId);
    watchTimerId = null;
    deps().log("info", "sbt_transfer_watch_stopped");
  }
}
