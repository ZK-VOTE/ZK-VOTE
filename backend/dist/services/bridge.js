/**
 * Bridge Relay Service
 *
 * Watches EVM bridge contract for VoteForwarded events and
 * relays votes to the Soroban bridge contract.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { log } from "./logger.js";
import { server, relayerKeypair, callWithTimeout, simulateWithBackoff, waitForTransaction, withSequenceLock, u256ToScVal, } from "./stellar.js";
// ============================================
// RELAY STATE
// ============================================
let relayRunning = false;
let relayInterval = null;
let lastProcessedBlock = 0;
// ============================================
// EVM EVENT POLLING
// ============================================
/**
 * Poll EVM bridge contract for VoteForwarded events
 * In production, use WebSocket or event subscription
 * For now, poll via RPC
 */
export async function pollEVMEvents() {
    // In production, this would:
    // 1. Connect to Ethereum node via ethers.js
    // 2. Query Bridge contract events since last processed block
    // 3. Parse VoteForwarded events
    //
    // For now, return empty array (placeholder)
    log("info", "evm_poll", { lastBlock: lastProcessedBlock });
    return [];
}
/**
 * Relay a single vote from EVM to Soroban
 */
export async function relayVote(event) {
    try {
        log("info", "relay_vote_start", {
            daoId: event.daoId,
            proposalId: event.proposalId,
            nullifier: event.nullifier,
        });
        // Convert inputs to Soroban types
        const scNullifier = u256ToScVal(event.nullifier);
        const scVoteRoot = u256ToScVal(event.voteRoot);
        if (config.testMode) {
            return { success: false, error: "Simulation failed (test mode)" };
        }
        // Build contract call to Soroban bridge
        const contract = new StellarSdk.Contract(config.bridgeContractId);
        const args = [
            StellarSdk.nativeToScVal(event.daoId, { type: "u64" }),
            StellarSdk.nativeToScVal(event.proposalId, { type: "u64" }),
            StellarSdk.nativeToScVal(event.voteChoice === 1, { type: "bool" }),
            scNullifier,
            scVoteRoot,
        ];
        const operation = contract.call("relay_vote", ...args);
        // Submit under sequence lock
        const { sendResult } = await withSequenceLock(async () => {
            const account = await server.getAccount(relayerKeypair.publicKey());
            const tx = new StellarSdk.TransactionBuilder(account, {
                fee: "100000",
                networkPassphrase: config.networkPassphrase,
            })
                .addOperation(operation)
                .setTimeout(30)
                .build();
            // Simulate
            const simResult = await callWithTimeout(() => simulateWithBackoff(() => server.simulateTransaction(tx)), "simulate_relay");
            if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
                throw new Error(`SIMULATION_FAILED:${simResult.error}`);
            }
            // Prepare and sign
            const preparedTx = StellarSdk.rpc
                .assembleTransaction(tx, simResult)
                .build();
            preparedTx.sign(relayerKeypair);
            // Submit
            const sr = await callWithTimeout(() => server.sendTransaction(preparedTx), "send_relay");
            if (sr.status === "ERROR") {
                throw new Error("SUBMIT_FAILED");
            }
            // Wait for confirmation
            const r = await callWithTimeout(() => waitForTransaction(sr.hash), "wait_relay");
            return { sendResult: sr, result: r };
        });
        log("info", "relay_vote_success", {
            stellarTxHash: sendResult.hash,
            daoId: event.daoId,
            proposalId: event.proposalId,
        });
        return { success: true, stellarTxHash: sendResult.hash };
    }
    catch (err) {
        const errMsg = err.message || "";
        log("error", "relay_vote_failed", {
            daoId: event.daoId,
            proposalId: event.proposalId,
            error: errMsg,
        });
        let userMessage = "Relay failed";
        if (errMsg.startsWith("SIMULATION_FAILED:")) {
            userMessage = errMsg.slice("SIMULATION_FAILED:".length);
        }
        else if (errMsg === "SUBMIT_FAILED") {
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
async function processEvents() {
    if (relayRunning)
        return;
    relayRunning = true;
    try {
        const events = await pollEVMEvents();
        for (const event of events) {
            const result = await relayVote(event);
            if (!result.success) {
                log("warn", "relay_event_failed", {
                    txHash: event.txHash,
                    error: result.error,
                });
            }
            lastProcessedBlock = Math.max(lastProcessedBlock, event.blockNumber);
        }
    }
    catch (err) {
        log("error", "relay_loop_error", { error: err.message });
    }
    finally {
        relayRunning = false;
    }
}
/**
 * Start the relay service
 */
export function startRelay(intervalMs = 10000) {
    if (relayInterval)
        return;
    log("info", "relay_started", { intervalMs });
    relayInterval = setInterval(processEvents, intervalMs);
    // Process immediately
    processEvents();
}
/**
 * Stop the relay service
 */
export function stopRelay() {
    if (relayInterval) {
        clearInterval(relayInterval);
        relayInterval = null;
        log("info", "relay_stopped");
    }
}
//# sourceMappingURL=bridge.js.map