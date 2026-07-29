/**
 * Comment Routes
 *
 * Handles anonymous and public comments with ZK proofs.
 */

import { Router, type Request, type Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";

import { config, isValidContractId } from "../config.js";
import { log } from "../services/logger.js";
import {
  server,
  relayerKeypair,
  callWithTimeout,
  simulateWithBackoff,
  waitForTransaction,
  withSequenceLock,
  u256ToScVal,
  proofToScVal,
} from "../services/stellar.js";
import { verifyMembership } from "../services/sync.js";
import {
  authGuard,
  auditLog,
  commentLimiter,
  queryLimiter,
  validateBody,
  validateParams,
  noteDegraded,
  sendPartial,
  validateQuery,
} from "../middleware/index.js";
import {
  anonymousCommentSchema,
  flagCommentSchema,
  commentParamsSchema,
  proposalParamsSchema,
  commitmentParamsSchema,
  commentCountQuerySchema,
} from "../validation/schemas.js";
import type { AsyncHandler } from "../types/index.js";
import { generateChallenge, verifyChallenge } from "../services/pow.js";
import {
  checkCommitmentRateLimit,
  recordCommentSubmission,
  flagComment,
  getHiddenCommentIds,
} from "../services/anti-spam.js";
import { commentsSubmitted } from "../services/metrics.js";
import {
  markDegraded,
  markHealthy,
  markUnavailable,
  setLkg,
  getLkg,
  commentsLkgKey,
} from "../services/service-health.js";

const router = Router();

/**
 * Real-time membership gate for address-authenticated writes (edit/delete).
 * Anonymous vote/comment paths already get a stronger, real-time guarantee
 * from their ZK merkle-root proof verified on-chain, so this only applies to
 * routes that identify the caller by address. No-op when the Membership SBT
 * contract isn't configured (feature not deployed for this DAO/deployment).
 */
async function enforceCurrentMembership(
  daoId: number,
  address: string,
  res: Response,
  event: string,
): Promise<boolean> {
  if (
    !config.membershipSbtContractId ||
    !isValidContractId(config.membershipSbtContractId)
  ) {
    return true;
  }
  try {
    const isMember = await verifyMembership(daoId, address);
    if (!isMember) {
      log("warn", `${event}_membership_denied`, { daoId });
      res.status(403).json({ error: "Author is not a current DAO member" });
      return false;
    }
    return true;
  } catch (err) {
    log("error", `${event}_membership_check_failed`, {
      daoId,
      error: (err as Error).message,
    });
    res
      .status(503)
      .json({ error: "Membership verification unavailable, please retry" });
    return false;
  }
}

// ============================================
// PROOF-OF-WORK CHALLENGE
// ============================================

/**
 * GET /comment/challenge/:commitment - Get PoW challenge for a commitment
 */
router.get("/comment/challenge/:commitment", queryLimiter, validateParams(commitmentParamsSchema), (async (
  req: Request,
  res: Response,
) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { commitment } = (req as any).validatedParams;

  const challenge = generateChallenge(commitment, {
    difficulty: config.powDifficulty,
    challengeTtlMs: config.powChallengeTtlMs,
  });

  res.json({
    serverId: challenge.serverId,
    difficulty: challenge.difficulty,
    expiresAt: challenge.expiresAt,
  });
}) as AsyncHandler);

// ============================================
// ANONYMOUS COMMENT
// ============================================

/**
 * POST /comment/anonymous - Submit anonymous comment with ZK proof
 */
router.post(
  "/comment/anonymous",
  authGuard,
  auditLog("comment_anonymous_relay"),
  commentLimiter,
  validateBody(anonymousCommentSchema),
  (async (req: Request, res: Response) => {
    // Validated by anonymousCommentSchema middleware
    const {
      daoId,
      proposalId,
      contentCid,
      parentId,
      voteChoice,
      nullifier,
      root,
      proof,
      serverId,
      workNonce,
    } = config.stripRequestBodies ? {} : req.body;

    if (config.powEnabled && !config.testMode) {
      if (serverId && workNonce) {
        const powConfig = {
          difficulty: config.powDifficulty,
          challengeTtlMs: config.powChallengeTtlMs,
        };
        const powResult = verifyChallenge(
          serverId,
          nullifier,
          workNonce,
          powConfig,
        );
        if (!powResult.valid) {
          log("warn", "comment_pow_verification_failed", {
            daoId,
            proposalId,
            reason: powResult.reason,
          });
          return res
            .status(400)
            .json({ error: `PoW verification failed: ${powResult.reason}` });
        }
      } else {
        log("warn", "comment_pow_missing", { daoId, proposalId });
        return res.status(400).json({
          error:
            "PoW challenge required: obtain a challenge via GET /comment/challenge/:commitment",
        });
      }
    }

    if (!config.testMode) {
      const allowed = checkCommitmentRateLimit(
        nullifier,
        daoId,
        proposalId,
        config.commitmentRateLimit,
        config.commitmentRateWindowMs,
      );
      if (!allowed) {
        log("warn", "comment_commitment_rate_limited", {
          daoId,
          proposalId,
          nullifier: nullifier.slice(0, 16),
        });
        return res
          .status(429)
          .json({ error: "Comment rate limit exceeded for this commitment" });
      }
    }

    try {
      log("info", "comment_anonymous_request", { daoId, proposalId });

      const scNullifier = u256ToScVal(nullifier);
      const scRoot = u256ToScVal(root);
      const scProof = proofToScVal(proof);

      const contract = new StellarSdk.Contract(config.commentsContractId!);

      const args = [
        StellarSdk.nativeToScVal(daoId, { type: "u64" }),
        StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
        StellarSdk.nativeToScVal(contentCid, { type: "string" }),
        StellarSdk.nativeToScVal(
          parentId !== undefined && parentId !== null ? BigInt(parentId) : null,
        ),
        scNullifier,
        scRoot,
        StellarSdk.nativeToScVal(voteChoice, { type: "bool" }),
        scProof,
      ];

      const operation = contract.call("add_anonymous_comment", ...args);

      // Serialize account fetch + build + simulate + sign + submit under sequence lock
      // to prevent nonce race conditions between concurrent requests
      const { commentId, sendResult, result } = await withSequenceLock(
        async () => {
          const account = await (server as StellarSdk.rpc.Server).getAccount(
            relayerKeypair.publicKey(),
          );
          const tx = new StellarSdk.TransactionBuilder(account, {
            fee: "100000",
            networkPassphrase: config.networkPassphrase,
          })
            .addOperation(operation)
            .setTimeout(30)
            .build();

          const simResult = await callWithTimeout(
            () =>
              simulateWithBackoff(() =>
                (server as StellarSdk.rpc.Server).simulateTransaction(tx),
              ),
            "simulate_add_anonymous_comment",
          );

          if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
            const errorStr =
              typeof simResult.error === "string"
                ? simResult.error
                : JSON.stringify(simResult.error);
            log("warn", "comment_anon_simulation_failed", {
              daoId,
              proposalId,
              error: errorStr,
              fullResult: JSON.stringify(simResult).slice(0, 500),
            });
            throw new Error(`SIMULATION_FAILED:${errorStr}`);
          }

          const cId = simResult.result?.retval
            ? Number(StellarSdk.scValToNative(simResult.result.retval))
            : null;

          const preparedTx = StellarSdk.rpc
            .assembleTransaction(tx, simResult)
            .build();
          preparedTx.sign(relayerKeypair as StellarSdk.Keypair);

          const sr = await callWithTimeout(
            () => (server as StellarSdk.rpc.Server).sendTransaction(preparedTx),
            "send_add_anonymous_comment",
          );

          if (sr.status === "ERROR") {
            throw new Error("SUBMIT_FAILED");
          }

          const r = await callWithTimeout(
            () => waitForTransaction(sr.hash),
            "wait_for_anonymous_comment",
          );

          return { commentId: cId, sendResult: sr, result: r };
        },
      );

      if (result.status === "SUCCESS") {
        commentsSubmitted.inc({ status: "success" });
        log("info", "comment_anonymous_success", {
          daoId,
          proposalId,
          commentId,
        });

        if (!config.testMode) {
          recordCommentSubmission(
            nullifier,
            daoId,
            proposalId,
            config.commitmentRateWindowMs,
          );
        }

        res.json({ success: true, commentId, txHash: sendResult.hash });
      } else {
        commentsSubmitted.inc({ status: "failed" });
        // Log the actual failure reason
        const resultXdr = "resultXdr" in result ? result.resultXdr : undefined;
        log("error", "comment_anonymous_tx_failed", {
          daoId,
          proposalId,
          txHash: sendResult.hash,
          status: result.status,
          resultXdr: resultXdr?.toXDR?.("base64")?.slice(0, 200),
        });
        res
          .status(500)
          .json({ error: "Transaction failed", txHash: sendResult.hash });
      }
    } catch (err) {
      log("error", "comment_anonymous_exception", {
        message: (err as Error).message,
      });

      const errMsg = (err as Error).message || "";
      let statusCode = 500;
      let userMessage = "Internal server error";

      if (errMsg.startsWith("SIMULATION_FAILED:")) {
        statusCode = 400;
        userMessage =
          "Failed to add anonymous comment (proof verification failed or invalid membership)";
      } else if (errMsg === "SUBMIT_FAILED") {
        statusCode = 500;
        userMessage = "Transaction submission failed";
      } else if (errMsg.includes("Timeout:")) {
        statusCode = 504;
        userMessage = "Request timeout - please try again";
      } else if (errMsg.includes("Transaction not found after timeout")) {
        statusCode = 504;
        userMessage = "Transaction confirmation timeout";
      } else if (
        errMsg.includes("getAccount") ||
        errMsg.includes("ECONNREFUSED")
      ) {
        statusCode = 503;
        userMessage = "Blockchain RPC temporarily unavailable - please retry";
      }

      res
        .status(statusCode)
        .json(
          config.genericErrors
            ? { error: userMessage }
            : { error: userMessage, details: errMsg },
        );
    }
  }) as AsyncHandler,
);

// ============================================
// COMMENT NONCE
// ============================================

/**
 * GET /comments/:daoId/:proposalId/nonce - Get next comment nonce
 */
router.get("/comments/:daoId/:proposalId/nonce", queryLimiter, validateParams(proposalParamsSchema), (async (
  req: Request,
  res: Response,
) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { daoId, proposalId } = (req as any).validatedParams;
  const { commitment } = req.query;

  if (!commitment) {
    return res
      .status(400)
      .json({ error: "commitment query parameter is required" });
  }

  try {
    const contract = new StellarSdk.Contract(config.commentsContractId!);
    const scCommitment = u256ToScVal(commitment as string);

    const args = [
      StellarSdk.nativeToScVal(daoId, { type: "u64" }),
      StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
      scCommitment,
    ];

    const operation = contract.call("get_comment_nonce", ...args);

    const account = await (server as StellarSdk.rpc.Server).getAccount(
      relayerKeypair.publicKey(),
    );
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await callWithTimeout(
      () =>
        simulateWithBackoff(() =>
          (server as StellarSdk.rpc.Server).simulateTransaction(tx),
        ),
      "simulate_get_comment_nonce",
    );

    if (StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
      const result = simResult.result?.retval;
      const nonce = result ? Number(StellarSdk.scValToNative(result)) : 0;
      res.json({ nonce });
    } else {
      log("warn", "get_comment_nonce_failed", {
        daoId,
        proposalId,
        error: simResult.error,
      });
      res.json({ nonce: 0 });
    }
  } catch (err) {
    log("error", "get_comment_nonce_exception", {
      daoId,
      proposalId,
      error: (err as Error).message,
    });
    res.json({ nonce: 0 });
  }
}) as AsyncHandler);

// ============================================
// GET COMMENTS
// ============================================

/**
 * GET /comments/:daoId/:proposalId - Get comments for a proposal with pagination
 */
router.get("/comments/:daoId/:proposalId", queryLimiter, validateParams(proposalParamsSchema), validateQuery(commentCountQuerySchema), (async (
  req: Request,
  res: Response,
) => {
  const { daoId, proposalId } = (req as any).validatedParams;
  const { limit, offset } = (req as any).validatedQuery;

  try {
    const contract = new StellarSdk.Contract(config.commentsContractId!);

    const args = [
      StellarSdk.nativeToScVal(daoId, { type: "u64" }),
      StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
      StellarSdk.nativeToScVal(parseInt(offset as string), { type: "u64" }),
      StellarSdk.nativeToScVal(Math.min(parseInt(limit as string), 500), {
        type: "u64",
      }),
    ];

    const operation = contract.call("get_comments", ...args);

    const account = await (server as StellarSdk.rpc.Server).getAccount(
      relayerKeypair.publicKey(),
    );
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await callWithTimeout(
      () =>
        simulateWithBackoff(() =>
          (server as StellarSdk.rpc.Server).simulateTransaction(tx),
        ),
      "simulate_get_comments",
    );

    if (StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
      const result = simResult.result?.retval;
      if (result) {
        const comments = StellarSdk.scValToNative(result);
        const transformed = comments.map((c: any) => ({
          id: Number(c.id),
          daoId: Number(c.dao_id),
          proposalId: Number(c.proposal_id),
          author: c.author || null,
          nullifier: c.nullifier ? c.nullifier.toString() : null,
          contentCid: c.content_cid,
          parentId: c.parent_id !== undefined ? Number(c.parent_id) : null,
          createdAt: Number(c.created_at),
          updatedAt: Number(c.updated_at),
          revisionCids: c.revision_cids || [],
          deleted: c.deleted,
          deletedBy: c.deleted_by,
          isAnonymous: !c.author,
        }));

        const hiddenIds = new Set(getHiddenCommentIds(daoId, proposalId));
        const filtered = transformed.map((c: any) => ({
          ...c,
          hidden: hiddenIds.has(c.id),
        }));

        const payload = { comments: filtered, total: filtered.length };
        setLkg(commentsLkgKey(daoId, proposalId), payload);
        markHealthy("comments");
        res.json(payload);
        const total = filtered.length;
        const hasMore = total === limit;

        res.json({
          data: filtered,
          pagination: {
            cursor: hasMore ? String(offset + limit) : undefined,
            hasMore,
            total,
          },
        });
      } else {
        res.json({
          data: [],
          pagination: {
            cursor: undefined,
            hasMore: false,
            total: 0,
          },
        });
      }
    } else {
      res.status(400).json({ error: "Failed to get comments" });
    }
  } catch (err) {
    const message = (err as Error).message;
    log("error", "get_comments_failed", {
      daoId,
      proposalId,
      error: message,
    });

    // Disable comments UX when contract/RPC unavailable — serve LKG if present
    if (!config.commentsContractId) {
      markUnavailable("comments", "comments contract not configured");
      noteDegraded("comments");
      return res.status(503).json({
        error: "Comments system unavailable",
        disabled: true,
      });
    }

    markDegraded("comments", message);
    noteDegraded("comments");
    const cached = getLkg<{ comments: unknown[]; total: number }>(
      commentsLkgKey(daoId, proposalId),
    );
    if (cached) {
      return sendPartial(
        res,
        {
          comments: cached.comments,
          total: cached.total,
          stale: true,
          source: "last_known_good",
        },
        ["comments"],
      );
    }

    res.status(503).json({
      error: "Comments temporarily unavailable",
      disabled: true,
      comments: [],
      total: 0,
    });
  }
}) as AsyncHandler);

// ============================================
// GET SINGLE COMMENT
// ============================================

/**
 * GET /comment/:daoId/:proposalId/:commentId - Get single comment
 */
router.get("/comment/:daoId/:proposalId/:commentId", queryLimiter, validateParams(commentParamsSchema), (async (
  req: Request,
  res: Response,
) => {
  const { daoId, proposalId, commentId } = (req as any).validatedParams;

  try {
    const contract = new StellarSdk.Contract(config.commentsContractId!);

    const args = [
      StellarSdk.nativeToScVal(daoId, { type: "u64" }),
      StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
      StellarSdk.nativeToScVal(commentId, { type: "u64" }),
    ];

    const operation = contract.call("get_comment", ...args);

    const account = await (server as StellarSdk.rpc.Server).getAccount(
      relayerKeypair.publicKey(),
    );
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await callWithTimeout(
      () =>
        simulateWithBackoff(() =>
          (server as StellarSdk.rpc.Server).simulateTransaction(tx),
        ),
      "simulate_get_comment",
    );

    if (StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
      const result = simResult.result?.retval;
      if (result) {
        const c = StellarSdk.scValToNative(result);
        const hiddenIds = getHiddenCommentIds(daoId, proposalId);
        res.json({
          id: Number(c.id),
          daoId: Number(c.dao_id),
          proposalId: Number(c.proposal_id),
          author: c.author || null,
          contentCid: c.content_cid,
          parentId: c.parent_id !== undefined ? Number(c.parent_id) : null,
          createdAt: Number(c.created_at),
          updatedAt: Number(c.updated_at),
          revisionCids: c.revision_cids || [],
          deleted: c.deleted,
          deletedBy: c.deleted_by,
          isAnonymous: !c.author,
          hidden: hiddenIds.includes(Number(c.id)),
        });
      } else {
        res.status(404).json({ error: "Comment not found" });
      }
    } else {
      res.status(404).json({ error: "Comment not found" });
    }
  } catch (err) {
    log("error", "get_comment_failed", {
      daoId,
      proposalId,
      commentId,
      error: (err as Error).message,
    });
    res.status(500).json({ error: "Failed to fetch comment" });
  }
}) as AsyncHandler);

// ============================================
// EDIT COMMENT
// ============================================

/**
 * POST /comment/edit - Edit public comment
 */
router.post("/comment/edit", authGuard, commentLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { daoId, proposalId, commentId, newContentCid, author } = req.body;

  if (
    daoId === undefined ||
    proposalId === undefined ||
    commentId === undefined ||
    !newContentCid ||
    !author
  ) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!(await enforceCurrentMembership(daoId, author, res, "comment_edit"))) {
    return;
  }

  try {
    log("info", "comment_edit_request", { daoId, proposalId, commentId });

    const contract = new StellarSdk.Contract(config.commentsContractId!);
    const authorAddress = StellarSdk.Address.fromString(author);

    const args = [
      StellarSdk.nativeToScVal(daoId, { type: "u64" }),
      StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
      StellarSdk.nativeToScVal(commentId, { type: "u64" }),
      StellarSdk.xdr.ScVal.scvAddress(authorAddress.toScAddress()),
      StellarSdk.nativeToScVal(newContentCid, { type: "string" }),
    ];

    const operation = contract.call("edit_comment", ...args);

    const { sendResult, result } = await withSequenceLock(async () => {
      const account = await (server as StellarSdk.rpc.Server).getAccount(
        relayerKeypair.publicKey(),
      );
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: "100000",
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simResult = await callWithTimeout(
        () =>
          simulateWithBackoff(() =>
            (server as StellarSdk.rpc.Server).simulateTransaction(tx),
          ),
        "simulate_edit_comment",
      );

      if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
        throw new Error("SIMULATION_FAILED:Failed to edit comment");
      }

      const preparedTx = StellarSdk.rpc
        .assembleTransaction(tx, simResult)
        .build();
      preparedTx.sign(relayerKeypair as StellarSdk.Keypair);

      const sr = await callWithTimeout(
        () => (server as StellarSdk.rpc.Server).sendTransaction(preparedTx),
        "send_edit_comment",
      );

      if (sr.status === "ERROR") {
        throw new Error("SUBMIT_FAILED");
      }

      const r = await callWithTimeout(
        () => waitForTransaction(sr.hash),
        "wait_for_edit_comment",
      );

      return { sendResult: sr, result: r };
    });

    if (result.status === "SUCCESS") {
      log("info", "comment_edit_success", { daoId, proposalId, commentId });
      res.json({ success: true, txHash: sendResult.hash });
    } else {
      res.status(500).json({ error: "Transaction failed" });
    }
  } catch (err) {
    const errMsg = (err as Error).message || "";
    log("error", "comment_edit_exception", { message: errMsg });

    if (errMsg.startsWith("SIMULATION_FAILED:")) {
      res
        .status(400)
        .json({ error: errMsg.slice("SIMULATION_FAILED:".length) });
    } else if (errMsg === "SUBMIT_FAILED") {
      res.status(500).json({ error: "Transaction submission failed" });
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
  }
}) as AsyncHandler);

// ============================================
// DELETE COMMENT
// ============================================

/**
 * POST /comment/delete - Delete public comment
 */
router.post("/comment/delete", authGuard, commentLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { daoId, proposalId, commentId, author } = req.body;

  if (
    daoId === undefined ||
    proposalId === undefined ||
    commentId === undefined ||
    !author
  ) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!(await enforceCurrentMembership(daoId, author, res, "comment_delete"))) {
    return;
  }

  try {
    log("info", "comment_delete_request", { daoId, proposalId, commentId });

    const contract = new StellarSdk.Contract(config.commentsContractId!);
    const authorAddress = StellarSdk.Address.fromString(author);

    const args = [
      StellarSdk.nativeToScVal(daoId, { type: "u64" }),
      StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
      StellarSdk.nativeToScVal(commentId, { type: "u64" }),
      StellarSdk.xdr.ScVal.scvAddress(authorAddress.toScAddress()),
    ];

    const operation = contract.call("delete_comment", ...args);

    const { sendResult, result } = await withSequenceLock(async () => {
      const account = await (server as StellarSdk.rpc.Server).getAccount(
        relayerKeypair.publicKey(),
      );
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: "100000",
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simResult = await callWithTimeout(
        () =>
          simulateWithBackoff(() =>
            (server as StellarSdk.rpc.Server).simulateTransaction(tx),
          ),
        "simulate_delete_comment",
      );

      if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
        throw new Error("SIMULATION_FAILED:Failed to delete comment");
      }

      const preparedTx = StellarSdk.rpc
        .assembleTransaction(tx, simResult)
        .build();
      preparedTx.sign(relayerKeypair as StellarSdk.Keypair);

      const sr = await callWithTimeout(
        () => (server as StellarSdk.rpc.Server).sendTransaction(preparedTx),
        "send_delete_comment",
      );

      if (sr.status === "ERROR") {
        throw new Error("SUBMIT_FAILED");
      }

      const r = await callWithTimeout(
        () => waitForTransaction(sr.hash),
        "wait_for_delete_comment",
      );

      return { sendResult: sr, result: r };
    });

    if (result.status === "SUCCESS") {
      log("info", "comment_delete_success", { daoId, proposalId, commentId });
      res.json({ success: true, txHash: sendResult.hash });
    } else {
      res.status(500).json({ error: "Transaction failed" });
    }
  } catch (err) {
    const errMsg = (err as Error).message || "";
    log("error", "comment_delete_exception", { message: errMsg });

    if (errMsg.startsWith("SIMULATION_FAILED:")) {
      res
        .status(400)
        .json({ error: errMsg.slice("SIMULATION_FAILED:".length) });
    } else if (errMsg === "SUBMIT_FAILED") {
      res.status(500).json({ error: "Transaction submission failed" });
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
  }
}) as AsyncHandler);

// ============================================
// ANTI-SPAM: FLAG COMMENT
// ============================================

/**
 * POST /comment/flag - Flag a comment as spam
 */
router.post(
  "/comment/flag",
  authGuard,
  commentLimiter,
  validateBody(flagCommentSchema),
  (async (req: Request, res: Response) => {
    const {
      daoId,
      proposalId,
      commentId,
      flaggerCommitment,
      flaggerNullifier,
      serverId: flagServerId,
      workNonce: flagWorkNonce,
    } = config.stripRequestBodies ? {} : req.body;

    if (config.powEnabled && !config.testMode) {
      const powConfig = {
        difficulty: config.flagPowDifficulty,
        challengeTtlMs: config.powChallengeTtlMs,
      };
      const powResult = verifyChallenge(
        flagServerId,
        flaggerNullifier,
        flagWorkNonce,
        powConfig,
      );
      if (!powResult.valid) {
        log("warn", "flag_pow_verification_failed", {
          commentId,
          daoId,
          proposalId,
          reason: powResult.reason,
        });
        return res
          .status(400)
          .json({ error: `PoW verification failed: ${powResult.reason}` });
      }
    }

    try {
      const result = flagComment(
        commentId,
        daoId,
        proposalId,
        flaggerCommitment,
        flaggerNullifier,
        config.flagThreshold,
      );

      if (result.success) {
        log("info", "comment_flagged_ok", {
          commentId,
          daoId,
          proposalId,
          flagCount: result.flagCount,
          hidden: result.hidden,
        });
      }

      res.json({
        success: result.success,
        hidden: result.hidden,
        flagCount: result.flagCount,
        threshold: result.threshold,
      });
    } catch (err) {
      log("error", "comment_flag_exception", {
        commentId,
        daoId,
        proposalId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to flag comment" });
    }
  }) as AsyncHandler,
);

export default router;
