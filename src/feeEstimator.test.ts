/**
 * feeEstimator.test.ts
 * -----------------------------------------------------------------------
 * Validates FeeEstimator against 100+ synthetic transactions to satisfy
 * acceptance criterion: "Test fee estimation accuracy over 100+ transactions."
 *
 * Run with: npx ts-node feeEstimator.test.ts
 * (or wire into your existing Jest/Mocha setup by replacing the assert
 * calls with your framework's matchers).
 * -----------------------------------------------------------------------
 */

import { FeeEstimator, SorobanServerLike, BudgetExceededError } from "./feeEstimator";
import assert from "assert";

// A fake Soroban server whose getFeeStats() returns varying congestion.
function makeFakeServer(congestionPct: number): SorobanServerLike {
  return {
    async getFeeStats() {
      return {
        sorobanInclusionFee: { p10: 100, p50: 250, p90: 800, p99: 2000 },
        ledgerCapacityUsage: congestionPct / 100,
      };
    },
  };
}

// Generates a synthetic simulation response with some randomized "true"
// resource usage plus simulated (estimated) usage that's close but not
// identical, mimicking real-world estimate/actual drift.
function makeSyntheticSimResult(seed: number) {
  const baseCpu = 500_000 + (seed % 17) * 25_000;
  const baseMem = 50_000 + (seed % 9) * 4_000;
  const readBytes = 2_000 + (seed % 5) * 500;
  const writeBytes = 1_000 + (seed % 4) * 300;
  const minResourceFee = 5_000 + (seed % 11) * 400;

  return {
    cost: { cpuInsns: baseCpu, memBytes: baseMem },
    transactionData: {
      resources: () => ({
        readBytes: () => readBytes,
        writeBytes: () => writeBytes,
        footprint: () => ({ readOnly: () => [1, 2], readWrite: () => [1] }),
      }),
    },
    minResourceFee,
    events: [],
  };
}

// Simulates what actually happens on-chain: usage drifts randomly (+/-15%)
// from the simulated estimate, representing real network variance.
function simulateActualOutcome(simResult: any, seed: number) {
  const drift = (val: number, pct: number) => Math.round(val * (1 + pct));
  const jitter = ((seed * 37) % 30 - 15) / 100; // -15% .. +15%

  return {
    actualResources: {
      cpuInstructions: drift(simResult.cost.cpuInsns, jitter),
      memoryBytes: drift(simResult.cost.memBytes, jitter),
      readBytes: drift(simResult.transactionData.resources().readBytes(), jitter),
      writeBytes: drift(simResult.transactionData.resources().writeBytes(), jitter),
    },
    // Actual fee charged is typically close to what we submitted, since
    // Stellar refunds unused resource fee -- model that refund behavior.
    actualFeeStroops: null as number | null, // filled in by caller using the plan
  };
}

async function run() {
  const NUM_TRANSACTIONS = 120; // satisfies "100+ transactions"
  const operationTypes = ["castVote", "registerVoter", "tallyResults"];

  const estimator = new FeeEstimator(makeFakeServer(65), {
    budget: { totalBudgetStroops: 50_000_000, warnThresholdPct: 0.8, hardStopThresholdPct: 0.98 },
    safetyMarginPct: 0.2,
  });

  let budgetErrorsHit = 0;

  for (let i = 0; i < NUM_TRANSACTIONS; i++) {
    const opType = operationTypes[i % operationTypes.length];
    const simResult = makeSyntheticSimResult(i);

    let plan;
    try {
      plan = await estimator.buildFeePlan(simResult, { operationType: opType });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budgetErrorsHit++;
        continue;
      }
      throw err;
    }

    // Sanity checks on the plan itself
    assert.ok(plan.totalFeeStroops > 0, "fee must be positive");
    assert.ok(
      plan.padded.cpuInstructions >= plan.simulated.cpuInstructions,
      "padded CPU must be >= simulated CPU"
    );
    assert.ok(
      plan.padded.cpuInstructions <= plan.simulated.cpuInstructions * 1.21,
      "padding should be ~20% (allowing rounding)"
    );

    const outcome = simulateActualOutcome(simResult, i);
    // Model a network refund: actual fee charged is generally the resource
    // portion scaled to actual usage, plus the fixed base fee.
    const usageRatio =
      outcome.actualResources.cpuInstructions / plan.padded.cpuInstructions;
    const actualFee = Math.round(
      plan.baseFeeStroops + plan.resourceFeeStroops * Math.min(1, usageRatio)
    );

    estimator.recordActual(plan, outcome.actualResources, actualFee);
  }

  const report = estimator.getAccuracyReport();
  console.log("=== Fee Estimation Accuracy Report ===");
  console.log(report);
  console.log("Budget status:", estimator.getBudgetStatus());
  console.log("Budget hard-stop triggers hit:", budgetErrorsHit);

  // Assertions validating the acceptance criterion:
  assert.ok(report.sampleSize >= 100, "must have tested over 100+ transactions");
  assert.ok(
    Math.abs(report.meanAbsFeeDeltaPct as number) < 30,
    "average fee estimation error should stay reasonably bounded (<30%) given the safety margin"
  );

  console.log("\nAll assertions passed. ✅");
}

run().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
