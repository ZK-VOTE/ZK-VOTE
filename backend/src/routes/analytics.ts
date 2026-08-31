/**
 * DAO analytics endpoints
 *
 * Exposes anonymity-set and root-history metrics for UI warnings.
 */

import { Router, type Request, type Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { relayerKeypair, server } from "../services/stellar.js";

const router = Router();
const MAX_ROOTS = 30;
const WARNING_THRESHOLD = 27;

async function simulateTreeCall(
  method: string,
  daoId: number,
): Promise<unknown> {
  const contract = new StellarSdk.Contract(config.treeContractId!);
  const operation = contract.call(
    method,
    StellarSdk.nativeToScVal(daoId, { type: "u64" }),
  );
  const account = await server.getAccount(relayerKeypair.publicKey());
  const transaction = new StellarSdk.TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();
  const result = await server.simulateTransaction(transaction);
  if (
    !StellarSdk.rpc.Api.isSimulationSuccess(result) ||
    !result.result?.retval
  ) {
    throw new Error(`Unable to simulate ${method}`);
  }
  return StellarSdk.scValToNative(result.result.retval);
}

router.get("/analytics/:daoId", async (req: Request, res: Response) => {
  const daoId = Number(req.params.daoId);
  if (!Number.isFinite(daoId) || daoId <= 0) {
    return res.status(400).json({ error: "Invalid daoId" });
  }

  try {
    const [treeInfo, rootHistoryLenValue, anonymitySetSizeValue] =
      await Promise.all([
        simulateTreeCall("get_tree_info", daoId),
        simulateTreeCall("root_history_len", daoId),
        simulateTreeCall("anonymity_set_size", daoId),
      ]);

    const rootHistoryLen = Number(rootHistoryLenValue ?? 0);
    const anonymitySetSizeNum = Number(anonymitySetSizeValue ?? 0);
    const leafCount = Array.isArray(treeInfo) ? Number(treeInfo[1] ?? 0) : 0;
    const warning =
      rootHistoryLen >= WARNING_THRESHOLD
        ? {
            level: "warning",
            message: `Root history is nearing eviction (${rootHistoryLen}/${MAX_ROOTS} roots retained). Stale proofs may fail once roots are evicted.`,
            maxRoots: MAX_ROOTS,
            threshold: WARNING_THRESHOLD,
          }
        : null;

    return res.json({
      daoId,
      leafCount,
      anonymitySetSize: anonymitySetSizeNum || leafCount,
      rootHistoryLen,
      maxRoots: MAX_ROOTS,
      warning,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Failed to load DAO analytics",
      message: (err as Error).message,
    });
  }
});

export default router;
