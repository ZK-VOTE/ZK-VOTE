import { Router, type Request, type Response } from "express";

import { log } from "../services/logger.js";
import {
  getCircuitInfo,
  getDaoMigration,
  getDaoCurrentCircuit,
  getVK,
  getCurrentVersion,
  isStaleVersion,
  proposeVkUpgrade,
  approveVkUpgrade,
  executeVkUpgrade,
  cancelVkUpgrade,
  getVkProposal,
  getDaoVkProposal,
} from "../services/circuit-registry.js";
import { bodyLimit, queryLimiter } from "../middleware/index.js";
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

  // Circuit type is a strict enum (vote | comment) — anything else is a
  // client error rather than silently defaulting to the vote circuit.
  // Comparison is case-insensitive so existing capitalized callers keep
  // working.
  const normalizedType = type.toLowerCase();
  if (normalizedType !== "vote" && normalizedType !== "comment") {
    return res.status(400).json({ error: "Invalid circuit type" });
  }

  const circuitType = normalizedType === "comment" ? "Comment" : "Vote";

  try {
    log("info", "circuit_status_request", { daoId, circuitType });

    const currentCircuit = await getDaoCurrentCircuit(daoId, circuitType);
    const migration = await getDaoMigration(daoId);
    const pendingVkProposal = await getDaoVkProposal(daoId);

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
      pendingVkProposal: pendingVkProposal ?? undefined,
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
      log("warn", "stale_vk_rejected", {
        circuitId,
        requested: ver,
        current: currentVersion,
      });
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
      numPublicSignals: circuitId.includes("weighted")
        ? 3
        : circuitId.includes("v2")
          ? 6
          : 5,
      currentVersion: currentVersion ?? ver,
      isStale: false,
    });
  } catch (error) {
    log("error", "vk_fetch_error", {
      circuitId,
      version: ver,
      error: (error as Error).message,
    });
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
    log("error", "vk_latest_error", {
      circuitId,
      error: (error as Error).message,
    });
    return res.status(500).json({ error: "Failed to fetch latest VK" });
  }
}) as AsyncHandler);

// Mismatch detection endpoint for client preflight
router.post("/circuits/verify-version", bodyLimit("5kb"), queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { circuitId, proposalVersion, clientVersion } = req.body ?? {};
  if (
    typeof circuitId !== "string" ||
    typeof proposalVersion !== "number" ||
    typeof clientVersion !== "number"
  ) {
    return res
      .status(400)
      .json({ error: "circuitId, proposalVersion, clientVersion required" });
  }
  const mismatch = proposalVersion !== clientVersion;
  const currentVersion = await getCurrentVersion(circuitId);
  const stale =
    currentVersion !== null
      ? isStaleVersion(clientVersion, currentVersion)
      : false;
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

// Propose a VK upgrade (timelock + multi-sig)
router.post("/circuits/vk/propose", authGuard, queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const {
    circuitId,
    circuitType,
    newVk,
    newWasmHash,
    timelockDuration,
    requiredApprovals,
    daoId,
  } = req.body ?? {};
  if (
    typeof circuitId !== "string" ||
    typeof circuitType !== "string" ||
    !newVk ||
    typeof newWasmHash !== "string" ||
    typeof timelockDuration !== "number" ||
    typeof requiredApprovals !== "number"
  ) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const proposalId = await proposeVkUpgrade({
      circuitId,
      circuitType: circuitType === "Comment" ? "Comment" : "Vote",
      newVk,
      newWasmHash,
      timelockDuration,
      requiredApprovals,
      daoId: typeof daoId === "number" ? daoId : undefined,
      proposer: req.user?.address ?? "",
    });
    return res.json({ proposalId });
  } catch (error) {
    log("error", "vk_propose_error", { error: (error as Error).message });
    return res.status(500).json({ error: "Failed to propose VK upgrade" });
  }
}) as AsyncHandler);

// Approve a VK proposal
router.post("/circuits/vk/:proposalId/approve", authGuard, queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { proposalId } = req.params;
  try {
    await approveVkUpgrade(Number(proposalId), req.user?.address ?? "");
    return res.json({ success: true });
  } catch (error) {
    log("error", "vk_approve_error", { proposalId, error: (error as Error).message });
    return res.status(500).json({ error: "Failed to approve VK proposal" });
  }
}) as AsyncHandler);

// Execute a VK proposal (after timelock + quorum)
router.post("/circuits/vk/:proposalId/execute", authGuard, queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { proposalId } = req.params;
  try {
    await executeVkUpgrade(Number(proposalId), req.user?.address ?? "");
    return res.json({ success: true });
  } catch (error) {
    log("error", "vk_execute_error", { proposalId, error: (error as Error).message });
    return res.status(500).json({ error: "Failed to execute VK proposal" });
  }
}) as AsyncHandler);

// Cancel a VK proposal
router.post("/circuits/vk/:proposalId/cancel", authGuard, queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { proposalId } = req.params;
  try {
    await cancelVkUpgrade(Number(proposalId), req.user?.address ?? "");
    return res.json({ success: true });
  } catch (error) {
    log("error", "vk_cancel_error", { proposalId, error: (error as Error).message });
    return res.status(500).json({ error: "Failed to cancel VK proposal" });
  }
}) as AsyncHandler);

// Get VK proposal details
router.get("/circuits/vk/proposal/:proposalId", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { proposalId } = req.params;
  try {
    const proposal = await getVkProposal(Number(proposalId));
    if (!proposal) {
      return res.status(404).json({ error: "VK proposal not found" });
    }
    return res.json(proposal);
  } catch (error) {
    log("error", "vk_proposal_error", { proposalId, error: (error as Error).message });
    return res.status(500).json({ error: "Failed to fetch VK proposal" });
  }
}) as AsyncHandler);

// Get DAO's pending VK proposal
router.get("/circuits/vk/proposal/dao/:daoId", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { daoId } = req.params;
  try {
    const proposal = await getDaoVkProposal(Number(daoId));
    if (!proposal) {
      return res.status(404).json({ error: "No pending VK proposal for DAO" });
    }
    return res.json(proposal);
  } catch (error) {
    log("error", "dao_vk_proposal_error", { daoId, error: (error as Error).message });
    return res.status(500).json({ error: "Failed to fetch DAO VK proposal" });
  }
}) as AsyncHandler);

export default router;
