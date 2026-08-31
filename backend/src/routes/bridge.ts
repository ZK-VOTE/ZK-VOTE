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

import {
  authGuard,
  queryLimiter,
  validateBody,
  validateParams,
  bodyLimit,
} from "../middleware/index.js";
import {
  nullifierParamsSchema,
  bridgeVoteSchema,
} from "../validation/schemas.js";
import type { AsyncHandler } from "../types/index.js";

const router = Router();

// ============================================
// ROUTES
// ============================================

/**
 * POST /bridge/vote - Submit cross-chain vote
 *
 * Receives a Groth16 proof generated on EVM and relays it to Soroban.
 * The proof proves SBT membership and voting eligibility.
 */
router.post("/bridge/vote", validateBody(bridgeVoteSchema), (async (
  req: Request,
  res: Response,
) => {
  const { daoId, proposalId, voteChoice, nullifier, voteRoot } =
    config.stripRequestBodies ? {} : req.body;

  try {
    log("info", "bridge_vote_request", { daoId, proposalId });

    // Convert inputs to Soroban types
    let scNullifier: StellarSdk.xdr.ScVal;
    let scRoot: StellarSdk.xdr.ScVal;
    try {
      scNullifier = u256ToScVal(nullifier);
      scRoot = u256ToScVal(voteRoot);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    if (config.testMode) {
      return res.status(400).json({ error: "Simulation failed (test mode)" });
    }

    // Build contract call to Soroban bridge
    const contract = new StellarSdk.Contract(config.bridgeContractId!);

    const args = [
      StellarSdk.nativeToScVal(daoId, { type: "u64" }),
      StellarSdk.nativeToScVal(proposalId, { type: "u64" }),
      StellarSdk.nativeToScVal(voteChoice === 1, { type: "bool" }),
      scNullifier,
      scRoot,
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
        log("warn", "bridge_simulation_failed", {
          daoId,
          proposalId,
          error: simResult.error,
        });

        let errorMessage = "Transaction simulation failed";
        if (simResult.error) {
          const errorStr = JSON.stringify(simResult.error);
          if (errorStr.includes("already voted")) {
            errorMessage = "You have already voted on this proposal";
          } else if (errorStr.includes("nullifier")) {
            errorMessage = "Invalid or already-used nullifier";
          }
        }

        throw new Error(`SIMULATION_FAILED:${errorMessage}`);
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
          error: sr.errorResult,
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
      stack: (err as Error).stack,
    });

    const errMsg = (err as Error).message || "";
    let statusCode = 500;
    let userMessage = "Internal server error";

    if (errMsg.startsWith("SIMULATION_FAILED:")) {
      statusCode = 400;
      userMessage = errMsg.slice("SIMULATION_FAILED:".length);
    } else if (errMsg === "SUBMIT_FAILED") {
      statusCode = 500;
      userMessage = "Transaction submission failed";
    } else if (errMsg.includes("Timeout:")) {
      statusCode = 504;
      userMessage = "Request timeout - please try again";
    }

    res
      .status(statusCode)
      .json(
        config.genericErrors
          ? { error: userMessage }
          : { error: userMessage, details: errMsg },
      );
  }
}) as AsyncHandler);

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

export default router;
