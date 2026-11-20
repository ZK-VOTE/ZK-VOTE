# Payment Abuse Detection Policy

**Status**: Detection implemented (SPIKE-147 / Issue #798); enforcement, case
linkage, and dual-control review implemented (ZV-111 / Issue #951)  
**Last Updated**: 2026-11-20

## Overview

ZK-VOTE relayer rails move funds via `/pay`, `/pay/batch`, `/ramp` endpoints without monitoring for financial abuse patterns. This policy defines detection for:

1. **Wash payments**: Self-dealing volume (sender↔receiver roundtrips)
2. **Structuring**: Splitting transactions to evade thresholds
3. **Mule convergence**: Many fresh accounts funneling to single receiver
4. **Rapid cycling**: Deposit → pay → withdraw in minutes (mixer-like behavior)

Detection operates within **privacy bounds**: metadata-only analysis, never links to vote nullifiers.

## Threat Model

### Abuse Typologies

| Pattern              | Description                                                                                        | Harm                                                           | Detection Signal                                               |
| -------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| **Wash Payments**    | A↔B roundtrip volume to simulate activity, farm rewards (cf. SPIKE-107)                            | Distorts governance participation metrics, drains reward pools | Same sender/receiver pair, high frequency within 1-hour window |
| **Structuring**      | Splitting large payment into many small ones just below thresholds (e.g., 9,999 instead of 10,000) | Evades reporting/governance limits, anti-abuse controls        | Multiple payments clustering at 95%+ of threshold within 24h   |
| **Mule Convergence** | Many accounts (possibly Sybil-funded per SPIKE-093) converge funds to single receiver              | Money laundering, proceeds consolidation                       | 10+ unique senders to one destination in 24h                   |
| **Rapid Cycling**    | Deposit (ramp) → pay → withdraw (ramp) in <15 minutes                                              | Mixer-adjacent behavior, obfuscation                           | Ramp inflow followed by outflow with minimal dwell time        |

### Privacy Boundaries (Red Lines)

**Never analyzed**:

- Vote nullifiers or ballot commitments
- DAO membership proofs
- Cross-subsystem joins (ramp identity ↔ voting activity)

**Only analyzed**:

- Payment timing (inter-arrival, batch frequency)
- Destination clustering (who pays whom, how often)
- Amount patterns (threshold proximity, structuring signals)
- Tenant-level aggregates (cross-payment volume)

Detection must not become **deanonymization oracle** - e.g., timing graphs that rebuild vote linkage via payment correlation.

## Detection Algorithms

### 1. Structuring Detection

```typescript
detectStructuring(payments: PaymentMetadata[], windowMs: number): AbuseDetectionResult
```

**Logic**:

- Filter payments within last 24 hours (default)
- Count payments where `amount >= threshold * 0.95` and `amount < threshold`
- Flag if ≥5 such payments detected

**Threshold**: 10,000 XLM equivalent (configurable via `ABUSE_THRESHOLDS.STRUCTURING_AMOUNT`)

**False Positives**: Legitimate high-volume users (e.g., payroll batches). Mitigation: confidence scoring + manual review queue.

### 2. Wash Payment Detection

```typescript
detectWashPayments(payments: PaymentMetadata[], windowMs: number): AbuseDetectionResult
```

**Logic**:

- Build sender→receiver pair frequency map
- Sort pairs (to detect bidirectional flows: A→B and B→A)
- Flag if any pair has ≥3 transactions within 1 hour

**Window**: 1 hour (default)

**False Positives**: Legitimate back-and-forth (e.g., escrow refunds). Mitigation: review context (refund reason codes).

### 3. Mule Convergence Detection

```typescript
detectMuleConvergence(destination: string, windowMs: number): AbuseDetectionResult
```

**Logic**:

- Query `payment_jobs` table for payments to `destination` in last 24h
- Count unique `tenant_id` senders
- Sum total amount
- Flag if ≥10 unique senders AND ≥1,000 XLM total

**Window**: 24 hours

**False Positives**: Legitimate payment hubs (exchanges, merchants). Mitigation: allowlist known hubs.

### 4. Rapid Cycling (Future)

**Not yet implemented** - requires ramp event correlation:

- Track deposit timestamp (from `/ramp/deposit`)
- Track withdrawal timestamp (from `/ramp/withdraw`)
- Flag if dwell time <15 minutes

## Integration

### Batch Payment Analysis

`analyzeBatchPayment()` runs all detection algorithms on `/pay/batch` requests:

1. Fetch recent payment history for `tenant_id` (last 24h, max 100 records)
2. Add current batch to analysis
3. Run structuring, wash, and mule detection
4. Combine results with confidence scoring

### Response Actions (Graduated Enforcement, ZV-111)

`determineAction()` in `abuseDetection.ts` maps a detection's confidence to a
graduated action. Detection was previously advisory only; HOLD and BLOCK now
call `placeOnHold()`, which opens a linked dispute case and persists an
audited reason code - this is the enforcement hook the original policy was
missing.

| Confidence                    | Action    | Effect                                                              |
| ------------------------------ | --------- | --------------------------------------------------------------------- |
| Not suspicious                 | NONE      | Allow payment, no record                                               |
| < 0.5 (Low)                     | FLAG      | Log only, allow payment (unchanged from the original behavior)         |
| 0.5-0.89 (Medium)               | **HOLD**  | **Deny the request (423), open a `payment_holds` row + dispute case, pending dual-control review** |
| ≥ 0.9 (High)                    | **BLOCK** | **Deny the request (403), open a `payment_holds` row + dispute case, pending dual-control review** |

A HOLD or BLOCK response carries the hold and case ids so a client/operator
can reference them directly:

```json
{
  "error": "Payment batch held pending dual-control review",
  "patterns": ["structuring"],
  "reviewRequired": true,
  "holdId": "f0b6...",
  "disputeCaseId": "9ac2..."
}
```

Thresholds (`ABUSE_THRESHOLDS.HOLD_CONFIDENCE` / `BLOCK_CONFIDENCE`) are
versioned via `ABUSE_THRESHOLDS_VERSION`, which is stamped onto every hold
row so historical holds stay interpretable after a tuning change, and is
exercised by labelled drill fixtures in
`backend/test/abuse-enforcement.test.ts` (see Testing, below).

### Case Linkage (EPIC-006 Dispute Center)

Every HOLD/BLOCK creates one `dispute_cases` row (`class = 'payment'`)
linked to its `payment_holds` row by `hold_id`, with a metadata-only
evidence bundle (pattern list, confidence, opsCount, destination fanout,
and the per-detector metadata already described above). `assertNoVoteLinkage()`
is run against every evidence bundle before it is written and throws if the
object contains a nullifier, membership proof, DAO id, or proposal id key at
any depth - evidence can never become a deanonymization oracle, even by
accident in a future edit.

### Audit Trail

`recordAbuseDetection()` logs to `audit_log` table:

- `event_type`: "abuse_detection"
- `actor_type`: "system"
- `metadata`: JSON with patterns, confidence, context

Retention: Same as audit logs (compliance-driven, typically 1+ years).

## Metrics

Prometheus metrics for monitoring (`metrics.ts`):

- `zkvote_abuse_detection_total{pattern, confidence_level}`: Total detections by pattern
- `zkvote_abuse_pattern_confidence{pattern}`: Confidence distribution histogram
- `zkvote_suspicious_payment_volume_stroops{pattern}`: Flagged transaction volume
- `zkvote_payment_destination_fanout`: Unique destinations per batch (mule signal)

### Alerting Rules (Proposed)

Add to `monitoring/prometheus/zkvote-alerts.yml`:

```yaml
- alert: HighAbuseDetectionRate
  expr: rate(zkvote_abuse_detection_total[5m]) > 0.1
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "High abuse detection rate (>6/min sustained)"

- alert: HighConfidenceAbuse
  expr: increase(zkvote_abuse_detection_total{confidence_level="high"}[1h]) > 5
  labels:
    severity: critical
  annotations:
    summary: "Multiple high-confidence abuse detections (manual review needed)"
```

## Review Workflow

**Review Queue** (ZV-111):

1. **Queue API**: `GET /admin/abuse/holds` (filter by `tenantId`/`status`) and
   `GET /admin/abuse/holds/:id` return each hold's reason code, patterns,
   confidence, thresholds version, and evidence bundle (metadata-only; see
   Case Linkage above). Both require the operator auth token.

2. **Dual-control release**: `POST /admin/abuse/holds/:id/review` takes
   `{ reviewerId, reason }` and requires the relayer master key. The first
   call moves a `held` hold to `pending_release`; a *second* call from a
   **different** `reviewerId` releases it and resolves the linked dispute
   case. A reviewer calling twice with the same id gets a 409 ("Dual control
   violation"). There is no single-operator path to clear a hold.

3. **Actions available today**: release (clear after review) or leave held
   pending escalation. Allowlisting a tenant going forward and a
   legal/compliance SAR-style escalation path are still manual (see
   Limitations).

4. **Audit**: `placeOnHold()` and `reviewHold()` log structured events
   (`abuse_enforcement_hold_created`, `abuse_hold_first_review`,
   `abuse_hold_released`) in addition to the existing `audit_log` write from
   `recordAbuseDetection()`.

## Red-Team Calibration

Detection effectiveness should be measured via **synthetic abuse campaigns**:

### Drill Scenarios

1. **Structuring Drill**:
   - Generate 10 payments of 9,900 XLM each in 24h
   - Expected: Detection with confidence ≥0.8

2. **Wash Drill**:
   - A→B and B→A, 5 roundtrips in 1 hour
   - Expected: Detection with confidence ≥0.9

3. **Mule Drill**:
   - 15 unique tenants → single destination, 20,000 XLM total in 24h
   - Expected: Detection with confidence ≥0.9

4. **False Positive Drill**:
   - Legitimate payroll batch (50 employees, regular amounts)
   - Expected: No detection (or low confidence <0.3)

### Metrics to Track

- **Detection rate**: % of synthetic abuse caught
- **False positive rate**: % of legitimate activity flagged
- **Time to detect**: Delay between abuse start and first flag

## Compliance Mapping

**Legal review required** to determine obligations:

- **FinCEN guidance** (US): Suspicious Activity Report (SAR) thresholds
- **EU 5AMLD**: Enhanced due diligence for high-risk patterns
- **Jurisdiction-specific**: Per-country reporting duties

This implementation **enables compliance** but does not **decide** it. Legal counsel determines:

- Which patterns require reporting (vs. internal monitoring only)
- SAR filing thresholds (if applicable)
- Data retention for reported vs. non-reported detections

## Limitations

1. **Cross-tenant blind spot**: Current detection scopes to single `tenant_id`. Coordinated abuse across tenants not detected.
2. **Ramp event correlation**: Rapid cycling detection requires ramp telemetry integration (not yet built).
3. **Allowlist management**: Releasing a hold (dual control) clears that specific hold, but there is still no standing allowlist UI for analysts to pre-clear a recognized legitimate high-volume user (manual DB edits only).
4. **Appeal path**: Users held/blocked by detection have no self-service appeal; they see `holdId`/`disputeCaseId` in the response but resolution still requires an operator to run the dual-control review (requires support ticket).
5. **No async re-submission**: `/pay/batch` is synchronous, so a HOLD/BLOCK rejects the original request outright; releasing the hold does not retry the original payment - the client must resubmit after release.

## Testing

### Unit Tests

- [x] Structuring: 5+ payments at 95%+ threshold flagged (`backend/tests/abuseDetection.test.ts`)
- [x] Wash: 3+ roundtrips in 1h flagged (`backend/tests/abuseDetection.test.ts`)
- [ ] Mule: 10+ senders to one destination flagged (requires a seeded `payment_jobs` fixture; not yet added)
- [x] Privacy boundary: evidence bundles are asserted free of nullifier/membership/dao/proposal keys at any depth (`assertNoVoteLinkage`, `backend/test/abuse-enforcement.test.ts`)

### Enforcement & Case-Linkage Tests (ZV-111)

`backend/test/abuse-enforcement.test.ts` runs against a real (temp-file)
SQLite database with migrations applied:

- [x] `determineAction` maps confidence to flag/hold/block tiers
- [x] `placeOnHold` opens a linked dispute case with a privacy-clean evidence bundle, and rejects tainted evidence before it is ever written
- [x] `reviewHold` dual control: same reviewer cannot release their own hold; a second, distinct reviewer can
- [x] Already-released holds cannot be re-reviewed

### Integration Tests

- [x] `/pay/batch` with a block-tier pattern returns 403 with `holdId`/`disputeCaseId`
- [x] `/pay/batch` with a hold-tier pattern returns 423 with `holdId`/`disputeCaseId`
- [ ] Low-confidence detection allows payment, logs audit (covered at the unit level; no route-level test yet)
- [ ] Metrics increment correctly per pattern (`zkvote_payment_holds_total`; no route-level test yet)

### Red-Team Drills

- [x] Synthetic structuring campaign reaches hold/block, not flag-only (`backend/test/abuse-enforcement.test.ts`)
- [ ] Synthetic wash payments detected
- [ ] Synthetic mule convergence detected
- [x] Legitimate payroll batch NOT held or blocked (false positive test, `backend/test/abuse-enforcement.test.ts`)

## Future Enhancements

1. **Differential privacy**: Aggregate detectors with provable query bounds (no vote linkage reconstruction)
2. **Machine learning**: Train on historical abuse corpus (if available)
3. **Cross-chain correlation**: Detect abuse spanning Stellar + other chains (if multichain support added)
4. **Real-time scoring**: Per-account abuse score updated on every payment (vs. per-batch analysis)

## References

- `backend/src/services/abuseDetection.ts` - Core detection logic, graduated enforcement (`determineAction`, `placeOnHold`, `reviewHold`), and the privacy guard (`assertNoVoteLinkage`)
- `backend/src/routes/pay.ts` - Integration with batch payments
- `backend/src/routes/admin.ts` - `/admin/abuse/holds` review queue and dual-control release
- `backend/src/migrations/017_abuse_enforcement_dispute_cases.up.sql` - `payment_holds` / `dispute_cases` schema
- `backend/src/services/metrics.ts` - Prometheus metrics
- `backend/test/abuse-enforcement.test.ts` - Enforcement, dual-control, and labelled-drill regression tests
- SPIKE-147 (Issue #798) - Original spike specification
- ZV-111 (Issue #951) - Enforcement, case linkage, and dual-control review
- THREAT_MODEL.md - Updated threat actors (to be added)
