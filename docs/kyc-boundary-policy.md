# KYC Boundary Policy

**Status**: Implemented (SPIKE-146 / Issue #797)  
**Last Updated**: 2026-10-15

## Overview

ZK-VOTE integrates SEP-6/24/31 anchor flows (Circle/Tempo) for fiat on/off-ramps adjacent to an anonymous voting product. This creates a critical boundary between:

- **Verified-ramp subsystem**: Identity-checked fiat flows (KYC required by anchors)
- **Anonymous-voting subsystem**: Privacy-preserving ballot casting (zero-knowledge proofs)

This document defines how KYC-adjacent data from anchors is handled to prevent:

1. Over-collection of identity data beyond operational necessity
2. Deanonymization of voters via ramp↔ballot linkage
3. Confused user mental models about anonymity boundaries

## Architecture

### Data Minimization

**Status-only ingestion** enforced at parser level (`kycBoundary.ts`):

```typescript
export interface MinimizedKYCState {
  status: KYCStatus; // completed | pending_* | error | incomplete
  reasonCode?: KYCReasonCode; // kyc_required | verification_in_progress | ...
  interactiveUrl?: string; // For user action (validated separately)
  interactiveOrigin?: string;
  timestamp: number; // For retention policy
}
```

**Rejected fields** (never stored):

- Identity documents (passports, driver's licenses, etc.)
- Detailed anchor metadata (KYC provider names, document types, etc.)
- Verbose error messages containing PII
- Any anchor-specific tracking identifiers beyond status codes

### Enforcement

`enforceMinimizationBoundary()` validates anchor responses before processing:

- Detects excess fields beyond allowed set
- Logs violations with field names (first 10 only)
- **Strict mode** (`KYC_STRICT_MODE=true`): Rejects responses with excess fields

`minimizeKYCResponse()` maps anchor statuses to coarse-grained enums:

- Maps verbose anchor statuses → 6 status categories
- Maps error messages → 5 reason codes (no PII leakage)
- Strips all other fields before persistence

### Access Control

Role-based field-level access (`KYCAccessLevel`):

| Access Level    | Can View                           |
| --------------- | ---------------------------------- |
| NONE (0)        | Nothing                            |
| STATUS_ONLY (1) | Pass/fail status only              |
| REASON_CODE (2) | Status + reason codes              |
| FULL (3)        | All minimized fields (ops/support) |

Enforcement via `filterKYCByAccess()` - queries redact fields based on caller role.

### Retention Policy

Auto-purge based on transaction status:

| Status       | Retention Horizon | Rationale                                   |
| ------------ | ----------------- | ------------------------------------------- |
| Completed    | 90 days           | Compliance minimum for dispute resolution   |
| Pending      | 30 days           | User has time to complete interactive KYC   |
| Failed/Error | 7 days            | User can retry; no long-term storage needed |

`shouldPurgeKYCState()` checks age vs. retention horizon.

**Implementation**: Background job should call purge logic daily (not yet implemented - acceptance criteria item).

## User Experience

### Boundary Honesty

Users see two distinct subsystems with clear boundaries:

1. **Anonymous voting**: "Your ballot is private. We use zero-knowledge proofs to verify eligibility without revealing your identity."
2. **Fiat ramp**: "Deposits/withdrawals require identity verification by our payment partner (Circle/Tempo) to comply with regulations. This verification is separate from your voting activity."

Frontend (`DepositWithdraw.tsx`) renders KYC iframe with security:

- Origin validation via `isTrustedAnchorMessage()`
- Sandbox attributes restrict iframe capabilities
- Clear labeling: "Circle USDC/EURC anchors via ANCHOR_USDC_URL"

### Privacy Red Lines

**Never joined**:

- Vote nullifiers ↔ ramp account addresses
- Ballot commitments ↔ KYC status
- DAO membership ↔ fiat transaction details

**Reconciliation state isolation**:

- Payment jobs table stores `tenant_id`, not voter identities
- Audit logs use coarse-grained KYC status, never full anchor payloads

## Anchor Data Processing Agreement Review

**Action Required**: Legal review of data processing terms with anchors:

- [ ] Circle USDC anchor DPA
- [ ] Circle EURC anchor DPA
- [ ] Tempo (if integrated)

Questions for legal:

1. What KYC data does anchor store vs. what we store?
2. What are anchor's retention obligations vs. ours?
3. Can we enforce status-only ingestion in anchor contract?
4. What dispute resolution data must we retain (affects retention horizons)?

## Metrics

Prometheus metrics for monitoring (`metrics.ts`):

- `zkvote_kyc_data_minimization_total`: Anchor responses minimized
- `zkvote_kyc_access_denial_total`: Field access attempts denied
- `zkvote_kyc_retention_purge_total`: Records purged by retention policy

## Testing

### Minimization Tests

- [ ] Parser rejects responses with excess fields (strict mode)
- [ ] Status mapping covers all anchor status codes
- [ ] Reason code mapping strips PII from error messages

### Access Control Tests

- [ ] STATUS_ONLY role cannot see reason codes
- [ ] REASON_CODE role cannot see interactive URLs
- [ ] Cross-role queries correctly filter fields

### Retention Tests

- [ ] Completed transactions purged after 90 days
- [ ] Pending transactions purged after 30 days
- [ ] Failed transactions purged after 7 days

### Boundary Tests

- [ ] KYC status never joined with vote nullifiers in queries
- [ ] Support views show minimized KYC data only
- [ ] Audit logs contain no identity documents

## Limitations

1. **Anchor divergence**: Each anchor (Circle, Tempo) may return different fields. Current implementation handles Circle responses; Tempo may need adjustments.
2. **Dispute flows**: If anchor requires detailed data for dispute resolution, case-by-case exceptions may be needed (with explicit expiry).
3. **Comprehension testing**: User understanding of anonymity-vs-verification boundary should be validated via UX research.

## Compliance Notes

This policy enables compliance without over-collection:

- Regulatory obligations determined by legal counsel, not code
- Product provides minimization tools; legal decides thresholds
- Anchor-DPA review will clarify data-controller vs. data-processor responsibilities

## References

- `backend/src/services/kycBoundary.ts` - Core implementation
- `backend/src/services/anchor.ts` - Integration with SEP-6 flows
- `backend/src/routes/ramp.ts` - API endpoints with access control
- `frontend/src/components/DepositWithdraw.tsx` - User-facing KYC flow
- SPIKE-146 (Issue #797) - Original spike specification

## ZV-142 — Anchor boundary inventory and operator obligations

The parser is an allowlist boundary, not a best-effort sanitizer. Accepted
top-level fields are status, transaction_status, message, error, interactiveUrl,
interactiveOrigin, type, url, and interactive_url. URL variants are retained
only long enough to validate the configured HTTPS anchor origin; minimized
state contains only validated interactive URL/origin, status, coarse reason
code, and timestamp. Every other field is rejected in all environments.
New SEP response shapes must be reviewed and added as redacted golden fixtures
before any allowlist change.

Golden fixtures live in backend/tests/fixtures/anchor-responses.json. They
cover supported SEP status shapes and representative identity, document,
nested customer, provider-metadata, and tracking-identifier fields. Tests
assert that each unknown field is rejected. Never add real customer payloads
to fixtures.

### User disclosure

The deposit/withdraw ramp tells users that the anchor receives their wallet
address, asset, amount, and information submitted in its own verification
flow. It distinguishes the anchor's KYC view from voting: the anchor does not
receive a vote choice or ZK voting proof. Stellar wallet addresses and
transfers remain public ledger data; do not describe the payment rail as
anonymous.

### Operator obligations and retention

- Configure only approved anchor mirrors and keep the HTTPS interactive-origin
  allowlist current. Do not fail over a KYC session to a different operator.
- Do not enable raw request/response body logging, analytics capture, tracing
  attributes, error-reporting payload capture, or support exports for anchor
  responses or interactive URLs.
- Boundary logs may record counts and coarse minimized status only. Never log
  response field names, identity values, anchor transaction IDs, interactive
  URLs, or provider tracking identifiers.
- Persist only minimized status/reason state and apply ZV-063 retention:
  completed 90 days, pending 30 days, failed/incomplete 7 days. Purge expired
  records and backups under the same retention obligations.
- The anchor remains an independent KYC operator responsible for its own
  identity-document handling, notices, legal basis, security, and retention.
  ZK-VOTE operators remain responsible for minimizing ingested data and
  explaining public-ledger visibility of wallet transfers.
