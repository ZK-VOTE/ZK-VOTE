/**
 * Nova Recursive Aggregation API Routes
 */

import { Router, Request, Response } from "express";
import {
  novaAggregatorService,
  RecursiveProofPayload,
  VoteWitnessPayload,
} from "../services/nova-aggregator.js";
import { bodyLimit, validateBody } from "../middleware/index.js";
import { novaAggregateSchema } from "../validation/schemas.js";

const router = Router();

/**
 * POST /api/v1/nova/aggregate
 * Trigger off-chain Nova IVC vote proof aggregation for an election batch
 */
router.post(
  "/aggregate",
  bodyLimit("100kb"),
  validateBody(novaAggregateSchema),
  async (req: Request, res: Response) => {
    try {
      const { daoId, proposalId, root, witnesses } = req.body;

      const payload = await novaAggregatorService.aggregateVotes(
        Number(daoId),
        Number(proposalId),
        root ||
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        witnesses as VoteWitnessPayload[],
      );

      return res.status(200).json({
        success: true,
        message: `Successfully aggregated ${payload.num_votes} votes using Nova IVC`,
        data: payload,
      });
    } catch (error: any) {
      console.error("[NovaRoute Error]:", error);
      return res.status(500).json({
        error: error.message || "Internal Nova aggregation error",
      });
    }
  },
);

/**
 * POST /api/v1/nova/verify
 * Verify a previously generated Nova recursive proof
 */
router.post(
  "/verify",
  bodyLimit("100kb"),
  async (req: Request, res: Response) => {
    try {
      const payload = req.body as RecursiveProofPayload;

      if (
        !payload ||
        !payload.proof_bytes ||
        !payload.initial_state ||
        !payload.final_state
      ) {
        return res.status(400).json({
          error:
            "Invalid payload. proof_bytes, initial_state, and final_state are required.",
        });
      }

      const result = await novaAggregatorService.verifyProof(payload);

      return res.status(200).json({
        success: true,
        verified: result.verified,
      });
    } catch (error: any) {
      console.error("[NovaRoute Verify Error]:", error);
      return res.status(500).json({
        error: error.message || "Internal Nova verification error",
      });
    }
  },
);

export default router;
