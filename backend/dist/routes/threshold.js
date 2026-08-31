/**
 * Threshold Decryption Routes
 *
 * API endpoints for the threshold decryption protocol:
 * - DKG ceremony management
 * - Authority registration
 * - Encrypted vote submission
 * - Decryption share submission
 * - Tally decryption
 */
import { Router } from "express";
import { log } from "../services/logger.js";
import { authGuard, auditLog, bodyLimit } from "../middleware/index.js";
import * as coordinator from "../services/threshold-coordinator.js";
const router = Router();
/**
 * POST /threshold/init - Initialize threshold decryption for an election
 */
router.post("/threshold/init", bodyLimit("100kb"), authGuard, auditLog("threshold_init"), (async (req, res) => {
    const { daoId, proposalId, thresholdN, thresholdT } = req.body;
    try {
        const round = await coordinator.initializeDKG(Number(daoId), Number(proposalId), Number(thresholdN), Number(thresholdT), req.body.creator || "");
        res.json({
            success: true,
            round,
        });
    }
    catch (err) {
        log("error", "threshold_init_failed", {
            error: err.message,
            daoId,
            proposalId,
        });
        res.status(400).json({ error: err.message });
    }
}));
/**
 * POST /threshold/authority/register - Register a tally authority
 */
router.post("/threshold/authority/register", bodyLimit("100kb"), authGuard, auditLog("threshold_authority_register"), (async (req, res) => {
    const { daoId, proposalId, authorityAddress, authorityName, verifierId } = req.body;
    try {
        const result = await coordinator.registerAuthority(Number(daoId), Number(proposalId), authorityAddress, authorityName, verifierId);
        res.json({
            success: true,
            authorityAddress,
            sharesCount: result.shares.length,
            commitmentsCount: result.commitments.length,
        });
    }
    catch (err) {
        log("error", "threshold_authority_register_failed", {
            error: err.message,
            daoId,
            proposalId,
            authorityAddress,
        });
        res.status(400).json({ error: err.message });
    }
}));
/**
 * POST /threshold/dkg/finalize - Finalize DKG and compute joint public key
 */
router.post("/threshold/dkg/finalize", bodyLimit("100kb"), authGuard, auditLog("threshold_dkg_finalize"), (async (req, res) => {
    const { daoId, proposalId } = req.body;
    try {
        const result = await coordinator.finalizeDKG(Number(daoId), Number(proposalId));
        res.json({
            success: true,
            jointPublicKey: result.jointPublicKey,
            authoritiesCount: result.authorities.length,
        });
    }
    catch (err) {
        log("error", "threshold_dkg_finalize_failed", {
            error: err.message,
            daoId,
            proposalId,
        });
        res.status(400).json({ error: err.message });
    }
}));
/**
 * POST /threshold/vote/encrypt - Encrypt and submit a vote
 */
router.post("/threshold/vote/encrypt", bodyLimit("100kb"), authGuard, auditLog("threshold_vote_encrypt"), (async (req, res) => {
    const { daoId, proposalId, voteChoice, voterNullifier } = req.body;
    try {
        const ciphertext = await coordinator.encryptAndSubmitVote(Number(daoId), Number(proposalId), Number(voteChoice), voterNullifier);
        res.json({
            success: true,
            ciphertext,
        });
    }
    catch (err) {
        log("error", "threshold_vote_encrypt_failed", {
            error: err.message,
            daoId,
            proposalId,
        });
        res.status(400).json({ error: err.message });
    }
}));
/**
 * POST /threshold/tally/compute - Compute the homomorphic encrypted tally
 */
router.post("/threshold/tally/compute", bodyLimit("100kb"), authGuard, auditLog("threshold_tally_compute"), (async (req, res) => {
    const { daoId, proposalId } = req.body;
    try {
        const encryptedTally = await coordinator.computeEncryptedTally(Number(daoId), Number(proposalId));
        res.json({
            success: true,
            encryptedTally,
        });
    }
    catch (err) {
        log("error", "threshold_tally_compute_failed", {
            error: err.message,
            daoId,
            proposalId,
        });
        res.status(400).json({ error: err.message });
    }
}));
/**
 * POST /threshold/decrypt/share - Submit a decryption share
 */
router.post("/threshold/decrypt/share", bodyLimit("100kb"), authGuard, auditLog("threshold_decrypt_share"), (async (req, res) => {
    const { daoId, proposalId, authorityAddress, privateKeyShare, encryptedTally, } = req.body;
    try {
        const shareHex = await coordinator.generateAuthorityDecryptionShare(Number(daoId), Number(proposalId), authorityAddress, BigInt(privateKeyShare), encryptedTally);
        res.json({
            success: true,
            shareHex,
        });
    }
    catch (err) {
        log("error", "threshold_decrypt_share_failed", {
            error: err.message,
            daoId,
            proposalId,
            authorityAddress,
        });
        res.status(400).json({ error: err.message });
    }
}));
/**
 * POST /threshold/tally/decrypt - Combine shares and decrypt the tally
 */
router.post("/threshold/tally/decrypt", bodyLimit("100kb"), authGuard, auditLog("threshold_tally_decrypt"), (async (req, res) => {
    const { daoId, proposalId, encryptedTally } = req.body;
    try {
        const result = await coordinator.computeFinalTally(Number(daoId), Number(proposalId), encryptedTally);
        res.json({
            success: true,
            tally: result.tally.toString(),
            proof: result.proof,
            combinedShare: result.combinedShare,
        });
    }
    catch (err) {
        log("error", "threshold_tally_decrypt_failed", {
            error: err.message,
            daoId,
            proposalId,
        });
        res.status(400).json({ error: err.message });
    }
}));
/**
 * GET /threshold/state/:daoId/:proposalId - Get protocol state
 */
router.get("/threshold/state/:daoId/:proposalId", (async (req, res) => {
    const { daoId, proposalId } = req.params;
    try {
        const state = coordinator.getProtocolState(Number(daoId), Number(proposalId));
        res.json({
            success: true,
            state,
        });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
}));
/**
 * GET /threshold/status - Get overall threshold system status
 */
router.get("/threshold/status", (async (_req, res) => {
    res.json({
        success: true,
        status: "operational",
        version: "1.0.0",
        curves: ["BN254"],
        supportedThresholds: {
            minN: 2,
            maxN: 32,
        },
    });
}));
export default router;
//# sourceMappingURL=threshold.js.map