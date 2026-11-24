# SPIKE-139: Product Analytics Privacy Analysis

## Executive Summary

**Status**: Investigation Complete  
**Date**: October 15, 2026  
**Investigator**: d-plug

## Current State Assessment

### Existing Privacy-Preserving Analytics Implementation

The codebase **already has** a sophisticated privacy-preserving analytics system:

1. **Homomorphic Encryption Pipeline** (`backend/src/services/privacy-analytics.ts`)
   - ElGamal encryption under DAO DKG joint public key
   - Homomorphic addition for aggregating encrypted contributions
   - Threshold decryption with k-anonymity floor (min_cohort)
   - Differential privacy budget (ε) enforcement
   - Single-decrypt semantics (aggregate cannot be re-decrypted)

2. **First-Party Analytics** (`backend/src/services/analytics.ts`)
   - SQL-aggregated metrics (no per-vote row materialisation)
   - DAO overview, proposal turnout, participation time series
   - Event partitioning per DAO for data isolation
   - CSV export with formula injection prevention

3. **Privacy-Aware Frontend** (`frontend/src/lib/analytics.ts`, `frontend/src/components/AnalyticsPanel.tsx`)
   - Client-side encryption demonstration
   - Privacy budget display
   - No third-party analytics SDKs

### Identified Gaps

1. **Linkage Surface Analysis**
   - **Contribution timing**: `accumulateContribution` timestamps could fingerprint voting sessions
   - **Contribution count increments**: Sequential cohort sizes leak participation timing
   - **Single-decrypt state leakage**: Post-decryption aggregate state persists indefinitely

2. **Plain Turnout Path** (`backend/src/services/analytics.ts:449`)
   - `getProposalTurnout()` returns per-proposal vote counts **without suppression**
   - Small proposal sets (e.g., 1-2 voters) violate k-anonymity
   - No k-floor applied to plain turnout queries

3. **Missing Consent UI**
   - No user-facing consent prompt or disclosure
   - No localized privacy policy for analytics
   - No opt-in/opt-out mechanism

4. **No Telemetry Retention Policy**
   - Analytics aggregates persist forever
   - No linkage review of retention vs SPIKE-129 requirements
   - Encrypted aggregates stored in `analytics_aggregates` table without TTL

## Tier-1 Adversarial Extension

### Attack Vectors

1. **Timing Correlation**
   - Accumulate timestamps + decrypt state expose cohort formation timing
   - Cross-reference with on-chain vote timestamps to narrow down voters

2. **Count-Based Fingerprinting**
   - `contribution_count` increments create a participation timeline
   - Even with encrypted ciphertexts, the **shape** of accumulation leaks information

3. **Small-Cohort Exploitation**
   - Plain turnout path allows arbitrary queries
   - Attacker can request per-proposal turnout for proposals with 1-2 voters
   - Combine with DAO member list to deanonymize

4. **Differential Privacy Budget Gaming**
   - Current ε-budget has no adversarial calibration
   - Attacker could slice cohorts strategically to exhaust budget and block legitimate analytics

## Recommendations

### Immediate (High Priority)

1. **Apply k-Anonymity to Plain Turnout Path**

   ```typescript
   // In getProposalTurnout()
   if (votesCast < MIN_COHORT_SIZE) {
     return { votesCast: "< 5", turnoutRatio: null, suppressed: true };
   }
   ```

2. **Implement Contribution Timing Jitter**

   ```typescript
   // In accumulateContribution()
   const jitteredTimestamp = new Date(Date.now() + Math.random() * 3600000); // ±1 hour
   ```

3. **Add Privacy Budget Adversarial Review**
   - Document ε calibration methodology
   - Add tests for slice-and-dice attacks
   - Implement budget warning thresholds

4. **Implement Consent Flow**
   - Add frontend consent modal on first analytics view
   - Store consent state in localStorage (privacy-safe)
   - Localize consent text for i18n compliance

### Medium Priority

5. **Retention Policy for Analytics**
   - Document aggregate TTL (e.g., 90 days)
   - Implement automatic purge of expired aggregates
   - Add migration to set `expires_at` column

6. **Linkage Review with SPIKE-007 Methods**
   - Apply timing-based classifiers to accumulated contributions
   - Test if count + timing signals can recover voter identities
   - Document attack scenarios and mitigations

### Future Work

7. **Third-Party SDK Audit** (Not Needed - None Present)
   - Confirmed: No external analytics SDKs in codebase
   - All analytics are first-party via `/api/v1/analytics`

8. **Differential Privacy Research**
   - Consider Laplace noise addition to aggregates
   - Evaluate privacy-utility tradeoff for DAO use case

## Acceptance Criteria Status

| Criterion                         | Status     | Evidence                                                        |
| --------------------------------- | ---------- | --------------------------------------------------------------- |
| Telemetry survives linkage review | ⚠️ PARTIAL | Encrypted aggregates safe; timing/count signals need mitigation |
| Product questions answerable      | ✅ PASS    | DAO overview, turnout, participation time series implemented    |
| No third-party analytics          | ✅ PASS    | Confirmed first-party only                                      |
| Consent honest + localized        | ❌ FAIL    | No consent UI implemented                                       |
| Retention enforced                | ❌ FAIL    | No TTL policy or automatic purge                                |

## Implementation Recommendations

### Phase 1: Security Hardening (24h)

- k-anonymity suppression in plain turnout path
- Contribution timing jitter
- ε-budget adversarial calibration documentation

### Phase 2: Compliance (48h)

- Consent flow UI with i18n
- Retention policy implementation
- Privacy policy documentation

### Phase 3: Adversarial Testing (72h)

- Linkage review with classifier methods
- Budget exhaustion attack tests
- Forensic analysis of persisted aggregates

## References

- Issue: https://github.com/ZK-VOTE/ZK-VOTE/issues/793
- Existing implementation: `backend/src/services/privacy-analytics.ts`
- Plain analytics: `backend/src/services/analytics.ts`
- Frontend: `frontend/src/lib/analytics.ts`
