/**
 * Voting Routes
 *
 * Handles anonymous vote submission with ZK proofs and proposal results retrieval.
 */
import { Router } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { log } from "../services/logger.js";
import { server, relayerKeypair, callWithTimeout, simulateWithBackoff, waitForTransaction, withSequenceLock, u256ToScVal, proofToScVal, scValToU256Hex, } from "../services/stellar.js";
import { authGuard, voteLimiter, queryLimiter, validateBody, } from "../middleware/index.js";
import { voteSchema } from "../validation/schemas.js";
const router = Router();
/**
 * POST /vote - Submit anonymous vote with ZK proof
 */
router.post("/vote", authGuard, voteLimiter, validateBody(voteSchema), (async (req, res) => {
    // Validated by voteSchema middleware
    const { daoId, proposalId, choice, nullifier, root, proof } = config.stripRequestBodies ? {} : req.body;
    try {
        log("info", "vote_request", { daoId, proposalId });
        // Convert inputs to Soroban types
        let scNullifier;
        let scRoot;
        let scProof;
        try {
            scNullifier = u256ToScVal(nullifier);
            scRoot = u256ToScVal(root);
            scProof = proofToScVal(proof);
        }
        catch (err) {
            return res.status(400).json({ error: err.message });
        }
        if (config.testMode) {
            return res.status(400).json({ error: "Simulation failed (test mode)" });
        }
        // Build contract call
        const contract = new StellarSdk.Contract(config.votingContractId);
        const args = [
            StellarSdk.nativeToScVal(daoId, { type: "u64" }),
            StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
            StellarSdk.nativeToScVal(choice, { type: "bool" }),
            scNullifier,
            scRoot,
            scProof,
        ];
        const operation = contract.call("vote", ...args);
        // Serialize account fetch + build + simulate + sign + submit under sequence lock
        // to prevent nonce race conditions between concurrent requests
        const { sendResult, result } = await withSequenceLock(async () => {
            // Get relayer account
            const account = await server.getAccount(relayerKeypair.publicKey());
            // Build transaction
            const tx = new StellarSdk.TransactionBuilder(account, {
                fee: "100000",
                networkPassphrase: config.networkPassphrase,
            })
                .addOperation(operation)
                .setTimeout(30)
                .build();
            // Simulate
            log("info", "simulate_vote", { daoId, proposalId });
            const simResult = await callWithTimeout(() => simulateWithBackoff(() => server.simulateTransaction(tx)), "simulate_vote");
            if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
                log("warn", "simulation_failed", {
                    daoId,
                    proposalId,
                    error: simResult.error,
                });
                let errorMessage = "Transaction simulation failed";
                if (simResult.error) {
                    const errorStr = JSON.stringify(simResult.error);
                    if (errorStr.includes("already voted")) {
                        errorMessage = "You have already voted on this proposal";
                    }
                    else if (errorStr.includes("voting period closed")) {
                        errorMessage = "Voting period has ended";
                    }
                    else if (errorStr.includes("invalid proof")) {
                        errorMessage = "Invalid vote proof";
                    }
                    else if (errorStr.includes("root must match")) {
                        errorMessage = "You are not eligible to vote on this proposal";
                    }
                    else if (errorStr.includes("proposal not found")) {
                        errorMessage = "Proposal not found";
                    }
                    else if (errorStr.includes("UnreachableCodeReached")) {
                        errorMessage =
                            "Invalid proof or contract error (proof verification failed)";
                    }
                }
                throw new Error(`SIMULATION_FAILED:${errorMessage}`);
            }
            // Prepare and sign
            const preparedTx = StellarSdk.rpc
                .assembleTransaction(tx, simResult)
                .build();
            preparedTx.sign(relayerKeypair);
            // Submit
            log("info", "submit_vote", { daoId, proposalId });
            const sr = await callWithTimeout(() => server.sendTransaction(preparedTx), "send_vote");
            if (sr.status === "ERROR") {
                log("error", "submit_failed", {
                    daoId,
                    proposalId,
                    error: sr.errorResult,
                });
                throw new Error("SUBMIT_FAILED");
            }
            // Wait for confirmation
            log("info", "submitted", { txHash: sr.hash, daoId, proposalId });
            const r = await callWithTimeout(() => waitForTransaction(sr.hash), "wait_for_vote");
            return { sendResult: sr, result: r };
        });
        if (result.status === "SUCCESS") {
            log("info", "vote_success", {
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
            log("error", "vote_failed", {
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
        log("error", "vote_exception", {
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
                "Transaction confirmation timeout - vote may have succeeded, please check proposal results";
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
/**
 * GET /proposal/:daoId/:proposalId - Get proposal results
 */
router.get("/proposal/:daoId/:proposalId", queryLimiter, (async (req, res) => {
    const { daoId, proposalId } = req.params;
    try {
        const contract = new StellarSdk.Contract(config.votingContractId);
        const args = [
            StellarSdk.nativeToScVal(parseInt(daoId), { type: "u64" }),
            StellarSdk.nativeToScVal(parseInt(proposalId), { type: "u64" }),
        ];
        const operation = contract.call("get_results", ...args);
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
            return res.status(404).json({ error: "Proposal not found" });
        }
        // Parse results from simulation
        const resultScVal = simResult.result?.retval;
        if (!resultScVal) {
            return res.status(500).json({ error: "No result returned" });
        }
        // Parse the tuple (yes_votes, no_votes, closed)
        const resultVec = resultScVal.vec();
        if (!resultVec || resultVec.length < 3) {
            return res.status(500).json({ error: "Invalid result format" });
        }
        const yesVotes = resultVec[0].u64().toString();
        const noVotes = resultVec[1].u64().toString();
        const closed = resultVec[2].b();
        res.json({
            daoId: parseInt(daoId),
            proposalId: parseInt(proposalId),
            yesVotes,
            noVotes,
            closed,
        });
    }
    catch (err) {
        log("error", "proposal_fetch_error", {
            daoId,
            proposalId,
            error: err.message,
        });
        res.status(500).json({ error: "Failed to fetch proposal results" });
    }
}));
/**
 * GET /root/:daoId - Get current Merkle root for a DAO
 */
router.get("/root/:daoId", queryLimiter, (async (req, res) => {
    const { daoId } = req.params;
    try {
        const contract = new StellarSdk.Contract(config.treeContractId);
        const args = [StellarSdk.nativeToScVal(parseInt(daoId), { type: "u64" })];
        const operation = contract.call("get_root", ...args);
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
            return res
                .status(404)
                .json({ error: "DAO not found or tree not initialized" });
        }
        const resultScVal = simResult.result?.retval;
        if (!resultScVal) {
            return res.status(500).json({ error: "No result returned" });
        }
        const root = scValToU256Hex(resultScVal);
        res.json({
            daoId: parseInt(daoId),
            root,
        });
    }
    catch (err) {
        log("error", "root_fetch_error", { daoId, error: err.message });
        res.status(500).json({ error: "Failed to fetch Merkle root" });
    }
}));
export default router;
//# sourceMappingURL=voting.js.map