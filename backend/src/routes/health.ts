/**
 * Health Check Routes
 *
 * Provides health, readiness, and configuration endpoints.
 */

import { Router, Request, Response } from "express";
import type * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { extractAuthToken } from "../middleware/auth.js";
import { log } from "../services/logger.js";

const router = Router();

// Dependencies injected during setup
let server: StellarSdk.rpc.Server | null = null;
let relayerPublicKey: string = "";

/**
 * Initialize health routes with dependencies
 */
export function initHealthRoutes(
  rpcServer:
    | StellarSdk.rpc.Server
    | { getHealth: () => Promise<{ status: string }> },
  relayerPubKey: string,
): void {
  server = rpcServer as StellarSdk.rpc.Server;
  relayerPublicKey = relayerPubKey;
}

/**
 * Check RPC health status
 */
async function rpcHealth(): Promise<{
  ok: boolean;
  info?: unknown;
  error?: string;
}> {
  if (!server) {
    return { ok: false, error: "RPC server not initialized" };
  }

  try {
    const info = await server.getHealth();
    // Soroban SDK returns 'healthy', but we check for both to be safe
    const status = info?.status as string;
    return { ok: status === "healthy" || status === "online", info };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * GET /health
 * Basic health check
 */
router.get("/health", async (req: Request, res: Response) => {
  const rpc = config.healthcheckPing ? await rpcHealth() : { ok: true };
  const base: Record<string, unknown> = {
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
router.get("/ready", async (req: Request, res: Response) => {
  try {
    const rpcStatus = await rpcHealth();
    if (!rpcStatus.ok) {
      return res.status(503).json({ status: "degraded", rpc: rpcStatus });
    }

    const base: Record<string, unknown> = { status: "ready" };

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
  } catch (err) {
    log("error", "ready_check_failed", { error: (err as Error).message });
    return res
      .status(503)
      .json({ status: "error", message: (err as Error).message });
  }
});

/**
 * GET /config
 * Returns public configuration (for frontend)
 */
router.get("/config", (_req: Request, res: Response) => {
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
