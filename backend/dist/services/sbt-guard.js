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
import { config, isValidContractId } from "../config.js";
import { server } from "./stellar.js";
import { log } from "./logger.js";
import * as dbService from "./db.js";
import { markDegraded, markHealthy } from "./service-health.js";
/** The three SEP-41-shaped entrypoints the contract stubs out and always rejects. */
export const SBT_GUARDED_FUNCTIONS = new Set([
    "transfer",
    "transfer_from",
    "approve",
]);
/**
 * Walk a transaction envelope's operations and return the invoked-contract
 * function name for every `InvokeHostFunction` operation that targets
 * `contractId`. Never throws — an envelope shape this doesn't recognize
 * (fee-bump wrapping, a non-invoke operation, a differently-versioned
 * envelope) yields an empty list rather than aborting the caller's poll loop.
 */
export function extractInvokedFunctionNames(envelope, contractId) {
    const names = [];
    try {
        const tx = envelope.switch().name === "envelopeTypeTxFeeBump"
            ? envelope.feeBump().tx().innerTx().v1().tx()
            : envelope.v1().tx();
        for (const op of tx.operations()) {
            const body = op.body();
            if (body.switch().name !== "invokeHostFunction")
                continue;
            const hostFn = body.invokeHostFunctionOp().hostFunction();
            if (hostFn.switch().name !== "hostFunctionTypeInvokeContract")
                continue;
            const invocation = hostFn.invokeContract();
            const address = invocation.contractAddress();
            if (address.switch().name !== "scAddressTypeContract")
                continue;
            const invokedContractId = StellarSdk.StrKey.encodeContract(Buffer.from(address.contractId()));
            if (invokedContractId !== contractId)
                continue;
            names.push(invocation.functionName().toString());
        }
    }
    catch (err) {
        log("debug", "sbt_guard_envelope_parse_failed", {
            error: err.message,
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
export function extractDaoId(envelope, contractId) {
    try {
        const tx = envelope.switch().name === "envelopeTypeTxFeeBump"
            ? envelope.feeBump().tx().innerTx().v1().tx()
            : envelope.v1().tx();
        for (const op of tx.operations()) {
            const body = op.body();
            if (body.switch().name !== "invokeHostFunction")
                continue;
            const hostFn = body.invokeHostFunctionOp().hostFunction();
            if (hostFn.switch().name !== "hostFunctionTypeInvokeContract")
                continue;
            const invocation = hostFn.invokeContract();
            const address = invocation.contractAddress();
            if (address.switch().name !== "scAddressTypeContract")
                continue;
            const invokedContractId = StellarSdk.StrKey.encodeContract(Buffer.from(address.contractId()));
            if (invokedContractId !== contractId)
                continue;
            const functionName = invocation.functionName().toString();
            if (!SBT_GUARDED_FUNCTIONS.has(functionName))
                continue;
            const args = invocation.args();
            if (args.length === 0)
                continue;
            const daoId = StellarSdk.scValToNative(args[0]);
            if (typeof daoId === "bigint")
                return Number(daoId);
            if (typeof daoId === "number")
                return daoId;
            return null;
        }
    }
    catch (err) {
        log("debug", "sbt_guard_dao_id_decode_failed", {
            error: err.message,
        });
    }
    return null;
}
/** True if any invoked function name matches a guarded entrypoint. */
export function isTransferAttempt(functionNames) {
    return functionNames.some((name) => SBT_GUARDED_FUNCTIONS.has(name));
}
/**
 * Send an admin alert for a detected transfer attempt. Always logs at error
 * level; additionally POSTs to `ADMIN_ALERT_WEBHOOK_URL` when configured.
 * Never throws — a failed webhook delivery marks the service degraded
 * (graceful degradation, consistent with the rest of the backend) rather
 * than surfacing to the poll loop.
 */
export async function alertAdmin(payload) {
    log("error", "sbt_transfer_attempt_detected", payload);
    if (!config.adminAlertWebhookUrl)
        return;
    try {
        const res = await fetch(config.adminAlertWebhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ event: "sbt_transfer_attempt", ...payload }),
        });
        if (!res.ok) {
            throw new Error(`webhook responded ${res.status}`);
        }
        markHealthy("sbt_transfer_watch");
    }
    catch (err) {
        markDegraded("sbt_transfer_watch", err.message);
        log("warn", "sbt_alert_webhook_failed", {
            error: err.message,
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
export function recordTransferAttempt(attempt, txHash, ledger, successful) {
    if (attempt.daoId === null)
        return false;
    // dao_id is attacker-controlled operation-arg data (the contract call
    // never executes far enough to validate it), so an out-of-range value must
    // not be allowed to throw out of the poll loop.
    try {
        return dbService.addEvent({
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
    }
    catch (err) {
        log("debug", "sbt_guard_record_failed", {
            daoId: attempt.daoId,
            error: err.message,
        });
        return false;
    }
}
/**
 * Full pipeline for one transaction: detect, persist, alert. Returns true if
 * the transaction was flagged as a transfer attempt.
 */
export async function processTransactionForTransferAttempts(tx, contractId) {
    const functionNames = extractInvokedFunctionNames(tx.envelopeXdr, contractId);
    if (!isTransferAttempt(functionNames))
        return false;
    const daoId = extractDaoId(tx.envelopeXdr, contractId);
    const attempt = { functionNames, daoId };
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
let cursor = null;
let watchTimerId = null;
/** Reset the in-memory cursor (tests). */
export function resetSbtWatchCursor() {
    cursor = null;
}
export async function checkForTransferAttempts() {
    if (config.testMode)
        return { checked: 0, flagged: 0 };
    const contractId = config.membershipSbtContractId;
    if (!contractId || !isValidContractId(contractId)) {
        return { checked: 0, flagged: 0 };
    }
    try {
        const rpcServer = server;
        const request = cursor
            ? { pagination: { cursor, limit: 50 } }
            : { startLedger: 0, pagination: { limit: 50 } };
        // Soroban RPC ignores an explicit startLedger of 0 in favor of the
        // retention window's oldest ledger on a cold start.
        const response = await rpcServer.getTransactions(request);
        let flagged = 0;
        for (const tx of response.transactions) {
            const wasFlagged = await processTransactionForTransferAttempts({
                envelopeXdr: tx.envelopeXdr,
                txHash: tx.txHash,
                ledger: tx.ledger,
                status: tx.status,
            }, contractId);
            if (wasFlagged)
                flagged++;
        }
        cursor = response.cursor;
        markHealthy("sbt_transfer_watch");
        return { checked: response.transactions.length, flagged };
    }
    catch (err) {
        markDegraded("sbt_transfer_watch", err.message);
        log("error", "sbt_transfer_watch_check_failed", {
            error: err.message,
        });
        return { checked: 0, flagged: 0 };
    }
}
export function startSbtTransferWatch(intervalMs) {
    if (config.testMode)
        return;
    const interval = intervalMs ?? config.sbtTransferWatchIntervalMs;
    void checkForTransferAttempts();
    watchTimerId = setInterval(() => {
        void checkForTransferAttempts();
    }, interval);
    log("info", "sbt_transfer_watch_started", { intervalMs: interval });
}
export function stopSbtTransferWatch() {
    if (watchTimerId) {
        clearInterval(watchTimerId);
        watchTimerId = null;
        log("info", "sbt_transfer_watch_stopped");
    }
}
//# sourceMappingURL=sbt-guard.js.map