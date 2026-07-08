/**
 * Health Check Routes
 *
 * Provides health, readiness, and configuration endpoints.
 */
import { Router } from "express";
import { config } from "../config.js";
import { extractAuthToken } from "../middleware/auth.js";
import { log } from "../services/logger.js";
const router = Router();
// Dependencies injected during setup
let server = null;
let relayerPublicKey = "";
/**
 * Initialize health routes with dependencies
 */
export function initHealthRoutes(rpcServer, relayerPubKey) {
    server = rpcServer;
    relayerPublicKey = relayerPubKey;
}
/**
 * Check RPC health status
 */
async function rpcHealth() {
    if (!server) {
        return { ok: false, error: "RPC server not initialized" };
    }
    try {
        const info = await server.getHealth();
        // Soroban SDK returns 'healthy', but we check for both to be safe
        const status = info?.status;
        return { ok: status === "healthy" || status === "online", info };
    }
    catch (err) {
        return { ok: false, error: err.message };
    }
}
/**
 * GET /health
 * Basic health check
 */
router.get("/health", async (req, res) => {
    const rpc = config.healthcheckPing ? await rpcHealth() : { ok: true };
    const base = {
        status: "ok",
        rpc,
    };
    // Only expose details if auth token provided
    if (config.healthExposeDetails) {
        const token = extractAuthToken(req);
        if (token === config.relayerAuthToken) {
            base.relayer = relayerPublicKey;
            base.votingContract = config.votingContractId;
            base.treeContract = config.treeContractId;
            base.vkVersion = config.staticVkVersion;
        }
    }
    res.json(base);
});
/**
 * GET /ready
 * Readiness check (verifies RPC connectivity)
 */
router.get("/ready", async (req, res) => {
    try {
        const rpcStatus = await rpcHealth();
        if (!rpcStatus.ok) {
            return res.status(503).json({ status: "degraded", rpc: rpcStatus });
        }
        const base = { status: "ready" };
        // Only expose details if auth token provided
        if (config.healthExposeDetails) {
            const token = extractAuthToken(req);
            if (token === config.relayerAuthToken) {
                base.relayer = relayerPublicKey;
                base.votingContract = config.votingContractId;
                base.treeContract = config.treeContractId;
                base.vkVersion = config.staticVkVersion;
            }
        }
        return res.json(base);
    }
    catch (err) {
        log("error", "ready_check_failed", { error: err.message });
        return res
            .status(503)
            .json({ status: "error", message: err.message });
    }
});
/**
 * GET /config
 * Returns public configuration (for frontend)
 */
router.get("/config", (_req, res) => {
    res.json({
        votingContract: config.votingContractId,
        treeContract: config.treeContractId,
        commentsContract: config.commentsContractId,
        daoRegistryContract: config.daoRegistryContractId,
        membershipSbtContract: config.membershipSbtContractId,
        networkPassphrase: config.networkPassphrase,
        rpcUrl: config.rpcUrl,
        ipfsEnabled: config.ipfsEnabled,
        pinataGateway: config.pinataGateway,
    });
});
export default router;
//# sourceMappingURL=health.js.map