/**
 * DAO Factory operator API (EPIC-005).
 *
 * Create/status/resume use normal auth; cancel and compensation-plan reads are
 * operator-only (master key) because they mutate externally deployed contracts.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { log } from "../services/logger.js";
import { factoryOrchestrator } from "../services/factory-orchestrator.js";
import {
  authGuard,
  masterKeyGuard,
  bodyLimit,
  queryLimiter,
  validateBody,
  validateParams,
} from "../middleware/index.js";
import type { AsyncHandler } from "../types/index.js";

const router = Router();

const createSchema = z.object({
  name: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_-]+$/),
  description: z.string().max(4096).default(""),
  creator: z.string().min(1),
  treasuryTier: z.enum(["basic", "standard", "advanced"]).default("basic"),
  initialFunding: z.number().min(100),
  votingPolicy: z
    .object({ quorum: z.number().min(1), passingThreshold: z.number().min(1) })
    .optional(),
  idempotencyKey: z.string().min(8).max(256).optional(),
});

const ticketParams = z.object({ ticketId: z.string().min(1).max(128) });

router.post(
  "/factory/create",
  bodyLimit("16kb"),
  authGuard,
  validateBody(createSchema),
  (async (req: Request, res: Response) => {
    const body = (req as Request & { validatedBody?: z.infer<typeof createSchema> })
      .validatedBody ?? req.body;
    const ticketId = await factoryOrchestrator.createDAO(
      {
        name: body.name,
        description: body.description,
        creator: body.creator,
        treasuryTier: body.treasuryTier,
        initialFunding: body.initialFunding,
        votingPolicy: body.votingPolicy,
      },
      body.idempotencyKey,
    );
    log("info", "factory_create_accepted", { ticketId });
    return res.status(202).json({ ticketId, status: "in_progress" });
  }) as AsyncHandler,
);

router.get(
  "/factory/status/:ticketId",
  queryLimiter,
  validateParams(ticketParams),
  (async (req: Request, res: Response) => {
    const { ticketId } = (req as Request & {
      validatedParams?: z.infer<typeof ticketParams>;
    }).validatedParams!;
    const saga = await factoryOrchestrator.getStatus(ticketId);
    if (!saga) return res.status(404).json({ error: "Saga not found" });
    return res.json(saga);
  }) as AsyncHandler,
);

router.post(
  "/factory/resume/:ticketId",
  authGuard,
  validateParams(ticketParams),
  (async (req: Request, res: Response) => {
    const { ticketId } = (req as Request & {
      validatedParams?: z.infer<typeof ticketParams>;
    }).validatedParams!;
    await factoryOrchestrator.resume(ticketId);
    return res.json({ ticketId, status: "resumed" });
  }) as AsyncHandler,
);

// Operator-only: cancel and compensate a partially created DAO.
router.post(
  "/factory/cancel/:ticketId",
  masterKeyGuard,
  validateParams(ticketParams),
  (async (req: Request, res: Response) => {
    const { ticketId } = (req as Request & {
      validatedParams?: z.infer<typeof ticketParams>;
    }).validatedParams!;
    const plan = await factoryOrchestrator.cancel(ticketId);
    log("warn", "factory_cancelled", { ticketId, actions: plan.length });
    return res.json({ ticketId, status: "compensated", compensationPlan: plan });
  }) as AsyncHandler,
);

router.get(
  "/factory/plan/:ticketId",
  masterKeyGuard,
  validateParams(ticketParams),
  (async (req: Request, res: Response) => {
    const { ticketId } = (req as Request & {
      validatedParams?: z.infer<typeof ticketParams>;
    }).validatedParams!;
    return res.json({
      ticketId,
      compensationPlan: factoryOrchestrator.getCompensationPlan(ticketId),
    });
  }) as AsyncHandler,
);

export default router;
