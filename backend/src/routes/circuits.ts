// @ts-nocheck
import { Router, type Request, type Response } from "express";

import { log } from "../services/logger.js";
import {
  getCircuitInfo,
  getDaoMigration,
  getDaoCurrentCircuit,
  getCurrentVersion,
  isStaleVersion,
  resolveVk,
  invalidateVkCache,
  invalidateVersionCache,
  CircuitRegistryUnavailableError,
  StaleVkError,
  proposeVkUpgrade,
  approveVkUpgrade,
  executeVkUpgrade,
  cancelVkUpgrade,
  getVkProposal,
  getDaoVkProposal,
} from "../services/circuit-registry.js";
import { authGuard, bodyLimit, queryLimiter } from "../middleware/index.js";
import type { AsyncHandler } from "../types/index.js";

const router = Router();

/** Circuit type is a strict enum; unknown values fall back to Vote. */
function normalizeCircuitType(value: unknown): "Vote" | "Comment" {
  if (typeof value !== "string") return "Vote";
  const normalized = value.toLowerCase();
  return normalized === "comment" ? "Comment" : "Vote";
}

function optionalDaoId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Build the binding clients send alongside witness generation + proof verification. */
function circuitBinding(result: {
  circuitId: string;
  circuitType: "Vote" | "Comment";
  version: number;
  numPublicSignals: number;
  hash: string;
  ceremonyTranscriptHash?: string;
  daoId?: number;
}) {
  return {
    circuitId: result.circuitId,
    circuitType: result.circuitType,
    version: result.version,
    numPublicSignals: result.numPublicSignals,
    hash: result.hash,
    ceremonyTranscriptHash: result.ceremonyTranscriptHash ?? null,
    daoId: result.daoId ?? null,
  };
}

/** Map fail-closed registry errors to JSON status codes. */
function registryError(res: Response, error: unknown, context: string): Response {
  if (error instanceof StaleVkError) {
    return res.status(410).json({
      error: "Stale VK version",
      code: error.code,
      circuitId: error.circuitId,
      requestedVersion: error.requestedVersion,
      currentVersion: error.currentVersion,
      isStale: true,
    });
  }
  if (error instanceof CircuitRegistryUnavailableError) {
    return res.status(503).json({
      error: "Circuit registry unavailable",
      code: error.code,
      detail: error.message,
    });
  }
  log("error", context, { error: (error as Error).message });
  return res.status(500).json({ error: "Failed to resolve circuit VK" });
}

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

  const circuitType = normalizeCircuitType(req.query.circuitType);
  const daoId = optionalDaoId(req.query.daoId);

  try {
    const resolved = await resolveVk({
      daoId,
      circuitId,
      circuitType,
      version: ver,
    });
    log("info", "vk_resolved", {
      circuitId,
      version: ver,
      source: resolved.source,
      hash: resolved.hash,
    });
    return res.json({
      circuitId: resolved.circuitId,
      circuitType: resolved.circuitType,
      version: resolved.version,
      vk: resolved.vk,
      hash: resolved.hash,
      numPublicSignals: resolved.numPublicSignals,
      currentVersion: resolved.currentVersion,
      ceremonyTranscriptHash: resolved.ceremonyTranscriptHash ?? null,
      circuitBinding: circuitBinding(resolved),
      source: resolved.source,
      isStale: false,
    });
  } catch (error) {
    if (error instanceof StaleVkError) {
      log("warn", "stale_vk_rejected", {
        circuitId,
        requested: ver,
        current: error.currentVersion,
      });
    }
    return registryError(res, error, "vk_fetch_error");
  }
}) as AsyncHandler);

// Latest VK for circuit
router.get("/circuits/vk/:circuitId", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { circuitId } = req.params;
  const circuitType = normalizeCircuitType(req.query.circuitType);
  const daoId = optionalDaoId(req.query.daoId);
  try {
    const resolved = await resolveVk({ daoId, circuitId, circuitType });
    return res.json({
      circuitId: resolved.circuitId,
      circuitType: resolved.circuitType,
      version: resolved.version,
      vk: resolved.vk,
      hash: resolved.hash,
      numPublicSignals: resolved.numPublicSignals,
      currentVersion: resolved.currentVersion,
      ceremonyTranscriptHash: resolved.ceremonyTranscriptHash ?? null,
      circuitBinding: circuitBinding(resolved),
      source: resolved.source,
    });
  } catch (error) {
    return registryError(res, error, "vk_latest_error");
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
  const circuitType = normalizeCircuitType(req.body?.circuitType);
  const daoId = optionalDaoId(req.body?.daoId);

  try {
    // Rotation observation via polling: if the DAO's proposal has executed,
    // drop cached VKs before answering the client's preflight check.
    if (daoId !== undefined) {
      const proposal = await getDaoVkProposal(daoId).catch(() => null);
      if (proposal?.status === "Executed") {
        invalidateVkCache({
          daoId,
          circuitId: proposal.circuitId,
          circuitType: proposal.circuitType,
        });
        invalidateVersionCache(proposal.circuitId);
        log("info", "vk_rotation_observed", {
          daoId,
          circuitId: proposal.circuitId,
          proposalId: proposal.id,
        });
      }
    }

    const currentVersion = await getCurrentVersion(circuitId, circuitType);
    const mismatch = proposalVersion !== clientVersion;
    const stale = isStaleVersion(clientVersion, currentVersion);

    let resolved = null;
    if (!stale) {
      resolved = await resolveVk({
        daoId,
        circuitId,
        circuitType,
        version: clientVersion,
      });
    }

    return res.json({
      circuitId,
      circuitType,
      proposalVersion,
      clientVersion,
      mismatch,
      stale,
      currentVersion,
      shouldInvalidate: mismatch || stale,
      hash: resolved?.hash ?? null,
      circuitBinding: resolved ? circuitBinding(resolved) : null,
    });
  } catch (error) {
    return registryError(res, error, "verify_version_error");
  }
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
    const proposal = await getVkProposal(Number(proposalId)).catch(() => null);
    await executeVkUpgrade(Number(proposalId), req.user?.address ?? "");
    if (proposal) {
      invalidateVkCache({
        daoId: proposal.daoId,
        circuitId: proposal.circuitId,
        circuitType: proposal.circuitType,
      });
      invalidateVersionCache(proposal.circuitId);
    }
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
