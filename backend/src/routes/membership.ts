/**
 * Membership Routes — Commitment Registration Rate Limiting (#371)
 *
 * `register_with_caller` requires caller auth, so the relayer cannot forge the
 * member's signature: this endpoint simulates the registration against the
 * membership-tree contract and returns the prepared transaction XDR (plus the
 * authorization entry) for the member to complete signing in their wallet.
 *
 * The per-member rate limiter here mirrors the on-chain per-member registration
 * cooldown in the membership-tree contract, so both layers reject spam.
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
  u256ToScVal,
} from "../services/stellar.js";
import {
  authGuard,
  commitmentRegistrationLimiter,
  validateBody,
} from "../middleware/index.js";
import { membershipRegisterSchema } from "../validation/schemas.js";
import {
  membershipRegistrationTotal,
  membershipRegistrationLimited,
} from "../services/metrics.js";
import type { AsyncHandler } from "../types/index.js";

const router = Router();

/**
 * Map a membership-tree contract error to an HTTP response.
 * Returns null when the call actually succeeded (no contract error).
 */
function classifyTreeError(
  errorStr: string,
): { status: number; message: string } | null {
  const includes = (...cands: (string | number)[]) =>
    cands.some((c) => errorStr.includes(String(c)));

  // #371: on-chain cooldown exceeded → 429 with retry guidance
  if (includes("RateLimited") || includes("#17") || includes("17")) {
    return {
      status: 429,
      message:
        "Rate limited: too many registrations for this member, try again after the cooldown window",
    };
  }
  if (includes("NoSbt") || includes("#8") || includes("8")) {
    return { status: 403, message: "Member does not have an SBT" };
  }
  if (includes("NotOpenMembership") || includes("#9") || includes("9")) {
    return { status: 403, message: "DAO membership is not open" };
  }
  if (includes("MemberRemoved") || includes("#11") || includes("11")) {
    return { status: 403, message: "Member has been removed from the DAO" };
  }
  if (
    includes("MemberExists") ||
    includes("#6") ||
    includes("6") ||
    includes("CommitmentExists") ||
    includes("CommitmentAlreadyUsed") ||
    includes("#5") ||
    includes("5") ||
    includes("16") ||
    includes("#16")
  ) {
    return {
      status: 409,
      message: "Member or commitment already registered",
    };
  }
  return null;
}

/**
 * POST /api/v1/membership/register-commitment
 * Body: { daoId, commitment, caller }
 * Rate-limited per member (caller address) (#371) then simulated on-chain.
 */
router.post(
  "/membership/register-commitment",
  authGuard,
  commitmentRegistrationLimiter,
  validateBody(membershipRegisterSchema),
  (async (req: Request, res: Response) => {
    const { daoId, commitment, caller } = config.stripRequestBodies
      ? ({} as any)
      : req.body;

    try {
      log("info", "membership_register_commitment_request", { daoId, caller });
      membershipRegistrationTotal.inc({ dao_id: String(daoId) });

      if (!config.treeContractId) {
        return res
          .status(503)
          .json({ error: "Membership tree contract not configured" });
      }

      if (config.testMode) {
        // Test mode: no chain available; confirm wiring + rate-limit counters.
        return res.status(200).json({
          success: true,
          prepared: true,
          testMode: true,
          daoId,
          caller,
        });
      }

      let scCommitment: StellarSdk.xdr.ScVal;
      let scCaller: StellarSdk.xdr.ScVal;
      try {
        scCommitment = u256ToScVal(commitment);
        scCaller = StellarSdk.Address.fromString(caller).toScVal();
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }

      const contract = new StellarSdk.Contract(config.treeContractId!);
      const args = [
        StellarSdk.nativeToScVal(daoId, { type: "u64" }),
        scCommitment,
        scCaller,
      ];
      const operation = contract.call("register_with_caller", ...args);

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

      log("info", "membership_register_commitment_simulating", {
        daoId,
        caller,
      });
      const simResult = await callWithTimeout(
        () =>
          simulateWithBackoff(() =>
            (server as StellarSdk.rpc.Server).simulateTransaction(tx),
          ),
        "simulate_membership_register",
      );

      if (!StellarSdk.rpc.Api.isSimulationSuccess(simResult)) {
        const errorStr = JSON.stringify(simResult.error ?? simResult);
        log("warn", "membership_register_commitment_simulation_failed", {
          daoId,
          caller,
          error: errorStr.slice(0, 500),
        });
        // Missing caller auth (a wallet-made request) is expected for this
        // prepare-only endpoint; surface it distinctly from real contract errors.
        if (
          errorStr.toLowerCase().includes("auth") ||
          errorStr.includes("require_auth")
        ) {
          return res.status(400).json({
            error:
              "Registration must be authorized by the caller address; complete signing in your wallet",
            prepared: false,
          });
        }
        const classified = classifyTreeError(errorStr);
        if (classified) {
          res.setHeader("Retry-After", "3600"); // on-chain cooldown window
          membershipRegistrationLimited.inc({
            reason:
              classified.status === 429 ? "contract_cooldown" : "rejected",
          });
          return res.status(classified.status).json({
            error: classified.message,
            limiter:
              classified.status === 429 ? "commitmentRegistration" : undefined,
          });
        }
        return res.status(400).json({ error: "Transaction simulation failed" });
      }

      const preparedTx = StellarSdk.rpc
        .assembleTransaction(tx, simResult)
        .build();

      // Auth entries (SorobanAuthorizationEntry) expected to be signed by caller.
      const authEntry = simResult.result?.auth?.map((entry) =>
        entry.toXDR("base64"),
      );

      res.json({
        success: true,
        prepared: true,
        daoId,
        caller,
        transactionXdr: preparedTx.toXDR(),
        authEntry,
      });
    } catch (err) {
      log("error", "membership_register_commitment_exception", {
        message: (err as Error).message,
        stack: (err as Error).stack,
      });
      const errMsg = (err as Error).message || "";
      let statusCode = 500;
      let userMessage = "Internal server error";
      if (errMsg.includes("Timeout:")) {
        statusCode = 504;
        userMessage = "Request timeout - please try again";
      } else if (errMsg.includes("getAccount")) {
        statusCode = 503;
        userMessage = "Blockchain RPC temporarily unavailable - please retry";
      } else if (errMsg.includes("ECONNREFUSED") || errMsg.includes("ETIMEDOUT")) {
        statusCode = 503;
        userMessage = "Network error - please retry";
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

export default router;