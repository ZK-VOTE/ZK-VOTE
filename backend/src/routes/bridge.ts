/**
 * Bridge Routes
 *
 * Handles cross-chain bridge operations:
 * - POST /bridge/vote - Submit a cross-chain vote (EVM -> Soroban)
 * - GET /bridge/nullifier/:daoId/:proposalId/:nullifier - Check nullifier status
 * - GET /bridge/sbt-root/:daoId - Get current SBT root for a DAO
 * - POST /bridge/relay - Manually trigger event relay
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
} from "../services/stellar.js";
import { verifyBridgeProof } from "../services/bridgeProof.js";
import {
  recordLock,
  getLock,
  getLocksForProposal,
  markReleased,
  markCancelled,
  markRefunded,
  EscrowLockAlreadyExistsError,
  EscrowLockNotFoundError,
  EscrowLockNotActiveError,
  EscrowNonceReplayError,
  EscrowTimeoutNotElapsedError,
} from "../services/treasuryEscrow.js";

import {
  authGuard,
  bodyLimit,
  queryLimiter,
  validateBody,
  voteLimiter,
} from "../middleware/index.js";
import {
  bridgeVoteSchema,
  escrowLockRecordSchema,
  escrowResolutionSchema,
  escrowRefundSchema,
} from "../validation/schemas.js";
import type { AsyncHandler } from "../types/index.js";

const router = Router();

/** Privacy-preserving rejection — never disclose which check failed. */
function voteRejected(res: Response, status = 400) {
  return res.status(status).json({
    error: "VOTE_REJECTED",
    code: "VOTE_REJECTED",
  });
}

// ============================================
// ROUTES
// ============================================

/**
 * POST /bridge/vote - Submit cross-chain vote
 *
 * Receives a Groth16 proof, verifies it off-chain against the bridge VK, then
 * relays only the public vote fields to Soroban `relay_vote` (which does not
 * accept a proof). Authenticity comes from the verified proof + authGuard.
 */
router.post(
  "/bridge/vote",
  bodyLimit("5kb"),
  authGuard,
  voteLimiter,
  validateBody(bridgeVoteSchema),
  (async (req: Request, res: Response) => {
    const {
      daoId,
      proposalId,
      voteChoice,
      nullifier,
      voteRoot,
      sbtRoot,
      sbtContractAddr,
      memberAddr,
      chainId,
      proof,
    } = config.stripRequestBodies ? ({} as Record<string, never>) : req.body;

    try {
      log("info", "bridge_vote_request", { daoId, proposalId });

      const proofValid = await verifyBridgeProof(proof, {
        sbtContractAddr,
        memberAddr,
        daoId,
        proposalId,
        nullifier,
        voteChoice,
        voteRoot,
        sbtRoot,
        chainId,
      });

      if (!proofValid) {
        return voteRejected(res);
      }

      // Convert inputs to Soroban types
      let scNullifier: StellarSdk.xdr.ScVal;
      let scRoot: StellarSdk.xdr.ScVal;
      try {
        scNullifier = u256ToScVal(nullifier);
        scRoot = u256ToScVal(voteRoot);
      } catch {
        return voteRejected(res);
      }

      if (config.testMode) {
        return voteRejected(res);
      }

      if (!config.bridgeContractId) {
        log("error", "bridge_contract_not_configured");
        return res.status(503).json({ error: "Bridge unavailable" });
      }

      // Build contract call to Soroban bridge
      const contract = new StellarSdk.Contract(config.bridgeContractId);
      const relayerAddress = StellarSdk.Address.fromString(
        relayerKeypair.publicKey(),
      );

      const args = [
        StellarSdk.nativeToScVal(daoId, { type: "u64" }),
        StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
        StellarSdk.nativeToScVal(voteChoice === 1, { type: "bool" }),
        scNullifier,
        scRoot,
        relayerAddress.toScVal(),
      ];

      const operation = contract.call("relay_vote", ...args);

      // Submit under sequence lock
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

        // Simulate
        log("info", "simulate_bridge_vote", { daoId, proposalId });
        const simResult = await callWithTimeout(
          () =>
            simulateWithBackoff(() =>
              (server as StellarSdk.rpc.Server).simulateTransaction(tx),
            ),
          "simulate_bridge_vote",
        );

        if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
          // Do not surface contract diagnostics (nullifier / already-voted).
          log("warn", "bridge_simulation_failed", { daoId, proposalId });
          throw new Error("SIMULATION_FAILED:VOTE_REJECTED");
        }

        // Prepare and sign
        const preparedTx = StellarSdk.rpc
          .assembleTransaction(tx, simResult)
          .build();
        preparedTx.sign(relayerKeypair as StellarSdk.Keypair);

        // Submit
        log("info", "submit_bridge_vote", { daoId, proposalId });
        const sr = await callWithTimeout(
          () => (server as StellarSdk.rpc.Server).sendTransaction(preparedTx),
          "send_bridge_vote",
        );

        if (sr.status === "ERROR") {
          log("error", "bridge_submit_failed", {
            daoId,
            proposalId,
          });
          throw new Error("SUBMIT_FAILED");
        }

        // Wait for confirmation
        log("info", "bridge_submitted", { txHash: sr.hash, daoId, proposalId });
        const r = await callWithTimeout(
          () => waitForTransaction(sr.hash),
          "wait_bridge_vote",
        );

        return { sendResult: sr, result: r };
      });

      if (result.status === "SUCCESS") {
        log("info", "bridge_vote_success", {
          txHash: sendResult.hash,
          daoId,
          proposalId,
        });
        res.json({
          success: true,
          txHash: sendResult.hash,
          status: result.status,
        });
      } else {
        log("error", "bridge_vote_failed", {
          txHash: sendResult.hash,
          status: result.status,
        });
        res.status(500).json({
          error: "Transaction failed",
          txHash: sendResult.hash,
          status: result.status,
        });
      }
    } catch (err) {
      log("error", "bridge_vote_exception", {
        message: (err as Error).message,
      });

      const errMsg = (err as Error).message || "";

      if (errMsg.startsWith("SIMULATION_FAILED:")) {
        return voteRejected(res);
      }
      if (errMsg === "SUBMIT_FAILED") {
        return res.status(500).json({ error: "Transaction submission failed" });
      }
      if (errMsg.includes("Timeout:")) {
        return res
          .status(504)
          .json({ error: "Request timeout - please try again" });
      }

      return res.status(500).json({ error: "Internal server error" });
    }
  }) as AsyncHandler,
);

/**
 * GET /bridge/nullifier/:daoId/:proposalId/:nullifier
 *
 * Check if a nullifier has been used (for double-vote detection)
 */
router.get(
  "/bridge/nullifier/:daoId/:proposalId/:nullifier",
  queryLimiter,
  (async (req: Request, res: Response) => {
    const { daoId, proposalId, nullifier } = req.params;

    try {
      const contract = new StellarSdk.Contract(config.bridgeContractId!);
      const args = [
        StellarSdk.nativeToScVal(parseInt(daoId), { type: "u64" }),
        StellarSdk.nativeToScVal(parseInt(proposalId), { type: "u64" }),
        u256ToScVal(nullifier),
      ];

      const operation = contract.call("is_nullifier_used", ...args);

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

      const simResult = await (
        server as StellarSdk.rpc.Server
      ).simulateTransaction(tx);

      if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
        return res.status(404).json({ error: "Bridge contract not found" });
      }

      const resultScVal = simResult.result?.retval;
      if (!resultScVal) {
        return res.status(500).json({ error: "No result returned" });
      }

      const used = resultScVal.b();

      res.json({
        daoId: parseInt(daoId),
        proposalId: parseInt(proposalId),
        nullifier,
        used,
      });
    } catch (err) {
      log("error", "nullifier_check_error", {
        daoId,
        proposalId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to check nullifier status" });
    }
  }) as AsyncHandler,
);

/**
 * POST /bridge/relay - Manually trigger event relay
 *
 * Admin endpoint to manually process EVM events
 */
router.post("/bridge/relay", authGuard, (async (
  req: Request,
  res: Response,
) => {
  try {
    // Trigger relay processing
    log("info", "manual_relay_triggered");
    res.json({ success: true, message: "Relay triggered" });
  } catch (err) {
    log("error", "manual_relay_error", { error: (err as Error).message });
    res.status(500).json({ error: "Failed to trigger relay" });
  }
}) as AsyncHandler);

// ============================================
// SATELLITE TREASURY ESCROW (ZV-107)
// ============================================
//
// `TreasuryEscrow.sol` is the source of truth for custody; these routes are
// a best-effort status cache the frontend polls instead of running its own
// chain indexer. See backend/src/services/treasuryEscrow.ts.

/**
 * POST /bridge/escrow/lock
 *
 * Record a lock a depositor confirmed on-chain (self-reported after their
 * `TreasuryEscrow.lock()` transaction lands). Anyone can report a lock
 * transaction hash because the underlying funds custody is enforced by the
 * contract itself, not by this cache.
 */
router.post(
  "/bridge/escrow/lock",
  bodyLimit("5kb"),
  voteLimiter,
  validateBody(escrowLockRecordSchema),
  (async (req: Request, res: Response) => {
    const { lockId, daoId, proposalId, depositor, recipient, amount, lockTxHash } =
      req.body;

    try {
      const record = recordLock({
        lockId,
        daoId,
        proposalId,
        depositor,
        recipient,
        amount,
        lockTxHash,
      });
      res.status(201).json(record);
    } catch (err) {
      if (err instanceof EscrowLockAlreadyExistsError) {
        return res.status(409).json({ error: "Lock already recorded" });
      }
      log("error", "escrow_lock_record_error", {
        lockId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to record lock" });
    }
  }) as AsyncHandler,
);

/**
 * GET /bridge/escrow/proposal/:daoId/:proposalId - list locks for a proposal
 */
router.get(
  "/bridge/escrow/proposal/:daoId/:proposalId",
  queryLimiter,
  (async (req: Request, res: Response) => {
    const daoId = parseInt(req.params.daoId, 10);
    const proposalId = parseInt(req.params.proposalId, 10);

    if (!Number.isInteger(daoId) || !Number.isInteger(proposalId)) {
      return res.status(400).json({ error: "Invalid daoId or proposalId" });
    }

    res.json({ locks: getLocksForProposal(daoId, proposalId) });
  }) as AsyncHandler,
);

/**
 * GET /bridge/escrow/:lockId - current status of a single lock
 */
router.get(
  "/bridge/escrow/:lockId",
  queryLimiter,
  (async (req: Request, res: Response) => {
    const record = getLock(req.params.lockId);
    if (!record) {
      return res.status(404).json({ error: "Lock not found" });
    }
    res.json(record);
  }) as AsyncHandler,
);

/**
 * POST /bridge/escrow/:lockId/release
 *
 * Relayer-only: report that `release()` was submitted on-chain after
 * observing a finalized Soroban approval. `sorobanNonce` is the finality
 * message's nonce, which can never be reused once consumed.
 */
router.post(
  "/bridge/escrow/:lockId/release",
  bodyLimit("2kb"),
  authGuard,
  validateBody(escrowResolutionSchema),
  (async (req: Request, res: Response) => {
    const { lockId } = req.params;
    const { sorobanNonce, resolutionTxHash } = req.body;

    try {
      const record = markReleased(lockId, sorobanNonce, resolutionTxHash);
      res.json(record);
    } catch (err) {
      if (err instanceof EscrowLockNotFoundError) {
        return res.status(404).json({ error: "Lock not found" });
      }
      if (err instanceof EscrowLockNotActiveError) {
        return res.status(409).json({ error: "Lock is not active" });
      }
      if (err instanceof EscrowNonceReplayError) {
        return res.status(409).json({ error: "Soroban nonce already used" });
      }
      log("error", "escrow_release_error", {
        lockId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to mark lock released" });
    }
  }) as AsyncHandler,
);

/**
 * POST /bridge/escrow/:lockId/cancel
 *
 * Relayer-only: report that `cancel()` was submitted on-chain after
 * observing a Soroban cancellation proof (early unlock to the depositor).
 */
router.post(
  "/bridge/escrow/:lockId/cancel",
  bodyLimit("2kb"),
  authGuard,
  validateBody(escrowResolutionSchema),
  (async (req: Request, res: Response) => {
    const { lockId } = req.params;
    const { sorobanNonce, resolutionTxHash } = req.body;

    try {
      const record = markCancelled(lockId, sorobanNonce, resolutionTxHash);
      res.json(record);
    } catch (err) {
      if (err instanceof EscrowLockNotFoundError) {
        return res.status(404).json({ error: "Lock not found" });
      }
      if (err instanceof EscrowLockNotActiveError) {
        return res.status(409).json({ error: "Lock is not active" });
      }
      if (err instanceof EscrowNonceReplayError) {
        return res.status(409).json({ error: "Soroban nonce already used" });
      }
      log("error", "escrow_cancel_error", {
        lockId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to mark lock cancelled" });
    }
  }) as AsyncHandler,
);

/**
 * POST /bridge/escrow/:lockId/refund
 *
 * Report that `refund()` was submitted on-chain after the 24h timeout
 * elapsed. Anyone may report it (the depositor is always the payee, so
 * reporting it on their behalf cannot redirect funds), but the cache still
 * enforces that the timeout has in fact elapsed.
 */
router.post(
  "/bridge/escrow/:lockId/refund",
  bodyLimit("2kb"),
  voteLimiter,
  validateBody(escrowRefundSchema),
  (async (req: Request, res: Response) => {
    const { lockId } = req.params;
    const { resolutionTxHash } = req.body;

    try {
      const record = markRefunded(lockId, resolutionTxHash);
      res.json(record);
    } catch (err) {
      if (err instanceof EscrowLockNotFoundError) {
        return res.status(404).json({ error: "Lock not found" });
      }
      if (err instanceof EscrowLockNotActiveError) {
        return res.status(409).json({ error: "Lock is not active" });
      }
      if (err instanceof EscrowTimeoutNotElapsedError) {
        return res.status(409).json({ error: "Timeout has not elapsed" });
      }
      log("error", "escrow_refund_error", {
        lockId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to mark lock refunded" });
    }
  }) as AsyncHandler,
);

export default router;
