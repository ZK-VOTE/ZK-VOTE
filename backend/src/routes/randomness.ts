/**
 * VDF + Threshold Randomness Routes (Issue #310)
 *
 * Provides verifiable, unbiasable randomness for proposal ordering that:
 *  1. Uses a VDF seeded from election parameters to introduce a time-delay
 *     that prevents front-running by the admin.
 *  2. Mixes the VDF output with threshold-RNG contributions from multiple
 *     independent authorities so that no single party can control the seed.
 *  3. Exposes a deterministic, replay-safe ordering endpoint that maps a
 *     set of proposal IDs to a random permutation.
 *
 * Endpoints:
 *  POST /randomness/seed         – Compute VDF seed for a DAO/proposal set
 *  POST /randomness/contribute   – Submit a threshold-RNG share
 *  POST /randomness/finalize     – Combine shares → final seed, return ordering
 *  GET  /randomness/ordering/:daoId – Fetch the committed proposal ordering
 *  GET  /randomness/verify/:daoId   – Verify stored ordering is reproducible
 */

import { Router, type Request, type Response } from "express";
import crypto from "crypto";

import { log } from "../services/logger.js";
import {
  authGuard,
  auditLog,
  bodyLimit,
  queryLimiter,
  validateParams,
  validateBody,
} from "../middleware/index.js";
import {
  computeVdf,
  verifyVdf,
  deriveVdfInput,
  DEFAULT_VDF_ITERATIONS,
  MIN_VDF_ITERATIONS,
  MAX_VDF_ITERATIONS,
} from "../services/vdf.js";
import { daoParamsSchema } from "../validation/schemas.js";
import type { AsyncHandler } from "../types/index.js";
import { z } from "zod";

const router = Router();

// ─── In-memory store (replace with DB-backed store in production) ────────────
// keyed by `${daoId}` → OrderingState

interface ThresholdShare {
  authorityId: string;
  shareHex: string;
  submittedAt: number;
}

interface OrderingState {
  daoId: number;
  /** VDF input seed (hex) derived from dao_id + proposalIds + blockHash */
  vdfInput: string;
  /** VDF output (hex) – empty until finalized */
  vdfOutput: string;
  /** VDF checkpoints for verification */
  vdfCheckpoints: string[];
  vdfIterations: number;
  /** Threshold shares submitted by authorities */
  shares: ThresholdShare[];
  /** Required number of shares before finalization */
  requiredShares: number;
  /** Combined randomness seed (hex) – empty until finalized */
  combinedSeed: string;
  /** Final proposal ordering (array of proposal IDs) */
  ordering: number[];
  /** Input proposal IDs that were ordered */
  proposalIds: number[];
  /** Unix timestamp (ms) when the ordering was finalized */
  finalizedAt: number | null;
  /** Replay-safety nonce: SHA256(daoId || proposalIds || vdfOutput) */
  replayNonce: string;
  /** Whether this state has been committed (immutable) */
  committed: boolean;
}

const orderingStore = new Map<number, OrderingState>();

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const seedBodySchema = z.object({
  daoId: z.number().int().positive(),
  proposalIds: z.array(z.number().int().positive()).min(1).max(500),
  /** Optional: hex-encoded block hash for additional entropy (32 bytes = 64 hex chars) */
  blockHashHex: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "Must be 64 hex chars")
    .optional(),
  /** Optional: admin-provided entropy seed (hex, 32 bytes = 64 hex chars) */
  adminSeedHex: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "Must be 64 hex chars")
    .optional(),
  /** Number of VDF iterations (delay parameter) */
  iterations: z
    .number()
    .int()
    .min(MIN_VDF_ITERATIONS)
    .max(MAX_VDF_ITERATIONS)
    .default(DEFAULT_VDF_ITERATIONS),
  /** Required threshold share count before finalization */
  requiredShares: z.number().int().min(1).max(32).default(1),
});

const contributeBodySchema = z.object({
  daoId: z.number().int().positive(),
  authorityId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, "alphanumeric, dash, underscore only"),
  /** 32-byte hex entropy share from this authority */
  shareHex: z.string().regex(/^[0-9a-fA-F]{64}$/, "Must be 64 hex chars"),
});

const finalizeBodySchema = z.object({
  daoId: z.number().int().positive(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive a stable, sorted, unique proposal list from the input IDs.
 * Deduplication prevents trivial manipulation by repeating proposal IDs.
 */
function normalizeProposalIds(ids: number[]): number[] {
  return Array.from(new Set(ids)).sort((a, b) => a - b);
}

/**
 * Fisher-Yates shuffle seeded by a deterministic hex seed.
 * Produces a stable ordering given the same seed + proposalIds.
 */
function seededShuffle(ids: number[], seedHex: string): number[] {
  const arr = [...ids];
  const n = arr.length;

  // Use successive SHA256 hashes of the seed for sub-randomness at each step
  let state = Buffer.from(seedHex, "hex");

  for (let i = n - 1; i > 0; i--) {
    // Derive a uniform index in [0, i]
    state = crypto.createHash("sha256").update(state).digest();
    // Use first 4 bytes as a 32-bit big-endian unsigned int
    const rand = state.readUInt32BE(0);
    const j = rand % (i + 1);
    // Swap
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr;
}

/**
 * Compute the replay-safety nonce:
 *   SHA256( daoId_BE || proposalIds_sorted || vdfOutput )
 *
 * Any change to inputs produces a different nonce, preventing an adversary
 * from replaying an ordering for a different election.
 */
function computeReplayNonce(
  daoId: number,
  proposalIds: number[],
  vdfOutput: string,
): string {
  const daoIdBuf = Buffer.alloc(8);
  daoIdBuf.writeBigUInt64BE(BigInt(daoId));
  const propsBuf = Buffer.from(proposalIds.join(","));
  const vdfBuf = Buffer.from(vdfOutput, "hex");
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([daoIdBuf, propsBuf, vdfBuf]))
    .digest("hex");
}

/**
 * XOR-mix an array of 32-byte hex shares together.
 * The result is only predictable if an adversary controls ALL shares.
 */
function combineShares(shareHexes: string[]): string {
  if (shareHexes.length === 0) return crypto.randomBytes(32).toString("hex");
  const combined = Buffer.from(shareHexes[0], "hex");
  for (let i = 1; i < shareHexes.length; i++) {
    const share = Buffer.from(shareHexes[i], "hex");
    for (let j = 0; j < 32; j++) combined[j] ^= share[j];
  }
  return combined.toString("hex");
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /randomness/seed
 *
 * Step 1: Compute the VDF output for a DAO/proposal set. This binds the
 * randomness to the specific election and introduces a mandatory time delay
 * that prevents admin front-running.
 *
 * Auth: required (DAO admin action)
 */
router.post(
  "/randomness/seed",
  bodyLimit("32kb"),
  authGuard,
  auditLog("randomness_seed"),
  validateBody(seedBodySchema),
  (async (req: Request, res: Response) => {
    const {
      daoId,
      proposalIds,
      blockHashHex,
      adminSeedHex,
      iterations,
      requiredShares,
    } = (req as any).validatedBody as z.infer<typeof seedBodySchema>;

    try {
      if (orderingStore.has(daoId) && orderingStore.get(daoId)!.committed) {
        return res.status(409).json({
          error: "Ordering for this DAO is already committed and immutable",
        });
      }

      const normalizedIds = normalizeProposalIds(proposalIds);

      // Derive a deterministic VDF input that binds to: dao, proposals, block hash, admin seed
      const blockHash =
        blockHashHex ?? crypto.randomBytes(32).toString("hex");
      const adminSeed =
        adminSeedHex ?? crypto.randomBytes(32).toString("hex");

      // First proposal ID is used as a pseudo-proposal-ID for vdf input derivation
      const vdfInput = deriveVdfInput(
        daoId,
        normalizedIds[0] ?? 0,
        blockHash,
        adminSeed,
      );

      log("info", "randomness_vdf_start", { daoId, iterations });

      const { output: vdfOutput, checkpoints } = computeVdf(
        vdfInput,
        iterations,
      );

      // Compute replay nonce (before shares are mixed in)
      const replayNonce = computeReplayNonce(daoId, normalizedIds, vdfOutput);

      const state: OrderingState = {
        daoId,
        vdfInput,
        vdfOutput,
        vdfCheckpoints: checkpoints,
        vdfIterations: iterations,
        shares: [],
        requiredShares,
        combinedSeed: "",
        ordering: [],
        proposalIds: normalizedIds,
        finalizedAt: null,
        replayNonce,
        committed: false,
      };

      orderingStore.set(daoId, state);

      log("info", "randomness_vdf_done", {
        daoId,
        vdfInput: vdfInput.slice(0, 16) + "...",
        vdfOutput: vdfOutput.slice(0, 16) + "...",
        checkpointCount: checkpoints.length,
      });

      res.json({
        success: true,
        daoId,
        vdfInput: vdfInput.slice(0, 16) + "...",
        vdfOutput: vdfOutput.slice(0, 16) + "...",
        iterations,
        replayNonce,
        checkpointCount: checkpoints.length,
        requiredShares,
        sharesReceived: 0,
        status: "awaiting_shares",
      });
    } catch (err) {
      log("error", "randomness_seed_failed", {
        daoId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to compute VDF seed" });
    }
  }) as AsyncHandler,
);

/**
 * POST /randomness/contribute
 *
 * Step 2 (repeated per authority): An independent authority submits their
 * 32-byte random share. Once `requiredShares` shares are received, the
 * ordering can be finalized.
 *
 * Auth: required
 */
router.post(
  "/randomness/contribute",
  bodyLimit("8kb"),
  authGuard,
  auditLog("randomness_contribute"),
  validateBody(contributeBodySchema),
  (async (req: Request, res: Response) => {
    const { daoId, authorityId, shareHex } = (req as any)
      .validatedBody as z.infer<typeof contributeBodySchema>;

    try {
      const state = orderingStore.get(daoId);
      if (!state) {
        return res.status(404).json({
          error:
            "No pending randomness computation for this DAO. Call /randomness/seed first.",
        });
      }
      if (state.committed) {
        return res.status(409).json({
          error: "Ordering is already committed and immutable",
        });
      }
      if (state.finalizedAt !== null) {
        return res.status(409).json({
          error: "Ordering is already finalized",
        });
      }

      // Prevent duplicate contributions
      if (state.shares.some((s) => s.authorityId === authorityId)) {
        return res.status(409).json({
          error: `Authority ${authorityId} has already submitted a share`,
        });
      }

      state.shares.push({ authorityId, shareHex, submittedAt: Date.now() });

      log("info", "randomness_share_received", {
        daoId,
        authorityId,
        sharesCount: state.shares.length,
        requiredShares: state.requiredShares,
      });

      res.json({
        success: true,
        daoId,
        authorityId,
        sharesReceived: state.shares.length,
        requiredShares: state.requiredShares,
        ready: state.shares.length >= state.requiredShares,
        status:
          state.shares.length >= state.requiredShares
            ? "ready_to_finalize"
            : "awaiting_shares",
      });
    } catch (err) {
      log("error", "randomness_contribute_failed", {
        daoId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to record contribution" });
    }
  }) as AsyncHandler,
);

/**
 * POST /randomness/finalize
 *
 * Step 3: Combine VDF output with threshold shares → final seed → ordering.
 * Once finalized, the state is committed (immutable). Subsequent calls return
 * the stored ordering.
 *
 * Auth: required
 */
router.post(
  "/randomness/finalize",
  bodyLimit("4kb"),
  authGuard,
  auditLog("randomness_finalize"),
  validateBody(finalizeBodySchema),
  (async (req: Request, res: Response) => {
    const { daoId } = (req as any).validatedBody as z.infer<
      typeof finalizeBodySchema
    >;

    try {
      const state = orderingStore.get(daoId);
      if (!state) {
        return res.status(404).json({
          error: "No pending randomness computation for this DAO",
        });
      }
      if (state.finalizedAt !== null) {
        // Idempotent – return existing ordering
        return res.json({
          success: true,
          daoId,
          ordering: state.ordering,
          combinedSeed: state.combinedSeed.slice(0, 16) + "...",
          replayNonce: state.replayNonce,
          finalizedAt: state.finalizedAt,
          status: "finalized",
        });
      }
      if (state.shares.length < state.requiredShares) {
        return res.status(400).json({
          error: `Insufficient shares: received ${state.shares.length}, need ${state.requiredShares}`,
        });
      }

      // Combine all authority shares into a single random contribution
      const authorityContribution = combineShares(
        state.shares.map((s) => s.shareHex),
      );

      // Mix VDF output with threshold contribution:
      //   finalSeed = SHA256( vdfOutput || authorityContribution )
      // The VDF prevents precomputation; the threshold mix ensures no single
      // party (including the admin who triggered the VDF) controls the outcome.
      const finalSeedBuf = crypto
        .createHash("sha256")
        .update(Buffer.from(state.vdfOutput, "hex"))
        .update(Buffer.from(authorityContribution, "hex"))
        .digest();

      state.combinedSeed = finalSeedBuf.toString("hex");
      state.ordering = seededShuffle(state.proposalIds, state.combinedSeed);
      state.finalizedAt = Date.now();
      state.committed = true;

      log("info", "randomness_finalized", {
        daoId,
        proposalCount: state.proposalIds.length,
        combinedSeed: state.combinedSeed.slice(0, 16) + "...",
        replayNonce: state.replayNonce,
      });

      res.json({
        success: true,
        daoId,
        ordering: state.ordering,
        combinedSeed: state.combinedSeed.slice(0, 16) + "...",
        replayNonce: state.replayNonce,
        finalizedAt: state.finalizedAt,
        status: "finalized",
      });
    } catch (err) {
      log("error", "randomness_finalize_failed", {
        daoId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to finalize ordering" });
    }
  }) as AsyncHandler,
);

/**
 * GET /randomness/ordering/:daoId
 *
 * Retrieve the committed proposal ordering for a DAO.
 * Returns the ordering along with enough data for independent verification.
 *
 * Auth: public (rate-limited)
 */
router.get(
  "/randomness/ordering/:daoId",
  queryLimiter,
  validateParams(daoParamsSchema),
  (async (req: Request, res: Response) => {
    const { daoId } = (req as any).validatedParams as { daoId: number };

    try {
      const state = orderingStore.get(daoId);
      if (!state || state.finalizedAt === null) {
        return res.status(404).json({
          error:
            "No finalized ordering found for this DAO. Ordering may not have been computed yet.",
        });
      }

      res.json({
        daoId,
        ordering: state.ordering,
        proposalIds: state.proposalIds,
        replayNonce: state.replayNonce,
        vdfIterations: state.vdfIterations,
        checkpointCount: state.vdfCheckpoints.length,
        sharesUsed: state.shares.length,
        finalizedAt: state.finalizedAt,
        committed: state.committed,
        status: "finalized",
      });
    } catch (err) {
      log("error", "randomness_ordering_fetch_failed", {
        daoId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to fetch ordering" });
    }
  }) as AsyncHandler,
);

/**
 * GET /randomness/verify/:daoId
 *
 * Independently verify the stored ordering by:
 *  1. Re-running VDF verification on the stored checkpoints.
 *  2. Re-deriving the replay nonce and comparing it to the stored value.
 *
 * Anyone can verify without re-running the full VDF computation.
 *
 * Auth: public (rate-limited)
 */
router.get(
  "/randomness/verify/:daoId",
  queryLimiter,
  validateParams(daoParamsSchema),
  (async (req: Request, res: Response) => {
    const { daoId } = (req as any).validatedParams as { daoId: number };

    try {
      const state = orderingStore.get(daoId);
      if (!state || state.finalizedAt === null) {
        return res.status(404).json({
          error: "No finalized ordering found for this DAO",
        });
      }

      // 1. Verify the VDF output against stored checkpoints
      const vdfValid = verifyVdf(
        state.vdfInput,
        state.vdfIterations,
        state.vdfOutput,
        state.vdfCheckpoints,
      );

      // 2. Verify replay nonce matches
      const recomputedNonce = computeReplayNonce(
        daoId,
        state.proposalIds,
        state.vdfOutput,
      );
      const nonceValid = recomputedNonce === state.replayNonce;

      // 3. Re-derive the ordering from the combined seed and verify it matches
      const recomputedOrdering = seededShuffle(
        state.proposalIds,
        state.combinedSeed,
      );
      const orderingValid =
        JSON.stringify(recomputedOrdering) === JSON.stringify(state.ordering);

      const allValid = vdfValid && nonceValid && orderingValid;

      log("info", "randomness_verified", {
        daoId,
        vdfValid,
        nonceValid,
        orderingValid,
        allValid,
      });

      res.json({
        daoId,
        valid: allValid,
        checks: {
          vdfOutputValid: vdfValid,
          replayNonceValid: nonceValid,
          orderingValid,
        },
        replayNonce: state.replayNonce,
        finalizedAt: state.finalizedAt,
      });
    } catch (err) {
      log("error", "randomness_verify_failed", {
        daoId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to verify ordering" });
    }
  }) as AsyncHandler,
);

export default router;
