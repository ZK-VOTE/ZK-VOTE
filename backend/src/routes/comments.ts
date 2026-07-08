/**
 * Comment Routes
 *
 * Handles anonymous and public comments with ZK proofs.
 */

import { Router, type Request, type Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";

import { config } from "../config.js";
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
import {
  authGuard,
  commentLimiter,
  queryLimiter,
  validateBody,
} from "../middleware/index.js";
import { anonymousCommentSchema } from "../validation/schemas.js";
import type { AsyncHandler } from "../types/index.js";

const router = Router();

// ============================================
// ANONYMOUS COMMENT
// ============================================

/**
 * POST /comment/anonymous - Submit anonymous comment with ZK proof
 */
router.post(
  "/comment/anonymous",
  authGuard,
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
    } = config.stripRequestBodies ? {} : req.body;

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
        log("info", "comment_anonymous_success", {
          daoId,
          proposalId,
          commentId,
        });
        res.json({ success: true, commentId, txHash: sendResult.hash });
      } else {
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
router.get("/comments/:daoId/:proposalId/nonce", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { daoId, proposalId } = req.params;
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
      StellarSdk.nativeToScVal(parseInt(daoId), { type: "u64" }),
      StellarSdk.nativeToScVal(parseInt(proposalId), { type: "u64" }),
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
 * GET /comments/:daoId/:proposalId - Get comments for a proposal
 */
router.get("/comments/:daoId/:proposalId", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { daoId, proposalId } = req.params;
  const { limit = "50", offset = "0" } = req.query;

  try {
    const contract = new StellarSdk.Contract(config.commentsContractId!);

    const args = [
      StellarSdk.nativeToScVal(parseInt(daoId), { type: "u64" }),
      StellarSdk.nativeToScVal(parseInt(proposalId), { type: "u64" }),
      StellarSdk.nativeToScVal(parseInt(offset as string), { type: "u64" }),
      StellarSdk.nativeToScVal(Math.min(parseInt(limit as string), 100), {
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
        res.json({ comments: transformed, total: transformed.length });
      } else {
        res.json({ comments: [], total: 0 });
      }
    } else {
      res.status(400).json({ error: "Failed to get comments" });
    }
  } catch (err) {
    log("error", "get_comments_failed", {
      daoId,
      proposalId,
      error: (err as Error).message,
    });
    res.status(500).json({ error: "Failed to fetch comments" });
  }
}) as AsyncHandler);

// ============================================
// GET SINGLE COMMENT
// ============================================

/**
 * GET /comment/:daoId/:proposalId/:commentId - Get single comment
 */
router.get("/comment/:daoId/:proposalId/:commentId", queryLimiter, (async (
  req: Request,
  res: Response,
) => {
  const { daoId, proposalId, commentId } = req.params;

  try {
    const contract = new StellarSdk.Contract(config.commentsContractId!);

    const args = [
      StellarSdk.nativeToScVal(parseInt(daoId), { type: "u64" }),
      StellarSdk.nativeToScVal(parseInt(proposalId), { type: "u64" }),
      StellarSdk.nativeToScVal(parseInt(commentId), { type: "u64" }),
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

export default router;
