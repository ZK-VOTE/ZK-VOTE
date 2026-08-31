/**
 * feeEstimator.ts
 * -----------------------------------------------------------------------
 * Soroban Transaction Fee Estimation & Budgeting
 *
 * Addresses GitHub issue #173 (ZK-VOTE):
 *   - Extract resource estimates from simulation results
 *   - Set resource limits based on simulation + safety margin (default +20%)
 *   - Dynamic fee adjustment based on network congestion
 *   - Track fee expenditure per operation type
 *   - Fee budget limits + alerts when approaching limits
 *   - Fee estimation "endpoint" for frontend cost display
 *   - Log actual vs. estimated resource usage for optimization
 *
 * INTEGRATION
 * -----------------------------------------------------------------------
 * In stellar.ts, wherever `simulateWithBackoff(tx)` is currently called
 * before building/signing the final transaction, replace the raw fee
 * assignment with:
 *
 *   import { FeeEstimator } from "./feeEstimator";
 *   const feeEstimator = new FeeEstimator(server, { relayerBudget: ... });
 *
 *   const simResult = await simulateWithBackoff(tx);
 *   const plan = await feeEstimator.buildFeePlan(simResult, {
 *     operationType: "castVote", // or whatever label fits the call
 *   });
 *
 *   const preparedTx = feeEstimator.applyPlanToTransaction(tx, plan);
 *   // ... sign & submit preparedTx as before ...
 *
 *   // After the transaction result comes back from the network:
 *   feeEstimator.recordActual(plan, actualResourcesFromResult, actualFeeCharged);
 *
 * This module has no hard dependency on a specific stellar-sdk version;
 * it accepts the simulation response as a loosely-typed object and reads
 * the fields Soroban RPC's `simulateTransaction` is documented to return
 * (`transactionData`, `minResourceFee`, `cost`, `events`, `latestLedger`).
 * Adjust field access in `parseSimulation()` if your SDK version's shape
 * differs.
 * -----------------------------------------------------------------------
 */

// ------------------------------------------------------------------------
// Types
// ------------------------------------------------------------------------

/** Raw resource figures pulled out of a Soroban simulation response. */
export interface SimulatedResources {
  cpuInstructions: number;
  memoryBytes: number;
  readBytes: number;
  writeBytes: number;
  /** Number of ledger entries read (footprint size), when available. */
  readEntries?: number;
  writeEntries?: number;
  /** Number/size of contract events emitted, when available. */
  eventCount?: number;
  eventBytes?: number;
  /** The minimum resource fee Soroban itself computed for this simulation. */
  minResourceFeeStroops: number;
}

/** Resource limits + fee we decide to actually submit with. */
export interface FeePlan {
  operationType: string;
  simulated: SimulatedResources;
  /** Resources after applying the safety margin. */
  padded: {
    cpuInstructions: number;
    memoryBytes: number;
    readBytes: number;
    writeBytes: number;
  };
  /** Base (inclusion) fee per operation, in stroops. */
  baseFeeStroops: number;
  /** Soroban resource fee, in stroops (padded). */
  resourceFeeStroops: number;
  /** baseFeeStroops + resourceFeeStroops -- what we set as tx.fee. */
  totalFeeStroops: number;
  congestionMultiplier: number;
  safetyMarginPct: number;
  createdAt: string; // ISO timestamp
}

export interface FeeStats {
  /** Recent per-operation base fee percentiles from the network, in stroops. */
  p10: number;
  p50: number;
  p90: number;
  p99: number;
  ledgerCapacityUsagePct: number; // 0-100, how full recent ledgers were
}

export interface BudgetConfig {
  /** Hard ceiling on total stroops the relayer may spend, e.g. per day/epoch. */
  totalBudgetStroops: number;
  /** Emit an alert once cumulative spend crosses this fraction of the budget. */
  warnThresholdPct?: number; // default 0.8
  /** Hard-stop submitting new transactions once this fraction is reached. */
  hardStopThresholdPct?: number; // default 0.98
  /** Optional per-operation-type sub-budgets. */
  perOperationBudgetStroops?: Record<string, number>;
}

export interface UsageLogEntry {
  timestamp: string;
  operationType: string;
  estimated: SimulatedResources;
  actualFeeStroops?: number;
  estimatedFeeStroops: number;
  actualResources?: Partial<SimulatedResources>;
  deltaPct?: {
    cpu?: number;
    memory?: number;
    readBytes?: number;
    writeBytes?: number;
    fee?: number;
  };
}

export type AlertHandler = (alert: {
  level: "warn" | "critical";
  message: string;
  spentStroops: number;
  budgetStroops: number;
}) => void;

// ------------------------------------------------------------------------
// Fee Estimator
// ------------------------------------------------------------------------

const DEFAULT_SAFETY_MARGIN_PCT = 0.2; // +20%
const DEFAULT_WARN_THRESHOLD = 0.8;
const DEFAULT_HARD_STOP_THRESHOLD = 0.98;

/**
 * Minimal shape we need from a Soroban RPC `Server`-like client.
 * Kept as an interface so this module doesn't hard-depend on a specific
 * stellar-sdk version; pass in your existing `server` instance from
 * stellar.ts as long as it satisfies this shape (most versions do).
 */
export interface SorobanServerLike {
  getFeeStats?: () => Promise<any>;
  getLatestLedger?: () => Promise<{ sequence: number }>;
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class FeeEstimator {
  private server: SorobanServerLike;
  private budgetConfig: BudgetConfig;
  private spentTotalStroops = 0;
  private spentByOperation: Record<string, number> = {};
  private usageLog: UsageLogEntry[] = [];
  private alertHandler: AlertHandler;
  private safetyMarginPct: number;

  constructor(
    server: SorobanServerLike,
    opts: {
      budget: BudgetConfig;
      safetyMarginPct?: number;
      onAlert?: AlertHandler;
    }
  ) {
    this.server = server;
    this.budgetConfig = {
      warnThresholdPct: DEFAULT_WARN_THRESHOLD,
      hardStopThresholdPct: DEFAULT_HARD_STOP_THRESHOLD,
      ...opts.budget,
    };
    this.safetyMarginPct = opts.safetyMarginPct ?? DEFAULT_SAFETY_MARGIN_PCT;
    this.alertHandler =
      opts.onAlert ??
      ((alert) => {
        // Default: log to console. Swap for Slack/PagerDuty/email in prod.
        // eslint-disable-next-line no-console
        console.warn(`[FeeBudget:${alert.level}] ${alert.message}`);
      });
  }

  // ----------------------------------------------------------------------
  // 1. Extract resource estimates from simulation results
  // ----------------------------------------------------------------------

  /**
   * Normalizes a Soroban `simulateTransaction` response into a
   * SimulatedResources object. Handles both the newer `sorobanData`
   * (SorobanTransactionData / `sim.transactionData.build()`) shape and
   * the flatter `cost` object some SDK versions expose directly.
   */
  parseSimulation(simResult: any): SimulatedResources {
    // Soroban RPC "cost" block (cpuInsns / memBytes) - present on most
    // simulateTransaction responses.
    const cost = simResult?.cost ?? simResult?.result?.cost ?? {};
    const cpuInstructions = Number(cost.cpuInsns ?? cost.cpuInstructions ?? 0);
    const memoryBytes = Number(cost.memBytes ?? cost.memoryBytes ?? 0);

    // Resource footprint / read-write byte estimates come from the
    // transaction data envelope produced during simulation.
    const txData = simResult?.transactionData ?? simResult?.sorobanData;
    const resources = txData?.resources?.() ?? txData?._attributes?.resources;

    const readBytes = Number(
      resources?.readBytes?.() ?? resources?.readBytes ?? 0
    );
    const writeBytes = Number(
      resources?.writeBytes?.() ?? resources?.writeBytes ?? 0
    );

    const footprint = txData?.resources?.().footprint?.() ?? txData?.footprint;
    const readEntries = footprint?.readOnly?.().length;
    const writeEntries = footprint?.readWrite?.().length;

    const events = simResult?.events ?? [];
    const eventCount = Array.isArray(events) ? events.length : undefined;
    const eventBytes = Array.isArray(events)
      ? events.reduce(
          (sum: number, e: any) => sum + (e?.xdr?.length ?? 0),
          0
        )
      : undefined;

    const minResourceFeeStroops = Number(
      simResult?.minResourceFee ?? simResult?.minResourceFeeStroops ?? 0
    );

    return {
      cpuInstructions,
      memoryBytes,
      readBytes,
      writeBytes,
      readEntries,
      writeEntries,
      eventCount,
      eventBytes,
      minResourceFeeStroops,
    };
  }

  // ----------------------------------------------------------------------
  // 2 & 3. Padding + congestion-adjusted fee plan
  // ----------------------------------------------------------------------

  /** Pulls recent network fee stats to gauge congestion. Falls back gracefully. */
  async getCongestionMultiplier(): Promise<{
    multiplier: number;
    stats: FeeStats | null;
  }> {
    if (!this.server.getFeeStats) {
      return { multiplier: 1, stats: null };
    }

    try {
      const raw = await this.server.getFeeStats();
      // Soroban RPC returns { sorobanInclusionFee: {p10,p50,p90,p99,...}, ... }
      const soroban = raw?.sorobanInclusionFee ?? raw?.inclusionFee ?? {};
      const stats: FeeStats = {
        p10: Number(soroban.p10 ?? 100),
        p50: Number(soroban.p50 ?? 100),
        p90: Number(soroban.p90 ?? 100),
        p99: Number(soroban.p99 ?? 100),
        ledgerCapacityUsagePct: Number(
          raw?.ledgerCapacityUsage != null
            ? raw.ledgerCapacityUsage * 100
            : 0
        ),
      };

      // Simple congestion heuristic:
      //   - <50% full ledgers  -> use p10 baseline, multiplier 1.0
      //   - 50-80% full        -> use p50, multiplier 1.15
      //   - >80% full          -> use p90/p99, multiplier 1.4
      let multiplier = 1.0;
      if (stats.ledgerCapacityUsagePct > 80) {
        multiplier = 1.4;
      } else if (stats.ledgerCapacityUsagePct > 50) {
        multiplier = 1.15;
      }

      return { multiplier, stats };
    } catch (err) {
      // Network hiccup fetching fee stats shouldn't block submission;
      // fall back to a conservative default multiplier.
      // eslint-disable-next-line no-console
      console.warn("[FeeEstimator] getFeeStats failed, using default multiplier:", err);
      return { multiplier: 1.1, stats: null };
    }
  }

  /**
   * Builds a full fee plan: padded resources + congestion-adjusted total fee.
   * Also enforces the budget (throws BudgetExceededError past hard stop).
   */
  async buildFeePlan(
    simResult: any,
    opts: { operationType: string; safetyMarginPct?: number; baseFeeStroops?: number }
  ): Promise<FeePlan> {
    const simulated = this.parseSimulation(simResult);
    const marginPct = opts.safetyMarginPct ?? this.safetyMarginPct;

    const padded = {
      cpuInstructions: Math.ceil(simulated.cpuInstructions * (1 + marginPct)),
      memoryBytes: Math.ceil(simulated.memoryBytes * (1 + marginPct)),
      readBytes: Math.ceil(simulated.readBytes * (1 + marginPct)),
      writeBytes: Math.ceil(simulated.writeBytes * (1 + marginPct)),
    };

    const { multiplier } = await this.getCongestionMultiplier();

    // Base (inclusion) fee: classic Stellar per-operation fee, congestion
    // adjusted. 100 stroops is the network floor for a single op.
    const baseFeeStroops = Math.ceil((opts.baseFeeStroops ?? 100) * multiplier);

    // Resource fee: pad Soroban's own minResourceFee estimate rather than
    // recomputing pricing math ourselves (pricing tables change with
    // network upgrades; trust the simulation, just add margin).
    const resourceFeeStroops = Math.ceil(
      simulated.minResourceFeeStroops * (1 + marginPct) * multiplier
    );

    const totalFeeStroops = baseFeeStroops + resourceFeeStroops;

    const plan: FeePlan = {
      operationType: opts.operationType,
      simulated,
      padded,
      baseFeeStroops,
      resourceFeeStroops,
      totalFeeStroops,
      congestionMultiplier: multiplier,
      safetyMarginPct: marginPct,
      createdAt: new Date().toISOString(),
    };

    this.checkBudget(plan);

    return plan;
  }

  /**
   * Applies a FeePlan's computed fee + resource limits onto a
   * TransactionBuilder-produced transaction. Expects the tx to already
   * carry `sorobanData` from simulation (assembleTransaction / prepareTransaction
   * style flows) -- we only override the fee and resource limit fields.
   *
   * Kept generic (accepts/returns `any`) so it works across stellar-sdk
   * versions without a hard type dependency; wire up the concrete
   * `Transaction` type from your existing stellar.ts import.
   */
  applyPlanToTransaction(tx: any, plan: FeePlan): any {
    if (typeof tx.fee !== "undefined") {
      tx.fee = String(plan.totalFeeStroops);
    }

    // If the SDK exposes a mutable sorobanData resources object, bump the
    // instruction/read/write limits to match our padded numbers so the
    // network doesn't reject on `resource limit exceeded` after margin.
    const resources = tx?.sorobanData?.resources?.();
    if (resources) {
      if (typeof resources.setInstructions === "function") {
        resources.setInstructions(plan.padded.cpuInstructions);
      }
      if (typeof resources.setReadBytes === "function") {
        resources.setReadBytes(plan.padded.readBytes);
      }
      if (typeof resources.setWriteBytes === "function") {
        resources.setWriteBytes(plan.padded.writeBytes);
      }
    }

    return tx;
  }

  // ----------------------------------------------------------------------
  // 4 & 5. Budget tracking, alerts, hard stop
  // ----------------------------------------------------------------------

  private checkBudget(plan: FeePlan): void {
    const { totalBudgetStroops, warnThresholdPct, hardStopThresholdPct, perOperationBudgetStroops } =
      this.budgetConfig;

    const projectedTotal = this.spentTotalStroops + plan.totalFeeStroops;
    const usagePct = projectedTotal / totalBudgetStroops;

    if (usagePct >= (hardStopThresholdPct ?? DEFAULT_HARD_STOP_THRESHOLD)) {
      this.alertHandler({
        level: "critical",
        message: `Relayer fee budget hard stop reached (${(usagePct * 100).toFixed(1)}%). Refusing to submit further transactions until budget is reset or increased.`,
        spentStroops: projectedTotal,
        budgetStroops: totalBudgetStroops,
      });
      throw new BudgetExceededError(
        `Fee budget exceeded: projected spend ${projectedTotal} stroops >= ${(hardStopThresholdPct ?? DEFAULT_HARD_STOP_THRESHOLD) * 100}% of ${totalBudgetStroops} stroops budget.`
      );
    }

    if (usagePct >= (warnThresholdPct ?? DEFAULT_WARN_THRESHOLD)) {
      this.alertHandler({
        level: "warn",
        message: `Relayer fee budget at ${(usagePct * 100).toFixed(1)}% of allowance.`,
        spentStroops: projectedTotal,
        budgetStroops: totalBudgetStroops,
      });
    }

    if (perOperationBudgetStroops?.[plan.operationType] != null) {
      const opBudget = perOperationBudgetStroops[plan.operationType];
      const opSpent = (this.spentByOperation[plan.operationType] ?? 0) + plan.totalFeeStroops;
      if (opSpent >= opBudget * (hardStopThresholdPct ?? DEFAULT_HARD_STOP_THRESHOLD)) {
        throw new BudgetExceededError(
          `Fee budget exceeded for operation "${plan.operationType}": ${opSpent} >= ${opBudget} stroops.`
        );
      }
    }
  }

  /** Call once a transaction actually lands, to record real spend + log deltas. */
  recordActual(
    plan: FeePlan,
    actualResources?: Partial<SimulatedResources>,
    actualFeeChargedStroops?: number
  ): UsageLogEntry {
    const fee = actualFeeChargedStroops ?? plan.totalFeeStroops;

    this.spentTotalStroops += fee;
    this.spentByOperation[plan.operationType] =
      (this.spentByOperation[plan.operationType] ?? 0) + fee;

    const pctDelta = (est: number, actual?: number) =>
      actual != null && est > 0 ? ((actual - est) / est) * 100 : undefined;

    const entry: UsageLogEntry = {
      timestamp: new Date().toISOString(),
      operationType: plan.operationType,
      estimated: plan.simulated,
      estimatedFeeStroops: plan.totalFeeStroops,
      actualFeeStroops: actualFeeChargedStroops,
      actualResources,
      deltaPct: {
        cpu: pctDelta(plan.simulated.cpuInstructions, actualResources?.cpuInstructions),
        memory: pctDelta(plan.simulated.memoryBytes, actualResources?.memoryBytes),
        readBytes: pctDelta(plan.simulated.readBytes, actualResources?.readBytes),
        writeBytes: pctDelta(plan.simulated.writeBytes, actualResources?.writeBytes),
        fee: pctDelta(plan.totalFeeStroops, actualFeeChargedStroops),
      },
    };

    this.usageLog.push(entry);
    return entry;
  }

  getBudgetStatus() {
    return {
      spentTotalStroops: this.spentTotalStroops,
      totalBudgetStroops: this.budgetConfig.totalBudgetStroops,
      usagePct: this.spentTotalStroops / this.budgetConfig.totalBudgetStroops,
      spentByOperation: { ...this.spentByOperation },
    };
  }

  getUsageLog(): UsageLogEntry[] {
    return [...this.usageLog];
  }

  // ----------------------------------------------------------------------
  // 6. Fee estimation "endpoint" for frontend cost display
  // ----------------------------------------------------------------------

  /**
   * Framework-agnostic handler you can wire into Express/Fastify/etc:
   *
   *   app.post("/api/fee-estimate", async (req, res) => {
   *     const result = await feeEstimator.estimateForDisplay(simResultForReq, "castVote");
   *     res.json(result);
   *   });
   */
  async estimateForDisplay(simResult: any, operationType: string) {
    const plan = await this.buildFeePlan(simResult, { operationType });
    return {
      operationType: plan.operationType,
      estimatedFeeStroops: plan.totalFeeStroops,
      estimatedFeeXLM: (plan.totalFeeStroops / 10_000_000).toFixed(7),
      congestionMultiplier: plan.congestionMultiplier,
      breakdown: {
        baseFeeStroops: plan.baseFeeStroops,
        resourceFeeStroops: plan.resourceFeeStroops,
      },
      safetyMarginPct: plan.safetyMarginPct,
    };
  }

  // ----------------------------------------------------------------------
  // 7. Accuracy report (for the "100+ transactions" acceptance criterion)
  // ----------------------------------------------------------------------

  /**
   * Summarizes estimate-vs-actual accuracy across all logged transactions.
   * Run this after accumulating >= 100 entries via recordActual().
   */
  getAccuracyReport() {
    const withActuals = this.usageLog.filter((e) => e.actualFeeStroops != null);
    if (withActuals.length === 0) {
      return { sampleSize: 0, message: "No recorded actuals yet." };
    }

    const feeDeltas = withActuals
      .map((e) => e.deltaPct?.fee)
      .filter((v): v is number => v != null);

    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const meanAbs = (arr: number[]) => mean(arr.map(Math.abs));

    return {
      sampleSize: withActuals.length,
      meanFeeDeltaPct: Number(mean(feeDeltas).toFixed(2)),
      meanAbsFeeDeltaPct: Number(meanAbs(feeDeltas).toFixed(2)),
      overEstimatedPct: Number(
        ((feeDeltas.filter((d) => d < 0).length / feeDeltas.length) * 100).toFixed(1)
      ),
      underEstimatedPct: Number(
        ((feeDeltas.filter((d) => d > 0).length / feeDeltas.length) * 100).toFixed(1)
      ),
    };
  }
}
