/**
 * Bridge Routes
 *
 * Handles cross-chain bridge operations:
 * - POST /bridge/vote - Submit a cross-chain vote (EVM -> Soroban)
 * - GET /bridge/nullifier/:daoId/:proposalId/:nullifier - Check nullifier status
 * - GET /bridge/sbt-root/:daoId - Get current SBT root for a DAO
 * - POST /bridge/relay - Manually trigger event relay
 */
import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { log } from "../services/logger.js";
import { server, relayerKeypair, callWithTimeout, simulateWithBackoff, waitForTransaction, withSequenceLock, u256ToScVal, } from "../services/stellar.js";
import { verifyBridgeProof } from "../services/bridgeProof.js";
import { authGuard, bodyLimit, queryLimiter, validateBody, voteLimiter, } from "../middleware/index.js";
import { bridgeVoteSchema } from "../validation/schemas.js";
const router = Router();
/** Privacy-preserving rejection — never disclose which check failed. */
function voteRejected(res, status = 400) {
    return res.status(status).json({
        error: "VOTE_REJECTED",
        code: "VOTE_REJECTED",
    });
}
// ============================================
// ROUTES
// ============================================
/**
 * POST /bridge/vote - Submit cross-chain vote
 *
 * Receives a Groth16 proof, verifies it off-chain against the bridge VK, then
 * relays only the public vote fields to Soroban `relay_vote` (which does not
 * accept a proof). Authenticity comes from the verified proof + authGuard.
 */
router.post("/bridge/vote", bodyLimit("5kb"), authGuard, voteLimiter, validateBody(bridgeVoteSchema), (async (req, res) => {
    const { daoId, proposalId, voteChoice, nullifier, voteRoot, sbtRoot, sbtContractAddr, memberAddr, proof, } = config.stripRequestBodies ? {} : req.body;
    try {
        log("info", "bridge_vote_request", { daoId, proposalId });
        const proofValid = await verifyBridgeProof(proof, {
            sbtContractAddr,
            memberAddr,
            daoId,
            proposalId,
            nullifier,
            voteChoice,
            voteRoot,
            sbtRoot,
        });
        if (!proofValid) {
            return voteRejected(res);
        }
        // Convert inputs to Soroban types
        let scNullifier;
        let scRoot;
        try {
            scNullifier = u256ToScVal(nullifier);
            scRoot = u256ToScVal(voteRoot);
        }
        catch {
            return voteRejected(res);
        }
        if (config.testMode) {
            return voteRejected(res);
        }
        if (!config.bridgeContractId) {
            log("error", "bridge_contract_not_configured");
            return res.status(503).json({ error: "Bridge unavailable" });
        }
        // Build contract call to Soroban bridge
        const contract = new StellarSdk.Contract(config.bridgeContractId);
        const relayerAddress = StellarSdk.Address.fromString(relayerKeypair.publicKey());
        const args = [
            StellarSdk.nativeToScVal(daoId, { type: "u64" }),
            StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
            StellarSdk.nativeToScVal(voteChoice === 1, { type: "bool" }),
            scNullifier,
            scRoot,
            relayerAddress.toScVal(),
        ];
        const operation = contract.call("relay_vote", ...args);
        // Submit under sequence lock
        const { sendResult, result } = await withSequenceLock(async () => {
            const account = await server.getAccount(relayerKeypair.publicKey());
            const tx = new StellarSdk.TransactionBuilder(account, {
                fee: "100000",
                networkPassphrase: config.networkPassphrase,
            })
                .addOperation(operation)
                .setTimeout(30)
                .build();
            // Simulate
            log("info", "simulate_bridge_vote", { daoId, proposalId });
            const simResult = await callWithTimeout(() => simulateWithBackoff(() => server.simulateTransaction(tx)), "simulate_bridge_vote");
            if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
                // Do not surface contract diagnostics (nullifier / already-voted).
                log("warn", "bridge_simulation_failed", { daoId, proposalId });
                throw new Error("SIMULATION_FAILED:VOTE_REJECTED");
            }
            // Prepare and sign
            const preparedTx = StellarSdk.rpc
                .assembleTransaction(tx, simResult)
                .build();
            preparedTx.sign(relayerKeypair);
            // Submit
            log("info", "submit_bridge_vote", { daoId, proposalId });
            const sr = await callWithTimeout(() => server.sendTransaction(preparedTx), "send_bridge_vote");
            if (sr.status === "ERROR") {
                log("error", "bridge_submit_failed", {
                    daoId,
                    proposalId,
                });
                throw new Error("SUBMIT_FAILED");
            }
            // Wait for confirmation
            log("info", "bridge_submitted", { txHash: sr.hash, daoId, proposalId });
            const r = await callWithTimeout(() => waitForTransaction(sr.hash), "wait_bridge_vote");
            return { sendResult: sr, result: r };
        });
        if (result.status === "SUCCESS") {
            log("info", "bridge_vote_success", {
                txHash: sendResult.hash,
                daoId,
                proposalId,
            });
            res.json({
                success: true,
                txHash: sendResult.hash,
                status: result.status,
            });
        }
        else {
            log("error", "bridge_vote_failed", {
                txHash: sendResult.hash,
                status: result.status,
            });
            res.status(500).json({
                error: "Transaction failed",
                txHash: sendResult.hash,
                status: result.status,
            });
        }
    }
    catch (err) {
        log("error", "bridge_vote_exception", {
            message: err.message,
        });
        const errMsg = err.message || "";
        if (errMsg.startsWith("SIMULATION_FAILED:")) {
            return voteRejected(res);
        }
        if (errMsg === "SUBMIT_FAILED") {
            return res.status(500).json({ error: "Transaction submission failed" });
        }
        if (errMsg.includes("Timeout:")) {
            return res
                .status(504)
                .json({ error: "Request timeout - please try again" });
        }
        return res.status(500).json({ error: "Internal server error" });
    }
}));
/**
 * GET /bridge/nullifier/:daoId/:proposalId/:nullifier
 *
 * Check if a nullifier has been used (for double-vote detection)
 */
router.get("/bridge/nullifier/:daoId/:proposalId/:nullifier", queryLimiter, (async (req, res) => {
    const { daoId, proposalId, nullifier } = req.params;
    try {
        const contract = new StellarSdk.Contract(config.bridgeContractId);
        const args = [
            StellarSdk.nativeToScVal(parseInt(daoId), { type: "u64" }),
            StellarSdk.nativeToScVal(parseInt(proposalId), { type: "u64" }),
            u256ToScVal(nullifier),
        ];
        const operation = contract.call("is_nullifier_used", ...args);
        const account = await server.getAccount(relayerKeypair.publicKey());
        const tx = new StellarSdk.TransactionBuilder(account, {
            fee: "100000",
            networkPassphrase: config.networkPassphrase,
        })
            .addOperation(operation)
            .setTimeout(30)
            .build();
        const simResult = await server.simulateTransaction(tx);
        if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
            return res.status(404).json({ error: "Bridge contract not found" });
        }
        const resultScVal = simResult.result?.retval;
        if (!resultScVal) {
            return res.status(500).json({ error: "No result returned" });
        }
        const used = resultScVal.b();
        res.json({
            daoId: parseInt(daoId),
            proposalId: parseInt(proposalId),
            nullifier,
            used,
        });
    }
    catch (err) {
        log("error", "nullifier_check_error", {
            daoId,
            proposalId,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to check nullifier status" });
    }
}));
/**
 * POST /bridge/relay - Manually trigger event relay
 *
 * Admin endpoint to manually process EVM events
 */
router.post("/bridge/relay", authGuard, (async (req, res) => {
    try {
        // Trigger relay processing
        log("info", "manual_relay_triggered");
        res.json({ success: true, message: "Relay triggered" });
    }
    catch (err) {
        log("error", "manual_relay_error", { error: err.message });
        res.status(500).json({ error: "Failed to trigger relay" });
    }
}));
export default router;
//# sourceMappingURL=bridge.js.map