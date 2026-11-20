/**
 * Onboarding Funnel Routes (ZV-108)
 *
 * - POST /onboarding/funnel - record that a client reached a funnel step
 * - GET  /onboarding/funnel/summary - aggregate counts + per-step drop-off
 *
 * See backend/src/services/onboardingFunnel.ts for the privacy rationale:
 * only aggregate counters are ever stored, never a per-session record.
 */

import { Router, type Request, type Response } from "express";
import { log } from "../services/logger.js";
import {
  recordFunnelStep,
  getFunnelSummary,
} from "../services/onboardingFunnel.js";
import { bodyLimit, queryLimiter, validateBody } from "../middleware/index.js";
import { onboardingFunnelStepSchema } from "../validation/schemas.js";
import type { AsyncHandler } from "../types/index.js";

const router = Router();

router.post(
  "/onboarding/funnel",
  bodyLimit("1kb"),
  queryLimiter,
  validateBody(onboardingFunnelStepSchema),
  (async (req: Request, res: Response) => {
    const { step } = req.body;
    try {
      await recordFunnelStep(step);
      res.status(204).end();
    } catch (err) {
      log("error", "onboarding_funnel_record_error", {
        step,
        error: (err as Error).message,
      });
      // Best-effort telemetry: never fail the caller's onboarding flow.
      res.status(204).end();
    }
  }) as AsyncHandler,
);

router.get(
  "/onboarding/funnel/summary",
  queryLimiter,
  (async (_req: Request, res: Response) => {
    try {
      const summary = await getFunnelSummary();
      res.json({ steps: summary });
    } catch (err) {
      log("error", "onboarding_funnel_summary_error", {
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to load funnel summary" });
    }
  }) as AsyncHandler,
);

export default router;
