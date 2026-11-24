# SPIKE-141: Soroban Simulation Integration Analysis

## Executive Summary

**Status**: Investigation Complete  
**Date**: October 15, 2026  
**Investigator**: d-plug

## Current State Assessment

### Existing Simulation Usage

**Correction to Issue Description**: The claim "no call site uses simulation" is **FALSE**.

**Confirmed simulation coverage:**

1. **Vote Submission Path** (`backend/src/routes/voting.ts:890`)

   ```typescript
   const simulationResult = await simulateWithBackoff(/* ... */);
   if (simulationResult.error) {
     return res.status(400).json({
       error: "VOTE_REJECTED",
       reason: classifySimulationError(simulationResult),
     });
   }
   ```

2. **Relayer Quorum Submission** (`backend/src/services/stellar.ts:1242`)

   ```typescript
   export async function submitVoteViaRelayerQuorum(
     params: VoteSubmissionParams & { simulationResult: SimulationResult },
   ): Promise<string>;
   ```

   **Requires** `simulationResult` parameter with auth assembly.

3. **Shared Simulation Helper** (`stellar.ts:768`)

   ```typescript
   export async function simulateWithBackoff<T>(
     simulateFn: () => Promise<T>,
     attempts = 3,
   ): Promise<T>;
   ```

4. **Test Mode Bypass** (`stellar.ts:632`)
   ```typescript
   if (testMode) {
     return {
       result: { error: "SIMULATION_DISABLED_IN_TEST_MODE" },
     };
   }
   ```

### Confirmed Coverage (14+ Call Sites)

**Files with `simulateTransaction` or `simulateWithBackoff`:**

- Vote path (`routes/voting.ts`)
- Claim path (`routes/claims.ts`)
- Comment path (`routes/comments.ts`)
- Bridge path (`routes/bridge.ts`)
- TTL extension (`services/ttl.ts`)
- Payment flows (`services/payments.ts`)
- Swap flows (`services/swap.ts`)

## The Real Gap: Ledger-Gap TOCTOU Policy

### Simulate-Then-Submit Race Condition

**Problem**: State changes between `simulateTransaction` and `submitTransaction`.

**Attack Scenario:**

1. Relayer simulates vote at ledger N → PASS (root valid, TTL live, balance sufficient)
2. **3 seconds elapse** (typical submission time)
3. Adversary front-runs with root rollover → ledger N+5
4. Relayer submits original transaction → FAIL (root expired)
5. User pays fee, nullifier consumed, vote rejected

**Current Mitigation**: None. No re-simulation threshold or divergence fallback.

### Ledger-Gap Policy Requirements

1. **Re-Simulation Threshold**
   - If `current_ledger - simulation_ledger > THRESHOLD`, re-simulate
   - Suggested threshold: 5 ledgers (~25 seconds on Stellar)

2. **Divergence Fallback UX**
   - Classify divergence reason (root expiry, TTL, balance, auth)
   - Map to user recovery action per SPIKE-134 error language

3. **Optimistic Submit vs Re-Simulate**
   - Fast path: optimistic submit without re-check (latency-sensitive)
   - Safe path: always re-simulate if ledger advanced
   - **Trade-off**: Latency vs reliability

## Tier-1 Adversarial Extension

### Attack: Front-Running Root Rollover

**Exploit**: Attacker monitors mempool for root updates, front-runs simulation window.

**Impact**:

- Simulate-then-submit becomes fee-paying failure
- Retry storm (relayer keeps retrying with stale root)
- Preflight **amplifies** the attack instead of defending

**Defense**:

1. **Re-simulation on ledger advance**

   ```typescript
   const simulatedLedger = simulationResult.latestLedger;
   const currentLedger = await server.getLatestLedger();
   if (currentLedger.sequence - simulatedLedger > 5) {
     // Re-simulate with fresh state
     simulationResult = await simulateWithBackoff(/* ... */);
   }
   ```

2. **Divergence classification**

   ```typescript
   enum DivergenceReason {
     ROOT_EXPIRED = "Root expired between simulation and submission",
     TTL_EXPIRED = "Storage TTL expired",
     BALANCE_INSUFFICIENT = "Balance changed",
     AUTH_FAILED = "Authorization invalidated",
     UNKNOWN = "Unknown divergence",
   }
   ```

3. **Budget RPC traffic**
   - Simulation doubles RPC load
   - Implement simulation result caching (keyed by `{contract, params, ledger}`)
   - Cache TTL = 1 ledger (~5 seconds)

## Recommendations

### Phase 1: Ledger-Gap Policy (24h)

1. **Implement Re-Simulation Threshold**

   ```typescript
   // backend/src/services/stellar.ts

   interface SubmissionContext {
     simulationResult: SimulationResult;
     simulatedLedger: number;
     maxLedgerGap: number;
   }

   async function submitWithGapCheck(
     ctx: SubmissionContext,
     txBuilder: () => Promise<Transaction>,
   ): Promise<string> {
     const currentLedger = await server.getLatestLedger();
     const gap = currentLedger.sequence - ctx.simulatedLedger;

     if (gap > ctx.maxLedgerGap) {
       log("info", "ledger_gap_detected", { gap, threshold: ctx.maxLedgerGap });

       // Re-simulate with fresh state
       ctx.simulationResult = await simulateWithBackoff(() =>
         server.simulateTransaction(await txBuilder()),
       );
       ctx.simulatedLedger = currentLedger.sequence;
     }

     return submitTransactionWithRecovery(await txBuilder());
   }
   ```

2. **Divergence Classification**

   ```typescript
   function classifyDivergence(
     simulationResult: SimulationResult,
     submissionError: Error,
   ): DivergenceReason {
     if (submissionError.message.includes("root")) {
       return DivergenceReason.ROOT_EXPIRED;
     }
     if (submissionError.message.includes("ttl")) {
       return DivergenceReason.TTL_EXPIRED;
     }
     if (submissionError.message.includes("balance")) {
       return DivergenceReason.BALANCE_INSUFFICIENT;
     }
     if (submissionError.message.includes("auth")) {
       return DivergenceReason.AUTH_FAILED;
     }
     return DivergenceReason.UNKNOWN;
   }
   ```

3. **User-Facing Divergence Messages**
   ```typescript
   const DIVERGENCE_RECOVERY: Record<DivergenceReason, string> = {
     [DivergenceReason.ROOT_EXPIRED]:
       "Membership tree updated during submission. Refresh and retry.",
     [DivergenceReason.TTL_EXPIRED]:
       "Storage expired. Restore state and retry.",
     [DivergenceReason.BALANCE_INSUFFICIENT]:
       "Balance changed. Check account and retry.",
     [DivergenceReason.AUTH_FAILED]:
       "Authorization expired. Re-authenticate and retry.",
     [DivergenceReason.UNKNOWN]:
       "Submission failed. Contact support with transaction ID.",
   };
   ```

### Phase 2: RPC Budget Management (48h)

4. **Simulation Result Caching**

   ```typescript
   // backend/src/services/simulationCache.ts

   interface CacheKey {
     contractId: string;
     method: string;
     params: string; // JSON.stringify(params)
     ledger: number;
   }

   const simulationCache = new Map<string, SimulationResult>();

   function cacheKey(key: CacheKey): string {
     return `${key.contractId}:${key.method}:${key.params}:${key.ledger}`;
   }

   export async function simulateWithCache(
     ctx: SimulationContext,
   ): Promise<SimulationResult> {
     const currentLedger = await server.getLatestLedger();
     const key = cacheKey({
       contractId: ctx.contractId,
       method: ctx.method,
       params: JSON.stringify(ctx.params),
       ledger: currentLedger.sequence,
     });

     if (simulationCache.has(key)) {
       return simulationCache.get(key)!;
     }

     const result = await simulateWithBackoff(ctx.simulateFn);
     simulationCache.set(key, result);

     // Cache eviction: TTL = 1 ledger (~5 seconds)
     setTimeout(() => simulationCache.delete(key), 5000);

     return result;
   }
   ```

5. **RPC Load Monitoring**

   ```typescript
   // backend/src/services/stellar.ts

   let simulationCount = 0;
   let submissionCount = 0;

   setInterval(() => {
     const ratio = simulationCount / (submissionCount || 1);
     log("info", "rpc_simulation_ratio", {
       simulations: simulationCount,
       submissions: submissionCount,
       ratio,
     });

     if (ratio > 2.5) {
       log("warn", "excessive_simulation_rate", { ratio });
     }

     simulationCount = 0;
     submissionCount = 0;
   }, 60000); // Every minute
   ```

### Phase 3: Fee Accuracy from Simulation (72h)

6. **Extract Resource Fees from Simulation**

   ```typescript
   // Integrate with src/feeEstimator.ts

   const simulatedResources = feeEstimator.parseSimulation(simulationResult);
   const resourceFee = feeEstimator.calculateResourceFee(simulatedResources);

   log("info", "simulation_fee_estimate", {
     cpuInstructions: simulatedResources.cpuInstructions,
     memoryBytes: simulatedResources.memoryBytes,
     readBytes: simulatedResources.readBytes,
     writeBytes: simulatedResources.writeBytes,
     estimatedFee: resourceFee
   });

   // Use estimated fee in transaction builder
   txBuilder.addOperation(
     Operation.invokeContractFunction({
       /* ... */,
       fee: resourceFee.toString()
     })
   );
   ```

## Testing Strategy

### Ledger-Gap Drill

```typescript
// tests/integration/ledger-gap.test.ts

describe("Ledger-gap divergence handling", () => {
  it("re-simulates when ledger advances beyond threshold", async () => {
    const { simulationResult, ledger } = await simulateVote(voteParams);

    // Advance ledger by 10 (exceeds threshold of 5)
    await advanceLedger(10);

    // Submission should trigger re-simulation
    const txHash = await submitWithGapCheck(
      {
        simulationResult,
        simulatedLedger: ledger,
        maxLedgerGap: 5,
      },
      () => buildVoteTx(voteParams),
    );

    expect(txHash).toBeTruthy();
    expect(simulationCount).toBe(2); // Initial + re-simulation
  });

  it("classifies divergence on root expiry", async () => {
    const { simulationResult } = await simulateVote(voteParams);

    // Expire root between simulation and submission
    await rolloverMerkleRoot();

    try {
      await submitTransaction(buildVoteTx(voteParams));
      fail("Should have thrown");
    } catch (error) {
      const reason = classifyDivergence(simulationResult, error);
      expect(reason).toBe(DivergenceReason.ROOT_EXPIRED);
    }
  });
});
```

### Doomed-Vote Interception Rate

```typescript
// tests/metrics/simulation-intercept-rate.test.ts

let interceptedVotes = 0;
let totalVotes = 0;

it("measures doomed-vote interception rate", async () => {
  // Submit 100 votes with various failures
  for (let i = 0; i < 100; i++) {
    const result = await simulateVote(generateVoteParams());
    totalVotes++;

    if (result.error) {
      interceptedVotes++;
      log("info", "doomed_vote_intercepted", {
        reason: result.error,
        savedFee: estimateFee(result),
      });
    }
  }

  const interceptionRate = interceptedVotes / totalVotes;
  log("info", "simulation_intercept_rate", {
    interceptedVotes,
    totalVotes,
    rate: interceptionRate,
  });

  expect(interceptionRate).toBeGreaterThan(0.1); // At least 10% interception
});
```

## Acceptance Criteria Status

| Criterion                         | Status     | Evidence                              |
| --------------------------------- | ---------- | ------------------------------------- |
| Simulate-first coverage           | ✅ PASS    | 14+ call sites confirmed              |
| Ledger-gap policy enforced        | ❌ FAIL    | No re-simulation threshold            |
| Doomed submissions intercepted    | ⚠️ PARTIAL | Simulation exists but no gap handling |
| Simulation errors map to recovery | ❌ FAIL    | No divergence classification          |
| RPC budget covers simulation      | ❌ FAIL    | No caching or monitoring              |

## Tier-1 Additions

| Criterion                                           | Status  |
| --------------------------------------------------- | ------- |
| Ledger-gap policy enforced (re-simulate on advance) | ❌ TODO |
| Divergence drill converges                          | ❌ TODO |
| RPC budget covers doubled traffic                   | ❌ TODO |

## References

- Issue: https://github.com/ZK-VOTE/ZK-VOTE/issues/795
- Stellar service: `backend/src/services/stellar.ts`
- Fee estimator: `src/feeEstimator.ts`
- Vote routes: `backend/src/routes/voting.ts`
