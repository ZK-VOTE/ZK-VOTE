import * as StellarSdk from "@stellar/stellar-sdk";
import { config, isValidContractId } from "../config.js";
import {
  server,
  relayerKeypair,
  callWithTimeout,
  withSequenceLock,
  waitForTransaction,
} from "./stellar.js";
import { log } from "./logger.js";
import * as dbService from "./db.js";
import {
  queryInstanceTTLWithFallback,
  queryPersistentTTLWithFallback,
  needsRenewal,
  isInGracePeriod,
  formatRemaining,
} from "./ttl-checker.js";
import { markDegraded, markHealthy } from "./service-health.js";

const CONTRACT_META: Array<{
  envKey: keyof typeof config;
  method: string;
  label: string;
}> = [
  { envKey: "votingContractId", method: "version", label: "voting" },
  { envKey: "treeContractId", method: "version", label: "tree" },
  { envKey: "commentsContractId", method: "version", label: "comments" },
  { envKey: "daoRegistryContractId", method: "version", label: "dao_registry" },
  {
    envKey: "membershipSbtContractId",
    method: "version",
    label: "membership_sbt",
  },
];

const DAO_METHODS: Array<{
  envKey: keyof typeof config;
  method: string;
  label: string;
}> = [
  { envKey: "daoRegistryContractId", method: "get_dao", label: "dao_registry" },
  { envKey: "treeContractId", method: "current_root", label: "tree" },
  { envKey: "votingContractId", method: "proposal_count", label: "voting" },
];

interface RenewalEntry {
  entryId: string;
  contractId: string;
  method: string;
  args: StellarSdk.xdr.ScVal[];
  daoId?: number;
  label: string;
}

interface SubmitCallResult {
  success: boolean;
  feeXlm?: number;
  txHash?: string;
  error?: string;
}

let renewalTimerId: ReturnType<typeof setInterval> | null = null;

function getContractId(envKey: keyof typeof config): string | null {
  const val = config[envKey];
  if (typeof val === "string" && isValidContractId(val)) return val;
  return null;
}

async function submitCall(
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[] = [],
): Promise<SubmitCallResult> {
  try {
    return await withSequenceLock(async () => {
      const rpcServer = server as StellarSdk.rpc.Server;
      const sourceAccount = await rpcServer.getAccount(
        relayerKeypair.publicKey(),
      );
      const contract = new StellarSdk.Contract(contractId);

      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: config.ttlMaxFee,
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();

      const simResult = await callWithTimeout(
        () => rpcServer.simulateTransaction(tx),
        `ttl_sim_${method}`,
      );

      if (StellarSdk.rpc.Api.isSimulationError(simResult)) {
        return { success: false, error: simResult.error };
      }

      const prepared = StellarSdk.rpc
        .assembleTransaction(tx, simResult)
        .build();
      prepared.sign(relayerKeypair as StellarSdk.Keypair);

      const sendResult = await callWithTimeout(
        () => rpcServer.sendTransaction(prepared),
        `ttl_send_${method}`,
      );

      if (sendResult.status === "ERROR") {
        return { success: false, error: "send_error" };
      }

      await waitForTransaction(sendResult.hash, 15);

      let feeXlm: number | undefined;
      try {
        const feeStr = prepared.fee;
        feeXlm = Number(feeStr) / 10_000_000;
      } catch {
        /* fee parsing is best-effort */
      }

      return { success: true, feeXlm, txHash: sendResult.hash };
    });
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

type TTLSubmitter = typeof submitCall;

let ttlSubmitter: TTLSubmitter = submitCall;

/**
 * Replace only the transaction-submission boundary in test mode.
 */
export function setTTLSubmitterForTests(
  submitter: TTLSubmitter | null,
): void {
  if (!config.testMode) {
    throw new Error(
      "TTL submitter overrides are only available in test mode",
    );
  }

  ttlSubmitter = submitter ?? submitCall;
}

function buildEntryId(
  contractId: string,
  daoId?: number,
  method?: string,
): string {
  const parts = [contractId.slice(0, 16)];
  if (daoId !== undefined) parts.push(`dao${daoId}`);
  if (method) parts.push(method);
  return parts.join("_");
}

function makeDaoIdScVal(daoId: number): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(daoId, { type: "u64" });
}

async function hasActiveProposals(
  contractId: string,
  daoId: number,
): Promise<boolean> {
  try {
    if (config.testMode) return true;

    const rpcServer = server as StellarSdk.rpc.Server;
    const sourceAccount = await rpcServer.getAccount(
      relayerKeypair.publicKey(),
    );
    const contract = new StellarSdk.Contract(contractId);

    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(contract.call("proposal_count", makeDaoIdScVal(daoId)))
      .setTimeout(30)
      .build();

    const simResult = await callWithTimeout(
      () => rpcServer.simulateTransaction(tx),
      "ttl_check_proposal_count",
    );

    if (
      !StellarSdk.rpc.Api.isSimulationSuccess(simResult) ||
      !simResult.result?.retval
    ) {
      return true;
    }

    const count = Number(StellarSdk.scValToNative(simResult.result.retval));
    return count > 0;
  } catch {
    return true;
  }
}

async function collectEntries(): Promise<{
  entries: RenewalEntry[];
  graceEntries: RenewalEntry[];
}> {
  const entries: RenewalEntry[] = [];
  const graceEntries: RenewalEntry[] = [];

  for (const meta of CONTRACT_META) {
    const contractId = getContractId(meta.envKey);
    if (!contractId) continue;

    const entryId = buildEntryId(contractId, undefined, meta.method);

    if (config.ttlCheckEnabled) {
      const info = await queryInstanceTTLWithFallback(contractId, entryId);
      if (isInGracePeriod(info)) {
        graceEntries.push({
          entryId,
          contractId,
          method: meta.method,
          args: [],
          label: `${meta.label}_instance`,
        });
        log("warn", "ttl_grace_period_entry", {
          entry: meta.label,
          remaining: formatRemaining(info),
        });
      }
      if (!needsRenewal(info)) {
        log("info", "ttl_skip_healthy_instance", {
          entry: meta.label,
          remaining: formatRemaining(info),
        });
        continue;
      }
    }

    entries.push({
      entryId,
      contractId,
      method: meta.method,
      args: [],
      label: `${meta.label}_instance`,
    });
  }

  const daos = dbService.getAllCachedDaos();

  for (const dao of daos) {
    let hasActive = true;
    const votingContractId = getContractId("votingContractId");
    if (votingContractId) {
      hasActive = await hasActiveProposals(votingContractId, dao.id);
    }

    for (const daoMethod of DAO_METHODS) {
      const contractId = getContractId(daoMethod.envKey);
      if (!contractId) continue;

      const entryId = buildEntryId(contractId, dao.id, daoMethod.method);

      if (!hasActive && daoMethod.envKey === "votingContractId") {
        log("info", "ttl_skip_inactive_dao", {
          dao: dao.id,
          method: daoMethod.label,
          reason: "no active proposals",
        });
        continue;
      }

      if (config.ttlCheckEnabled) {
        const info = await queryPersistentTTLWithFallback(
          contractId,
          dao.id,
          daoMethod.method,
          entryId,
        );
        if (isInGracePeriod(info)) {
          graceEntries.push({
            entryId,
            contractId,
            method: daoMethod.method,
            args: [makeDaoIdScVal(dao.id)],
            daoId: dao.id,
            label: `${daoMethod.label}_dao${dao.id}`,
          });
          log("warn", "ttl_grace_period_entry", {
            entry: entryId,
            remaining: formatRemaining(info),
          });
        }
        if (!needsRenewal(info)) {
          continue;
        }
      }

      entries.push({
        entryId,
        contractId,
        method: daoMethod.method,
        args: [makeDaoIdScVal(dao.id)],
        daoId: dao.id,
        label: `${daoMethod.label}_dao${dao.id}`,
      });
    }
  }

  entries.sort((a, b) => {
    const aGrace = graceEntries.some((g) => g.entryId === a.entryId);
    const bGrace = graceEntries.some((g) => g.entryId === b.entryId);
    if (aGrace && !bGrace) return -1;
    if (!aGrace && bGrace) return 1;
    return 0;
  });

  return { entries, graceEntries };
}

async function executeBatch(batch: RenewalEntry[]): Promise<{
  successCount: number;
  failCount: number;
  totalFee: number;
  txCount: number;
}> {
  let successCount = 0;
  let failCount = 0;
  let totalFee = 0;
  let txCount = 0;

  for (const entry of batch) {
    const result = await ttlSubmitter(
      entry.contractId,
      entry.method,
      entry.args,
    );
    if (result.success) {
      successCount++;
      totalFee += result.feeXlm ?? 0;
      txCount++;

      dbService.upsertTTLTracking({
        entryId: entry.entryId,
        contractId: entry.contractId,
        daoId: entry.daoId ?? null,
        method: entry.method,
        lastRenewedAt: new Date().toISOString(),
        remainingLedgers: null,
        urgency: "healthy",
      });
    } else {
      failCount++;
      log("warn", "ttl_batch_entry_failed", {
        entry: entry.label,
        error: result.error,
      });
    }
  }

  return { successCount, failCount, totalFee, txCount };
}

async function renewAllTTLs(): Promise<void> {
  log("info", "ttl_renewal_started");
  const startTime = Date.now();
  const cycleId = new Date().toISOString();
  let costLogId: number | null = null;

  if (config.ttlCostTrackingEnabled) {
    costLogId = dbService.createTTLCostLog(cycleId, cycleId);
  }

  const { entries, graceEntries } = await collectEntries();

  if (entries.length === 0 && graceEntries.length === 0) {
    log("info", "ttl_renewal_all_healthy", {
      message:
        "All entries have sufficient remaining TTL. Skipping renewal cycle.",
    });
    if (costLogId !== null) {
      dbService.updateTTLCostLog(costLogId, {
        cycleEnd: new Date().toISOString(),
        entriesRenewed: 0,
        entriesSkipped: 0,
        txCount: 0,
        totalFeeXlm: 0,
        status: "completed",
      });
    }
    return;
  }

  const batchSize = config.ttlBatchSize;
  const batches: RenewalEntry[][] = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    batches.push(entries.slice(i, i + batchSize));
  }

  let totalSuccess = 0;
  let totalFail = 0;
  let totalFee = 0;
  let totalTx = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    log("info", "ttl_batch_executing", {
      batch: b + 1,
      of: batches.length,
      size: batch.length,
    });

    const result = await executeBatch(batch);
    totalSuccess += result.successCount;
    totalFail += result.failCount;
    totalFee += result.totalFee;
    totalTx += result.txCount;
  }

  const durationMs = Date.now() - startTime;
  const skipped = entries.length - totalSuccess - totalFail;

  log("info", "ttl_renewal_completed", {
    totalEntries: entries.length,
    successCount: totalSuccess,
    failCount: totalFail,
    skippedCount: skipped,
    txCount: totalTx,
    totalFeeXlm: totalFee,
    durationMs,
  });

  if (graceEntries.length > 0) {
    log("warn", "ttl_grace_period_alerts", {
      count: graceEntries.length,
      entries: graceEntries.map((e) => e.label),
      message:
        "These entries are within the grace period and need immediate attention.",
    });
  }

  if (costLogId !== null) {
    dbService.updateTTLCostLog(costLogId, {
      cycleEnd: new Date().toISOString(),
      entriesRenewed: totalSuccess,
      entriesSkipped: skipped,
      txCount: totalTx,
      totalFeeXlm: totalFee,
      status: totalFail > 0 ? "completed_with_errors" : "completed",
    });
  }
}

export function startTTLRenewal(intervalMs?: number): void {
  if (config.testMode) return;

  const interval = intervalMs ?? config.ttlRenewalIntervalMs;

  renewAllTTLs()
    .then(() => markHealthy("ttl_renewal"))
    .catch((err) => {
      markDegraded("ttl_renewal", (err as Error).message);
      log("error", "ttl_renewal_initial_failed", {
        error: (err as Error).message,
      });
    });

  renewalTimerId = setInterval(() => {
    renewAllTTLs()
      .then(() => markHealthy("ttl_renewal"))
      .catch((err) => {
        markDegraded("ttl_renewal", (err as Error).message);
        log("error", "ttl_renewal_periodic_failed", {
          error: (err as Error).message,
        });
      });
  }, interval);

  const intervalDays = (interval / (24 * 60 * 60 * 1000)).toFixed(1);
  log("info", "ttl_renewal_service_started", { intervalDays });
}

export function stopTTLRenewal(): void {
  if (renewalTimerId) {
    clearInterval(renewalTimerId);
    renewalTimerId = null;
    log("info", "ttl_renewal_service_stopped");
  }
}

export { renewAllTTLs };
