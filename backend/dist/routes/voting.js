/**
 * Voting Routes
 *
 * Handles anonymous vote submission with ZK proofs and proposal results retrieval.
 */
import { Router, } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { log } from "../services/logger.js";
import { server, relayerKeypair, callWithTimeout, simulateWithBackoff, waitForTransaction, withSequenceLock, sequenceManager, u256ToScVal, proofToScVal, scValToU256Hex, } from "../services/stellar.js";
import { authGuard, tlsClientCertGuard, voteLimiter, walletRateLimiter, queryLimiter, validateBody, validateParams, bodyLimit, } from "../middleware/index.js";
import { voteSchema, commitSchema, proposalParamsSchema, daoParamsSchema, } from "../validation/schemas.js";
import { ErrorCode } from "../types/index.js";
import { ApiError } from "../utils/errors.js";
import { recordTransactionLog, updateTransactionLogStatus, recordProofCommitment, getProofCommitment, updateProofCommitmentStatus, getVoteSubmission, insertVoteSubmission, updateVoteSubmission, storeVoteReceipt, getVoteReceipt, } from "../services/db.js";
import { calculateProofHash, decryptProofPayload, createSubmissionReceipt, getRelayerPublicKey, } from "../services/proof-encryption.js";
import { votesProcessed } from "../services/metrics.js";
import { sharedSingleFlight } from "../utils/singleflight.js";
const router = Router();
let voteExecutorOverride = null;
/**
 * Replace only the external Stellar submission boundary in test mode.
 */
export function setVoteExecutorForTests(executor) {
    if (!config.testMode) {
        throw new Error("Vote executor overrides are only available in test mode");
    }
    voteExecutorOverride = executor;
}
function respondToVoteExecution(res, execution, nullifier, daoId, proposalId) {
    const { sendResult, result } = execution;
    if (result.status === "SUCCESS") {
        if (nullifier && sendResult.hash) {
            updateTransactionLogStatus(nullifier, "SUCCESS", sendResult.hash);
            storeVoteReceipt(nullifier, sendResult.hash, proposalId, daoId, "confirmed");
        }
        votesProcessed.inc({ status: "success" });
        log("info", "vote_success", {
            txHash: sendResult.hash,
            daoId,
            proposalId,
        });
        return res.json({
            success: true,
            txHash: sendResult.hash,
            status: result.status,
        });
    }
    if (nullifier && sendResult.hash) {
        updateTransactionLogStatus(nullifier, "FAILED", sendResult.hash);
    }
    votesProcessed.inc({ status: "failed" });
    log("error", "vote_failed", {
        txHash: sendResult.hash,
        status: result.status,
    });
    return res.status(500).json({
        error: "Transaction failed",
        txHash: sendResult.hash,
        status: result.status,
    });
}
/**
 * GET /relayer/pubkey - Get relayer public key for proof encryption
 */
router.get("/relayer/pubkey", (_req, res) => {
    res.json({ publicKey: getRelayerPublicKey() });
});
/**
 * POST /vote/commit - Commit to a proof hash before revealing
 */
router.post("/vote/commit", bodyLimit("5kb"), authGuard, tlsClientCertGuard, walletRateLimiter, validateBody(commitSchema), (async (req, res, next) => {
    const { daoId, proposalId, nullifier, commitmentHash, timestamp, walletAddress, choice, root, proof, scNullifier, scRoot, scProof, } = req.body;
    const now = Date.now();
    const ageSeconds = (now - timestamp) / 1000;
    if (ageSeconds > config.maxProofAgeSeconds) {
        return res
            .status(400)
            .json({ error: "Proof expired: submission timestamp is too old" });
    }
    if (timestamp > now + 10000) {
        return res
            .status(400)
            .json({ error: "Invalid timestamp: timestamp is in the future" });
    }
    if (config.testMode) {
        if (!voteExecutorOverride) {
            return res.status(400).json({
                error: "Simulation failed (test mode)",
            });
        }
        const execution = await voteExecutorOverride({
            daoId,
            proposalId,
            choice,
            nullifier,
            root,
            proof,
            scNullifier,
            scRoot,
            scProof,
        });
        if (nullifier && execution.sendResult.hash) {
            recordTransactionLog(nullifier, execution.sendResult.hash, "PENDING");
        }
        return respondToVoteExecution(res, execution, nullifier, daoId, proposalId);
    }
    const existingCommitment = getProofCommitment(commitmentHash);
    if (existingCommitment && existingCommitment.status === "REVEALED") {
        return res
            .status(400)
            .json({ error: "Proof commitment already revealed" });
    }
    recordProofCommitment(commitmentHash, nullifier, daoId, proposalId, timestamp, walletAddress);
    log("info", "proof_committed", {
        daoId,
        proposalId,
        nullifier,
        commitmentHash,
    });
    res.json({
        success: true,
        commitmentHash,
        status: "COMMITTED",
        expiresAt: new Date(timestamp + config.maxProofAgeSeconds * 1000).toISOString(),
    });
}));
router.post("/vote", bodyLimit("5kb"), authGuard, tlsClientCertGuard, walletRateLimiter, voteLimiter, validateBody(voteSchema), (async (req, res, next) => {
    let body = config.stripRequestBodies ? {} : req.body;
    if (body.encryptedPayload) {
        try {
            body = decryptProofPayload(body.encryptedPayload);
        }
        catch (err) {
            return res
                .status(400)
                .json({ error: "Failed to decrypt proof payload" });
        }
    }
    const { daoId, proposalId, choice, nullifier, root, proof, nonce, timestamp, voterPublicKey, voterSignature, } = body;
    try {
        log("info", "vote_request", { daoId, proposalId });
        // Verify voter signature if provided
        if (voterPublicKey && voterSignature) {
            try {
                const payloadToSign = JSON.stringify({
                    daoId,
                    proposalId,
                    choice,
                    nullifier,
                    root,
                    proof,
                    timestamp,
                });
                const payloadHash = StellarSdk.hash(Buffer.from(payloadToSign, "utf8"));
                // Re-build the same minimal ManageData transaction the frontend constructed
                const account = new StellarSdk.Account(voterPublicKey, "0");
                const tx = new StellarSdk.TransactionBuilder(account, {
                    fee: "100",
                    networkPassphrase: config.networkPassphrase,
                })
                    .addOperation(StellarSdk.Operation.manageData({
                    name: "vote_sig",
                    value: payloadHash.slice(0, 28),
                }))
                    .setTimeout(0)
                    .build();
                // Parse the signed XDR the frontend returned
                const signedTx = new StellarSdk.Transaction(voterSignature, config.networkPassphrase);
                // Verify the transaction hash matches what we expect
                const expectedHash = tx.hash();
                const actualHash = signedTx.hash();
                if (!expectedHash.equals(actualHash)) {
                    log("warn", "voter_signature_tx_mismatch", {
                        voterPublicKey,
                        daoId,
                        proposalId,
                    });
                    return res
                        .status(400)
                        .json({ error: "Voter signature does not match vote payload" });
                }
                // Verify the ed25519 signature on the transaction hash
                if (signedTx.signatures.length === 0) {
                    return res
                        .status(400)
                        .json({ error: "Voter signature is missing" });
                }
                const keypair = StellarSdk.Keypair.fromPublicKey(voterPublicKey);
                const sig = signedTx.signatures[0].signature();
                const isValid = keypair.verify(actualHash, sig);
                if (!isValid) {
                    log("warn", "invalid_voter_signature", {
                        voterPublicKey,
                        daoId,
                        proposalId,
                    });
                    return res.status(400).json({ error: "Invalid voter signature" });
                }
                log("info", "voter_signature_verified", {
                    voterPublicKey,
                    daoId,
                    proposalId,
                });
            }
            catch (err) {
                log("warn", "voter_signature_verification_failed", {
                    error: err.message,
                    voterPublicKey,
                });
                return res
                    .status(400)
                    .json({ error: "Voter signature verification failed" });
            }
        }
        // Proof freshness validation
        if (timestamp) {
            const now = Date.now();
            const ageSeconds = (now - timestamp) / 1000;
            if (ageSeconds > config.maxProofAgeSeconds) {
                return res
                    .status(400)
                    .json({ error: "Proof expired: submission timestamp is too old" });
            }
            if (timestamp > now + 10000) {
                return res
                    .status(400)
                    .json({ error: "Invalid timestamp: timestamp is in the future" });
            }
        }
        // Proof commitment validation
        let commitmentHash;
        if (proof && nullifier && timestamp) {
            commitmentHash = calculateProofHash(proof, nullifier, timestamp, nonce);
            const commitmentRecord = getProofCommitment(commitmentHash);
            if (commitmentRecord) {
                if (commitmentRecord.status === "REVEALED") {
                    return res
                        .status(400)
                        .json({ error: "Proof commitment already revealed" });
                }
                updateProofCommitmentStatus(commitmentHash, "REVEALED");
            }
        }
        // Idempotency: check vote_submissions table keyed on nullifier_hash
        if (nullifier) {
            const existing = getVoteSubmission(nullifier);
            if (existing) {
                log("info", "vote_idempotent_hit", {
                    nullifier,
                    txHash: existing.tx_hash,
                    status: existing.status,
                });
                if (existing.status === "confirmed") {
                    const receipt = createSubmissionReceipt(existing.tx_hash, nullifier, daoId, proposalId, commitmentHash || nullifier);
                    return res.status(200).json({
                        success: true,
                        txHash: existing.tx_hash,
                        status: "SUCCESS",
                        replayed: true,
                        receipt,
                    });
                }
                // pending: tell client to retry after 5 s
                res.setHeader("Retry-After", "5");
                return res.status(202).json({
                    success: false,
                    txHash: existing.tx_hash,
                    status: "PENDING",
                });
            }
            // Claim the nullifier slot before doing any on-chain work.
            // If two concurrent requests race here, INSERT OR IGNORE means only
            // one proceeds; the other re-reads above and gets the 202 path.
            if (!insertVoteSubmission(nullifier)) {
                const concurrent = getVoteSubmission(nullifier);
                if (concurrent) {
                    res.setHeader("Retry-After", "5");
                    return res.status(202).json({
                        success: false,
                        txHash: concurrent.tx_hash,
                        status: "PENDING",
                    });
                }
            }
        }
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
                });
                // All proof/eligibility failures surface as VOTE_REJECTED — never
                // expose which specific check failed (THREAT_MODEL.md §privacy).
                throw new Error("SIMULATION_FAILED:VOTE_REJECTED");
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
                // tx_bad_seq: sequence desynchronized — mark dirty and retry once
                const isBadSeq = sequenceManager.handleTxError(typeof sr.errorResult === "string"
                    ? sr.errorResult
                    : JSON.stringify(sr.errorResult ?? ""));
                if (nullifier) {
                    updateTransactionLogStatus(nullifier, "FAILED");
                    updateVoteSubmission(nullifier, "failed");
                }
                log("error", "submit_failed", {
                    daoId,
                    proposalId,
                    error: sr.errorResult,
                    isBadSeq,
                });
                throw new Error(isBadSeq ? "SUBMIT_FAILED_BAD_SEQ" : "SUBMIT_FAILED");
            }
            if (nullifier && sr.hash) {
                recordTransactionLog(nullifier, sr.hash, "PENDING");
            }
            // Wait for confirmation
            log("info", "submitted", { txHash: sr.hash, daoId, proposalId });
            const r = await callWithTimeout(() => waitForTransaction(sr.hash), "wait_for_vote");
            return { sendResult: sr, result: r };
        });
        if (result.status === "SUCCESS") {
            if (nullifier && sendResult.hash) {
                updateTransactionLogStatus(nullifier, "SUCCESS", sendResult.hash);
                updateVoteSubmission(nullifier, "confirmed", sendResult.hash);
            }
            votesProcessed.inc({ status: "success" });
            log("info", "vote_success", {
                txHash: sendResult.hash,
                daoId,
                proposalId,
            });
            const receipt = createSubmissionReceipt(sendResult.hash, nullifier, daoId, proposalId, commitmentHash || nullifier);
            res.json({
                success: true,
                txHash: sendResult.hash,
                status: result.status,
                receipt,
            });
        }
        else {
            if (nullifier && sendResult.hash) {
                updateTransactionLogStatus(nullifier, "FAILED", sendResult.hash);
                updateVoteSubmission(nullifier, "failed", sendResult.hash);
            }
            votesProcessed.inc({ status: "failed" });
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
        if (nullifier) {
            updateTransactionLogStatus(nullifier, "FAILED");
            updateVoteSubmission(nullifier, "failed");
        }
        votesProcessed.inc({ status: "error" });
        log("error", "vote_exception", {
            message: err.message,
            stack: err.stack,
        });
        if (err instanceof ApiError) {
            return next(err);
        }
        const errMsg = err.message || "";
        let statusCode = 500;
        let errorCode = ErrorCode.INTERNAL_ERROR;
        let userMessage = "Internal server error";
        if (errMsg.includes("SIMULATION_FAILED:VOTE_REJECTED")) {
            statusCode = 400;
            errorCode = ErrorCode.VOTE_REJECTED;
            userMessage = "VOTE_REJECTED";
        }
        else if (errMsg === "SUBMIT_FAILED" ||
            errMsg === "SUBMIT_FAILED_BAD_SEQ") {
            statusCode = 500;
            userMessage = "Transaction submission failed";
        }
        else if (errMsg.includes("Timeout:")) {
            statusCode = 504;
            errorCode = ErrorCode.TIMEOUT;
            userMessage = "Request timeout - please try again";
        }
        else if (errMsg.includes("Transaction not found after timeout")) {
            statusCode = 504;
            errorCode = ErrorCode.TIMEOUT;
            userMessage =
                "Transaction confirmation timeout - vote may have succeeded, please check proposal results";
        }
        else if (errMsg.includes("getAccount")) {
            statusCode = 503;
            errorCode = ErrorCode.SERVICE_UNAVAILABLE;
            userMessage = "Blockchain RPC temporarily unavailable - please retry";
        }
        else if (errMsg.includes("ECONNREFUSED") ||
            errMsg.includes("ETIMEDOUT")) {
            statusCode = 503;
            errorCode = ErrorCode.SERVICE_UNAVAILABLE;
            userMessage = "Network error - please retry";
        }
        else if (errMsg.includes("sequence")) {
            statusCode = 503;
            errorCode = ErrorCode.SERVICE_UNAVAILABLE;
            userMessage = "Transaction sequence error - please retry";
        }
        return next(new ApiError(statusCode, errorCode, userMessage, errMsg));
    }
}));
/**
 * GET /proposal/:daoId/:proposalId - Get proposal results
 */
router.get("/proposal/:daoId/:proposalId", queryLimiter, validateParams(proposalParamsSchema), (async (req, res, next) => {
    const { daoId, proposalId } = req.validatedParams;
    try {
        const result = await sharedSingleFlight.do(`proposal:${daoId}:${proposalId}`, async () => {
            const contract = new StellarSdk.Contract(config.votingContractId);
            const args = [
                StellarSdk.nativeToScVal(daoId, { type: "u64" }),
                StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
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
                throw new Error("PROPOSAL_NOT_FOUND");
            }
            // Parse results from simulation
            const resultScVal = simResult.result?.retval;
            if (!resultScVal) {
                throw new Error("NO_RESULT_RETURNED");
            }
            // Parse the tuple (yes_votes, no_votes, closed)
            const resultVec = resultScVal.vec();
            if (!resultVec || resultVec.length < 3) {
                throw new Error("INVALID_RESULT_FORMAT");
            }
            const yesVotes = resultVec[0].u64().toString();
            const noVotes = resultVec[1].u64().toString();
            const closed = resultVec[2].b();
            return {
                daoId,
                proposalId,
                yesVotes,
                noVotes,
                closed,
            };
        });
        res.json(result);
    }
    catch (err) {
        if (err instanceof ApiError)
            return next(err);
        const errMsg = err.message;
        if (errMsg === "PROPOSAL_NOT_FOUND") {
            return next(new ApiError(404, ErrorCode.PROPOSAL_NOT_FOUND, "Proposal not found"));
        }
        else if (errMsg === "NO_RESULT_RETURNED") {
            return next(new ApiError(500, ErrorCode.INTERNAL_ERROR, "No result returned"));
        }
        else if (errMsg === "INVALID_RESULT_FORMAT") {
            return next(new ApiError(500, ErrorCode.INTERNAL_ERROR, "Invalid result format"));
        }
        log("error", "proposal_fetch_error", {
            daoId,
            proposalId,
            error: errMsg,
        });
        return next(new ApiError(500, ErrorCode.INTERNAL_ERROR, "Failed to fetch proposal results", errMsg));
    }
}));
/**
 * GET /root/:daoId - Get current Merkle root for a DAO
 */
router.get("/root/:daoId", queryLimiter, validateParams(daoParamsSchema), (async (req, res, next) => {
    const { daoId } = req.validatedParams;
    try {
        const result = await sharedSingleFlight.do(`root:${daoId}`, async () => {
            const contract = new StellarSdk.Contract(config.treeContractId);
            const args = [StellarSdk.nativeToScVal(daoId, { type: "u64" })];
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
                throw new Error("DAO_NOT_FOUND");
            }
            const resultScVal = simResult.result?.retval;
            if (!resultScVal) {
                throw new Error("NO_RESULT_RETURNED");
            }
            const root = scValToU256Hex(resultScVal);
            return {
                daoId,
                root,
            };
        });
        res.json(result);
    }
    catch (err) {
        if (err instanceof ApiError)
            return next(err);
        const errMsg = err.message;
        if (errMsg === "DAO_NOT_FOUND") {
            return next(new ApiError(404, ErrorCode.DAO_NOT_FOUND, "DAO not found or tree not initialized"));
        }
        else if (errMsg === "NO_RESULT_RETURNED") {
            return next(new ApiError(500, ErrorCode.INTERNAL_ERROR, "No result returned"));
        }
        log("error", "root_fetch_error", { daoId, error: errMsg });
        return next(new ApiError(500, ErrorCode.INTERNAL_ERROR, "Failed to fetch Merkle root", errMsg));
    }
}));
/**
 * GET /nullifier/:daoId/:proposalId/:nullifier
 *
 * Check whether a nullifier has been used for a specific election.
 * Election identity is `(daoId, proposalId)` — callers must pass both so
 * queries never hit a flat global nullifier namespace (issue #64).
 */
router.get("/nullifier/:daoId/:proposalId/:nullifier", queryLimiter, (async (req, res) => {
    const { daoId, proposalId, nullifier } = req.params;
    try {
        const contract = new StellarSdk.Contract(config.votingContractId);
        let scNullifier;
        try {
            scNullifier = u256ToScVal(nullifier);
        }
        catch (err) {
            return res.status(400).json({ error: err.message });
        }
        const args = [
            StellarSdk.nativeToScVal(parseInt(daoId, 10), { type: "u64" }),
            StellarSdk.nativeToScVal(parseInt(proposalId, 10), { type: "u64" }),
            scNullifier,
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
            return res.status(404).json({ error: "Voting contract not found" });
        }
        const resultScVal = simResult.result?.retval;
        if (!resultScVal) {
            return res.status(500).json({ error: "No result returned" });
        }
        const used = resultScVal.b();
        res.json({
            daoId: parseInt(daoId, 10),
            proposalId: parseInt(proposalId, 10),
            electionId: {
                daoId: parseInt(daoId, 10),
                proposalId: parseInt(proposalId, 10),
            },
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
 * GET /root-history/:daoId/:proposalId - Get Merkle root history for auditability
 */
router.get("/root-history/:daoId/:proposalId", queryLimiter, validateParams(proposalParamsSchema), (async (req, res, next) => {
    const { daoId, proposalId } = req.validatedParams;
    try {
        const result = await sharedSingleFlight.do(`root-history:${daoId}:${proposalId}`, async () => {
            const contract = new StellarSdk.Contract(config.votingContractId);
            const args = [
                StellarSdk.nativeToScVal(daoId, { type: "u64" }),
                StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
            ];
            const operation = contract.call("get_merkle_root_history", ...args);
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
                return { daoId, proposalId, history: [] };
            }
            const resultScVal = simResult.result?.retval;
            if (!resultScVal) {
                return { daoId, proposalId, history: [] };
            }
            const rawHistory = StellarSdk.scValToNative(resultScVal) || [];
            const history = Array.isArray(rawHistory)
                ? rawHistory.map((item) => ({
                    root: item.root ? item.root.toString() : "",
                    setAt: Number(item.set_at || 0),
                    setBy: item.set_by || "",
                }))
                : [];
            return {
                daoId,
                proposalId,
                history,
            };
        });
        res.json(result);
    }
    catch (err) {
        if (err instanceof ApiError)
            return next(err);
        log("error", "root_history_fetch_error", {
            daoId,
            proposalId,
            error: err.message,
        });
        return next(new ApiError(500, ErrorCode.INTERNAL_ERROR, "Failed to fetch Merkle root history", err.message));
    }
}));
/**
 * GET /receipt/:nullifier - Fetch vote confirmation receipt
 */
router.get("/receipt/:nullifier", queryLimiter, (async (req, res, next) => {
    try {
        const { nullifier } = req.params;
        if (!nullifier || typeof nullifier !== "string") {
            return res.status(400).json({
                error: "Invalid nullifier: must be a non-empty string",
            });
        }
        const receipt = getVoteReceipt(nullifier);
        if (!receipt) {
            return res.status(404).json({
                error: "Vote receipt not found",
                nullifier,
            });
        }
        log("info", "receipt_fetched", {
            nullifier,
            txHash: receipt.tx_hash,
        });
        return res.json({
            receipt: {
                nullifier: receipt.nullifier,
                txHash: receipt.tx_hash,
                proposalId: receipt.proposal_id,
                daoId: receipt.dao_id,
                status: receipt.status,
                createdAt: receipt.created_at,
            },
        });
    }
    catch (err) {
        if (err instanceof ApiError)
            return next(err);
        log("error", "receipt_fetch_error", {
            nullifier: req.params.nullifier,
            error: err.message,
        });
        return next(new ApiError(500, ErrorCode.INTERNAL_ERROR, "Failed to fetch vote receipt", err.message));
    }
}));
export default router;
//# sourceMappingURL=voting.js.map