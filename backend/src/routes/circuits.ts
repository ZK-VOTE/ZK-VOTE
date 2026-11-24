// @ts-nocheck
import crypto from "crypto";
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
  CircuitRegistryUnavailableError,
  getCompatibilityMatrix,
} from "../services/circuit-registry.js";
import { authGuard, bodyLimit, queryLimiter } from "../middleware/index.js";
import type { AsyncHandler } from "../types/index.js";

const router = Router();

// Register the literal `proposal` routes BEFORE `/:circuitId/:version`, which
// would otherwise shadow them and return a VK for circuitId="proposal".
router.get("/circuits/vk/proposal/dao/:daoId", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { daoId } = req.params;
  try {
    const proposal = await getDaoVkProposal(Number(daoId));
    if (!proposal) return res.status(404).json({ error: "No pending VK proposal for DAO" });
    return res.json(proposal);
  } catch (error) {
    log("error", "dao_vk_proposal_error", { daoId, error: (error as Error).message });
    return res.status(500).json({ error: "Failed to fetch DAO VK proposal" });
  }
}) as AsyncHandler);

router.get("/circuits/vk/proposal/:proposalId", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { proposalId } = req.params;
  try {
    const proposal = await getVkProposal(Number(proposalId));
    if (!proposal) return res.status(404).json({ error: "VK proposal not found" });
    return res.json(proposal);
  } catch (error) {
    log("error", "vk_proposal_error", { proposalId, error: (error as Error).message });
    return res.status(500).json({ error: "Failed to fetch VK proposal" });
  }
}) as AsyncHandler);

/**
 * GET /circuits/compatibility-matrix - the SDK circuit-compatibility
 * matrix enforcement endpoint (ZV-113 / #953).
 *
 * EPIC-004 promises "SDK version N supports circuits version N and N-1",
 * but until this endpoint existed there was nothing an SDK could check
 * that promise against at runtime - CIRCUIT_COMPATIBILITY in
 * packages/sdk/src/version.ts was a static, offline table. This returns,
 * for every circuit this registry knows about, its current version and
 * the N/N-1 window a client may still use - see
 * packages/sdk/src/registry.ts (`createHttpRegistryClient`) and
 * packages/sdk/src/version.ts (`checkCircuitVersion`) for the consumer
 * side, and scripts/ci/verify-sdk-compatibility-matrix.mjs for the CI
 * check that runs this on every release. The matrix-building logic itself
 * lives in circuit-registry.ts's `getCompatibilityMatrix()`, which is
 * unit-tested directly (test/di/circuit-registry.test.ts) without going
 * through this route.
 */
router.get("/circuits/compatibility-matrix", queryLimiter, (async (
  _req: Request,
  res: Response,
) => {
  try {
    const matrix = await getCompatibilityMatrix();
    res.json({ matrix, generatedAt: new Date().toISOString() });
  } catch (error) {
    log("error", "compatibility_matrix_error", {
      error: (error as Error).message,
    });
    res.status(500).json({ error: "Failed to build compatibility matrix" });
  }
}) as AsyncHandler);

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

function requestedCircuitType(req: Request): "Vote" | "Comment" {
  const raw = String(req.query.type ?? "vote").toLowerCase();
  return raw === "comment" ? "Comment" : "Vote";
}

/**
 * Versioned VK API. The contract is the only source of truth: there is no mock
 * hash and no all-zero fallback. Stale versions get 410 so clients invalidate
 * their cache; unavailable registry fails closed with 503.
 */
router.get("/circuits/vk/:circuitId/:version", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { circuitId, version } = req.params;
  const ver = parseInt(version, 10);
  if (isNaN(ver) || ver < 1) {
    return res.status(400).json({ error: "Invalid version" });
  }
  const circuitType = requestedCircuitType(req);

  try {
    const currentVersion = await getCurrentVersion(circuitId);
    if (currentVersion === null) {
      return res.status(503).json({ error: "Circuit registry unavailable" });
    }
    if (isStaleVersion(ver, currentVersion)) {
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
    if (ver > currentVersion) {
      return res.status(404).json({ error: "VK version not yet published" });
    }

    const vkResult = await getVK(circuitId, circuitType);
    if (!vkResult) {
      return res.status(503).json({ error: "Circuit registry unavailable" });
    }
    // Cannot happen after the checks above, but keeps the invariant explicit.
    if (vkResult.version !== ver) {
      return res.status(410).json({
        error: "Stale VK version",
        circuitId,
        requestedVersion: ver,
        currentVersion: vkResult.version,
        isStale: true,
      });
    }
    return res.json({
      circuitId,
      circuitType,
      version: ver,
      vk: vkResult.vk,
      hash: vkResult.hash,
      hashScheme: "registry-v1",
      numPublicSignals: vkResult.numPublicSignals,
      currentVersion,
      isStale: false,
    });
  } catch (error) {
    const unavailable = error instanceof CircuitRegistryUnavailableError;
    log("error", "vk_fetch_error", {
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
    if (unavailable) {
      return res.status(503).json({ error: "Circuit registry unavailable" });
    }
    return res.status(500).json({ error: "Failed to fetch VK" });
  }
}) as AsyncHandler);

// Latest VK for circuit — resolved from the on-chain version counter.
router.get("/circuits/vk/:circuitId", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { circuitId } = req.params;
  const circuitType = requestedCircuitType(req);
  try {
    const currentVersion = await getCurrentVersion(circuitId);
    if (currentVersion === null) {
      return res.status(503).json({ error: "Circuit registry unavailable" });
    }
    const vkResult = await getVK(circuitId, circuitType);
    if (!vkResult) {
      return res.status(503).json({ error: "Circuit registry unavailable" });
    }
    return res.json({
      circuitId,
      circuitType,
      version: currentVersion,
      vk: vkResult.vk,
      hash: vkResult.hash,
      hashScheme: "registry-v1",
      numPublicSignals: vkResult.numPublicSignals,
      currentVersion,
    });
  } catch (error) {
    const unavailable = error instanceof CircuitRegistryUnavailableError;
    log("error", "vk_latest_error", {
      circuitId,
      error: (error as Error).message,
    });
    return res.status(unavailable ? 503 : 500).json({
      error: unavailable ? "Circuit registry unavailable" : "Failed to fetch latest VK",
    });
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

export default router;
