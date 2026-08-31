/**
 * Claim Routes — Vote-to-Earn Anonymous Rewards
 *
 * Thin rewards crate flow: only voters (is_nullifier_used) can claim once via claim-nullifier.
 * Relayer provides anonymity; contract enforces double-claim via claim-nullifier storage.
 */
import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { log } from "../services/logger.js";
import { server, relayerKeypair, callWithTimeout, simulateWithBackoff, waitForTransaction, withSequenceLock, u256ToScVal, proofToScVal, } from "../services/stellar.js";
import { authGuard, claimLimiter, queryLimiter, validateBody, } from "../middleware/index.js";
import { claimSchema } from "../validation/schemas.js";
const router = Router();
/**
 * POST /api/v1/claim — Submit anonymous Vote-to-Earn claim
 * Body: { daoId, proposalId, voteNullifier, claimNullifier, root, proof }
 * Anonymity: relayer pays fee, no require_auth on claimer; commitment private.
 */
router.post("/api/v1/claim", authGuard, claimLimiter, validateBody(claimSchema), (async (req, res) => {
    const { daoId, proposalId, voteNullifier, claimNullifier, root, proof } = config.stripRequestBodies ? {} : req.body;
    try {
        log("info", "claim_request", { daoId, proposalId });
        if (!config.rewardsContractId) {
            return res
                .status(503)
                .json({ error: "Rewards contract not configured" });
        }
        let scVoteNullifier;
        let scClaimNullifier;
        let scRoot;
        let scProof;
        try {
            scVoteNullifier = u256ToScVal(voteNullifier);
            scClaimNullifier = u256ToScVal(claimNullifier);
            scRoot = u256ToScVal(root);
            scProof = proofToScVal(proof);
        }
        catch (err) {
            return res.status(400).json({ error: err.message });
        }
        if (config.testMode) {
            return res.status(400).json({ error: "Simulation failed (test mode)" });
        }
        const contract = new StellarSdk.Contract(config.rewardsContractId);
        const args = [
            StellarSdk.nativeToScVal(daoId, { type: "u64" }),
            StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
            scVoteNullifier,
            scClaimNullifier,
            scRoot,
            scProof,
        ];
        const operation = contract.call("claim", ...args);
        const { sendResult, result } = await withSequenceLock(async () => {
            const account = await server.getAccount(relayerKeypair.publicKey());
            const tx = new StellarSdk.TransactionBuilder(account, {
                fee: "100000",
                networkPassphrase: config.networkPassphrase,
            })
                .addOperation(operation)
                .setTimeout(30)
                .build();
            log("info", "simulate_claim", { daoId, proposalId });
            const simResult = await callWithTimeout(() => simulateWithBackoff(() => server.simulateTransaction(tx)), "simulate_claim");
            if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
                log("warn", "claim_simulation_failed", {
                    daoId,
                    proposalId,
                    error: simResult.error,
                });
                let errorMessage = "Transaction simulation failed";
                if (simResult.error) {
                    const errorStr = JSON.stringify(simResult.error);
                    if (errorStr.includes("AlreadyClaimed") ||
                        errorStr.includes("ClaimNullifierUsed") ||
                        errorStr.includes("5")) {
                        errorMessage = "Reward already claimed for this vote";
                    }
                    else if (errorStr.includes("NotVoted") ||
                        errorStr.includes("4")) {
                        errorMessage = "Vote not found — only voters can claim";
                    }
                    else if (errorStr.includes("TreasuryInsufficient") ||
                        errorStr.includes("20")) {
                        errorMessage = "Treasury insufficient";
                    }
                    else if (errorStr.includes("invalid proof") ||
                        errorStr.includes("InvalidProof")) {
                        errorMessage = "Invalid claim proof";
                    }
                    else if (errorStr.includes("root") || errorStr.includes("Root")) {
                        errorMessage = "Invalid Merkle root for this proposal";
                    }
                    else if (errorStr.includes("UnreachableCodeReached")) {
                        errorMessage = "Invalid proof or contract error";
                    }
                }
                throw new Error(`SIMULATION_FAILED:${errorMessage}`);
            }
            const preparedTx = StellarSdk.rpc
                .assembleTransaction(tx, simResult)
                .build();
            preparedTx.sign(relayerKeypair);
            log("info", "submit_claim", { daoId, proposalId });
            const sr = await callWithTimeout(() => server.sendTransaction(preparedTx), "send_claim");
            if (sr.status === "ERROR") {
                log("error", "claim_submit_failed", {
                    daoId,
                    proposalId,
                    error: sr.errorResult,
                });
                throw new Error("SUBMIT_FAILED");
            }
            log("info", "claim_submitted", { txHash: sr.hash, daoId, proposalId });
            const r = await callWithTimeout(() => waitForTransaction(sr.hash), "wait_for_claim");
            return { sendResult: sr, result: r };
        });
        if (result.status === "SUCCESS") {
            log("info", "claim_success", {
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
            log("error", "claim_failed", {
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
        log("error", "claim_exception", {
            message: err.message,
            stack: err.stack,
        });
        const errMsg = err.message || "";
        let statusCode = 500;
        let userMessage = "Internal server error";
        if (errMsg.startsWith("SIMULATION_FAILED:")) {
            statusCode = 400;
            userMessage = errMsg.slice("SIMULATION_FAILED:".length);
        }
        else if (errMsg === "SUBMIT_FAILED") {
            statusCode = 500;
            userMessage = "Transaction submission failed";
        }
        else if (errMsg.includes("Timeout:")) {
            statusCode = 504;
            userMessage = "Request timeout - please try again";
        }
        else if (errMsg.includes("Transaction not found after timeout")) {
            statusCode = 504;
            userMessage =
                "Transaction confirmation timeout - claim may have succeeded, please check status";
        }
        else if (errMsg.includes("getAccount")) {
            statusCode = 503;
            userMessage = "Blockchain RPC temporarily unavailable - please retry";
        }
        else if (errMsg.includes("ECONNREFUSED") ||
            errMsg.includes("ETIMEDOUT")) {
            statusCode = 503;
            userMessage = "Network error - please retry";
        }
        else if (errMsg.includes("sequence")) {
            statusCode = 503;
            userMessage = "Transaction sequence error - please retry";
        }
        res
            .status(statusCode)
            .json(config.genericErrors
            ? { error: userMessage }
            : { error: userMessage, details: errMsg });
    }
}));
// Also support POST /claim alias for backwards compat (query tests may hit /claim)
router.post("/claim", authGuard, claimLimiter, validateBody(claimSchema), (async (req, res) => {
    // Re-use same logic via internal redirect – duplicate handler for simplicity
    // We call the same implementation by forwarding to /api/v1/claim logic
    // To avoid duplication we just throw 308? Instead implement inline.
    const { daoId, proposalId, voteNullifier, claimNullifier, root, proof } = config.stripRequestBodies ? {} : req.body;
    try {
        log("info", "claim_request_alias", { daoId, proposalId });
        if (!config.rewardsContractId) {
            return res
                .status(503)
                .json({ error: "Rewards contract not configured" });
        }
        let scVoteNullifier;
        let scClaimNullifier;
        let scRoot;
        let scProof;
        try {
            scVoteNullifier = u256ToScVal(voteNullifier);
            scClaimNullifier = u256ToScVal(claimNullifier);
            scRoot = u256ToScVal(root);
            scProof = proofToScVal(proof);
        }
        catch (err) {
            return res.status(400).json({ error: err.message });
        }
        if (config.testMode) {
            return res.status(400).json({ error: "Simulation failed (test mode)" });
        }
        const contract = new StellarSdk.Contract(config.rewardsContractId);
        const args = [
            StellarSdk.nativeToScVal(daoId, { type: "u64" }),
            StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
            scVoteNullifier,
            scClaimNullifier,
            scRoot,
            scProof,
        ];
        const operation = contract.call("claim", ...args);
        const { sendResult, result } = await withSequenceLock(async () => {
            const account = await server.getAccount(relayerKeypair.publicKey());
            const tx = new StellarSdk.TransactionBuilder(account, {
                fee: "100000",
                networkPassphrase: config.networkPassphrase,
            })
                .addOperation(operation)
                .setTimeout(30)
                .build();
            const simResult = await callWithTimeout(() => simulateWithBackoff(() => server.simulateTransaction(tx)), "simulate_claim");
            if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
                let errorMessage = "Transaction simulation failed";
                if (simResult.error) {
                    const errorStr = JSON.stringify(simResult.error);
                    if (errorStr.includes("AlreadyClaimed") ||
                        errorStr.includes("ClaimNullifierUsed") ||
                        errorStr.includes("5")) {
                        errorMessage = "Reward already claimed for this vote";
                    }
                    else if (errorStr.includes("NotVoted") ||
                        errorStr.includes("4")) {
                        errorMessage = "Vote not found — only voters can claim";
                    }
                    else if (errorStr.includes("TreasuryInsufficient") ||
                        errorStr.includes("20")) {
                        errorMessage = "Treasury insufficient";
                    }
                    else if (errorStr.includes("invalid proof") ||
                        errorStr.includes("InvalidProof")) {
                        errorMessage = "Invalid claim proof";
                    }
                    else if (errorStr.includes("root") || errorStr.includes("Root")) {
                        errorMessage = "Invalid Merkle root for this proposal";
                    }
                }
                throw new Error(`SIMULATION_FAILED:${errorMessage}`);
            }
            const preparedTx = StellarSdk.rpc
                .assembleTransaction(tx, simResult)
                .build();
            preparedTx.sign(relayerKeypair);
            const sr = await callWithTimeout(() => server.sendTransaction(preparedTx), "send_claim");
            if (sr.status === "ERROR")
                throw new Error("SUBMIT_FAILED");
            const r = await callWithTimeout(() => waitForTransaction(sr.hash), "wait_for_claim");
            return { sendResult: sr, result: r };
        });
        if (result.status === "SUCCESS") {
            res.json({
                success: true,
                txHash: sendResult.hash,
                status: result.status,
            });
        }
        else {
            res.status(500).json({
                error: "Transaction failed",
                txHash: sendResult.hash,
                status: result.status,
            });
        }
    }
    catch (err) {
        const errMsg = err.message || "";
        let statusCode = 500;
        let userMessage = "Internal server error";
        if (errMsg.startsWith("SIMULATION_FAILED:")) {
            statusCode = 400;
            userMessage = errMsg.slice("SIMULATION_FAILED:".length);
        }
        else if (errMsg === "SUBMIT_FAILED") {
            statusCode = 500;
            userMessage = "Transaction submission failed";
        }
        res
            .status(statusCode)
            .json(config.genericErrors
            ? { error: userMessage }
            : { error: userMessage, details: errMsg });
    }
}));
/**
 * GET /api/v1/claim/status/:daoId/:proposalId/:claimNullifier — check if claimed
 */
router.get("/api/v1/claim/status/:daoId/:proposalId/:claimNullifier", queryLimiter, (async (req, res) => {
    const { daoId, proposalId, claimNullifier } = req.params;
    try {
        if (!config.rewardsContractId) {
            return res
                .status(503)
                .json({ error: "Rewards contract not configured" });
        }
        const contract = new StellarSdk.Contract(config.rewardsContractId);
        const scClaimNullifier = u256ToScVal(claimNullifier);
        const args = [
            StellarSdk.nativeToScVal(parseInt(daoId), { type: "u64" }),
            StellarSdk.nativeToScVal(parseInt(proposalId), { type: "u64" }),
            scClaimNullifier,
        ];
        const operation = contract.call("is_claimed", ...args);
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
            return res.status(500).json({ error: "Failed to check claim status" });
        }
        const resultScVal = simResult.result?.retval;
        const isClaimed = resultScVal
            ? StellarSdk.scValToNative(resultScVal)
            : false;
        res.json({
            daoId: parseInt(daoId),
            proposalId: parseInt(proposalId),
            claimNullifier,
            isClaimed: Boolean(isClaimed),
        });
    }
    catch (err) {
        log("error", "claim_status_error", {
            daoId,
            proposalId,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to fetch claim status" });
    }
}));
/**
 * GET /api/v1/claim/treasury/:daoId — get treasury balance
 */
router.get("/api/v1/claim/treasury/:daoId", queryLimiter, (async (req, res) => {
    const { daoId } = req.params;
    try {
        if (!config.rewardsContractId) {
            return res.status(503).json({ error: "Rewards contract not configured" });
        }
        const contract = new StellarSdk.Contract(config.rewardsContractId);
        const args = [StellarSdk.nativeToScVal(parseInt(daoId), { type: "u64" })];
        const operation = contract.call("get_treasury", ...args);
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
            return res.status(500).json({ error: "Failed to fetch treasury" });
        }
        const resultScVal = simResult.result?.retval;
        const bal = resultScVal ? StellarSdk.scValToNative(resultScVal) : 0;
        res.json({
            daoId: parseInt(daoId),
            treasury: bal?.toString?.() ?? String(bal),
        });
    }
    catch (err) {
        log("error", "treasury_fetch_error", {
            daoId,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to fetch treasury" });
    }
}));
export default router;
//# sourceMappingURL=claim.js.map