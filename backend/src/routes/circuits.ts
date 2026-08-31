import { Router, type Request, type Response } from "express";

import { log } from "../services/logger.js";
import {
  getCircuitInfo,
  getDaoMigration,
  getDaoCurrentCircuit,
  getVK,
  getCurrentVersion,
  isStaleVersion,
} from "../services/circuit-registry.js";
import { queryLimiter, validateParams } from "../middleware/index.js";
import { circuitParamsSchema } from "../validation/schemas.js";
import type { AsyncHandler } from "../types/index.js";

const router = Router();

// Existing: circuit status for DAO migration
router.get("/circuits/:dao/:type/status", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { dao, type } = req.params;

  const daoId = parseInt(dao, 10);
  if (isNaN(daoId)) {
    return res.status(400).json({ error: "Invalid dao ID" });
  }

  const circuitType = type === "comment" ? "Comment" : "Vote";

  try {
    log("info", "circuit_status_request", { daoId, circuitType });

    const currentCircuit = await getDaoCurrentCircuit(daoId, circuitType);
    const migration = await getDaoMigration(daoId);

    const knownCircuitIds: string[] = ["vote_v1", "vote_v2", "weighted_vote"];
    const availableCircuits = [];
    for (const cid of knownCircuitIds) {
      const info = await getCircuitInfo(cid, circuitType);
      if (info) availableCircuits.push(info);
    }

    return res.json({
      daoId,
      circuitType,
      currentCircuit: currentCircuit ?? "vote_v1",
      availableCircuits,
      migration: migration ?? undefined,
    });
  } catch (error) {
    log("error", "circuit_status_error", {
      daoId,
      error: (error as Error).message,
    });
    return res.status(500).json({ error: "Failed to fetch circuit status" });
  }
}) as AsyncHandler);

// Versioned VK API (ZK-013)
// GET /circuits/vk/:circuitId/:version -> returns versioned verification key
router.get("/circuits/vk/:circuitId/:version", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { circuitId, version } = req.params;
  const ver = parseInt(version, 10);
  if (isNaN(ver) || ver < 1) {
    return res.status(400).json({ error: "Invalid version" });
  }

  try {
    const currentVersion = await getCurrentVersion(circuitId);
    // Mismatch detection: stale version rejected with 410 Gone
    if (currentVersion !== null && isStaleVersion(ver, currentVersion)) {
      log("warn", "stale_vk_rejected", { circuitId, requested: ver, current: currentVersion });
      return res.status(410).json({
        error: "Stale VK version",
        circuitId,
        requestedVersion: ver,
        currentVersion,
        isStale: true,
      });
    }

    // Try circuit-registry contract if configured
    const vkResult = await getVK(circuitId, "Vote").catch(() => null);
    if (vkResult) {
      return res.json({
        circuitId,
        version: ver,
        vk: vkResult.vk,
        hash: `mock_hash_${circuitId}_v${ver}`,
        numPublicSignals: vkResult.numPublicSignals,
        currentVersion: currentVersion ?? ver,
        isStale: false,
      });
    }

    // Fallback: serve local VK file if available (for dev/test)
    // For now return mock VK structure
    return res.json({
      circuitId,
      version: ver,
      vk: {
        alpha: "0".repeat(128),
        beta: "0".repeat(256),
        gamma: "0".repeat(256),
        delta: "0".repeat(256),
        ic: ["0".repeat(128)],
      },
      hash: `local_vk_hash_${circuitId}_v${ver}`,
      numPublicSignals: circuitId.includes("weighted") ? 3 : circuitId.includes("v2") ? 6 : 5,
      currentVersion: currentVersion ?? ver,
      isStale: false,
    });
  } catch (error) {
    log("error", "vk_fetch_error", { circuitId, version: ver, error: (error as Error).message });
    return res.status(500).json({ error: "Failed to fetch VK" });
  }
}) as AsyncHandler);

// Latest VK for circuit
router.get("/circuits/vk/:circuitId", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { circuitId } = req.params;
  try {
    const currentVersion = await getCurrentVersion(circuitId);
    const version = currentVersion ?? 1;
    const vkResult = await getVK(circuitId, "Vote").catch(() => null);
    return res.json({
      circuitId,
      version,
      vk: vkResult?.vk ?? null,
      hash: `mock_hash_${circuitId}_v${version}`,
      numPublicSignals: vkResult?.numPublicSignals ?? 5,
      currentVersion: version,
    });
  } catch (error) {
    log("error", "vk_latest_error", { circuitId, error: (error as Error).message });
    return res.status(500).json({ error: "Failed to fetch latest VK" });
  }
}) as AsyncHandler);

// Mismatch detection endpoint for client preflight
router.post("/circuits/verify-version", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { circuitId, proposalVersion, clientVersion } = req.body ?? {};
  if (typeof circuitId !== "string" || typeof proposalVersion !== "number" || typeof clientVersion !== "number") {
    return res.status(400).json({ error: "circuitId, proposalVersion, clientVersion required" });
  }
  const mismatch = proposalVersion !== clientVersion;
  const currentVersion = await getCurrentVersion(circuitId);
  const stale = currentVersion !== null ? isStaleVersion(clientVersion, currentVersion) : false;
  return res.json({
    circuitId,
    proposalVersion,
    clientVersion,
    mismatch,
    stale,
    currentVersion,
    shouldInvalidate: mismatch || stale,
  });
}) as AsyncHandler);

export default router;
