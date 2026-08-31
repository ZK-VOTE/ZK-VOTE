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
/** The three SEP-41-shaped entrypoints the contract stubs out and always rejects. */
export declare const SBT_GUARDED_FUNCTIONS: ReadonlySet<string>;
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
export declare function extractInvokedFunctionNames(envelope: StellarSdk.xdr.TransactionEnvelope, contractId: string): string[];
/**
 * Best-effort extraction of the DAO ID an attempt targeted. All three
 * guarded functions take `dao_id: u64` as their first argument
 * (contracts/membership-sbt/src/lib.rs), so a fixed argument position works
 * across every guarded function without per-function decoding rules.
 * Returns null on any decode failure — the attempt is still detected and
 * alerted, just without a DAO attribution.
 */
export declare function extractDaoId(envelope: StellarSdk.xdr.TransactionEnvelope, contractId: string): number | null;
/** True if any invoked function name matches a guarded entrypoint. */
export declare function isTransferAttempt(functionNames: string[]): boolean;
/**
 * Send an admin alert for a detected transfer attempt. Always logs at error
 * level; additionally POSTs to `ADMIN_ALERT_WEBHOOK_URL` when configured.
 * Never throws — a failed webhook delivery marks the service degraded
 * (graceful degradation, consistent with the rest of the backend) rather
 * than surfacing to the poll loop.
 */
export declare function alertAdmin(payload: Record<string, unknown>): Promise<void>;
/**
 * Persist a flagged attempt to the events table (type "sbt_transfer_attempt").
 * The events table is DAO-partitioned and rejects a DAO ID outside 1..999999
 * (services/db.ts's validateDaoId), so an attempt whose DAO couldn't be
 * decoded from the envelope is not persisted here — it is still alerted via
 * `alertAdmin` regardless, which doesn't need a DAO attribution to be useful.
 */
export declare function recordTransferAttempt(attempt: DetectedAttempt, txHash: string, ledger: number, successful: boolean): boolean;
/** Minimal shape this module needs from a `server.getTransactions()` entry. */
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
export declare function processTransactionForTransferAttempts(tx: TransactionLike, contractId: string): Promise<boolean>;
/** Reset the in-memory cursor (tests). */
export declare function resetSbtWatchCursor(): void;
export declare function checkForTransferAttempts(): Promise<{
    checked: number;
    flagged: number;
}>;
export declare function startSbtTransferWatch(intervalMs?: number): void;
export declare function stopSbtTransferWatch(): void;
//# sourceMappingURL=sbt-guard.d.ts.map