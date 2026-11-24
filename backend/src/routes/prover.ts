import { Router, Request, Response } from "express";
import {
  remoteProverPool,
  ZKV1WitnessRequest,
  QueueSaturationError,
  TenantQuotaExceededError,
  InvalidCircuitArtifactError,
} from "../services/remote-prover-pool.js";
import { log } from "../services/logger.js";

export const proverRoutes = Router();

// POST /prover/jobs - Submit canonical witness for remote Groth16 proving
proverRoutes.post("/prover/jobs", (req: Request, res: Response) => {
  const { circuitId, circuitVersion, witness, electionDeadline, tenantId } = req.body;

  if (!circuitId || typeof circuitId !== "string") {
    return res.status(400).json({ error: "circuitId (string) is required" });
  }

  if (circuitVersion === undefined || typeof circuitVersion !== "number") {
    return res.status(400).json({ error: "circuitVersion (number) is required" });
  }

  if (!witness || typeof witness !== "object") {
    return res.status(400).json({ error: "witness (canonical object) is required" });
  }

  if (!tenantId || typeof tenantId !== "string") {
    return res.status(400).json({ error: "tenantId (string) is required" });
  }

  const request: ZKV1WitnessRequest = {
    circuitId,
    circuitVersion,
    witness,
    electionDeadline: electionDeadline ? Number(electionDeadline) : undefined,
    tenantId,
    requestedBy: (req.headers["x-client-id"] as string) || "api",
  };

  try {
    const jobInfo = remoteProverPool.submitJob(request);
    res.status(202).json(jobInfo);
  } catch (err: any) {
    if (err instanceof QueueSaturationError) {
      res.setHeader("Retry-After", String(err.retryAfterSeconds));
      return res.status(503).json({
        error: err.message,
        retryAfter: err.retryAfterSeconds,
        code: "PROVER_QUEUE_SATURATED",
      });
    }

    if (err instanceof TenantQuotaExceededError) {
      res.setHeader("Retry-After", String(err.retryAfterSeconds));
      return res.status(429).json({
        error: err.message,
        retryAfter: err.retryAfterSeconds,
        code: "TENANT_QUOTA_EXCEEDED",
      });
    }

    if (err instanceof InvalidCircuitArtifactError) {
      return res.status(400).json({
        error: err.message,
        code: "INVALID_CIRCUIT_ARTIFACT",
      });
    }

    log("error", "prover_submission_error", { error: err.message });
    res.status(500).json({ error: "Internal prover error", details: err.message });
  }
});

// GET /prover/jobs/:jobId - Query job status, progress %, and proof result
proverRoutes.get("/prover/jobs/:jobId", (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = remoteProverPool.getJob(jobId);

  if (!job) {
    return res.status(404).json({ error: "Prover job not found" });
  }

  res.json({
    id: job.id,
    circuitId: job.request.circuitId,
    circuitVersion: job.request.circuitVersion,
    status: job.status,
    progressPercent: job.progressPercent,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    result: job.result,
    error: job.error,
  });
});

// POST /prover/jobs/:jobId/cancel - Cancel in-flight or queued job
proverRoutes.post("/prover/jobs/:jobId/cancel", (req: Request, res: Response) => {
  const { jobId } = req.params;
  const cancelled = remoteProverPool.cancelJob(jobId);

  if (!cancelled) {
    return res.status(400).json({
      error: "Job cannot be cancelled (either not found, or already completed/failed)",
    });
  }

  res.json({ success: true, jobId, status: "cancelled" });
});

// GET /prover/health - Worker pool health, queue depth, capacity
proverRoutes.get("/prover/health", (_req: Request, res: Response) => {
  const stats = remoteProverPool.getStats();
  res.json({
    status: stats.queueDepth >= stats.maxQueueDepth ? "saturated" : "healthy",
    ...stats,
  });
});
