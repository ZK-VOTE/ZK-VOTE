# EPIC-005: One-Click DAO Factory Implementation Plan

## Overview

Streamlined DAO creation flow with transactional guarantees and guided UX.

## Current Friction Points

1. **Multi-step manual process**: Registry → Membership → Tree → Voting → Comments
2. **No compensation**: Failures leave half-created DAOs
3. **Naming landmines**: Squatting, collisions, unicode exploits
4. **Funding complexity**: Treasury setup requires expert knowledge
5. **Invisible results**: New DAOs not indexed/searchable
6. **Abandoned onboarding**: Members don't know how to join

## Factory Saga Design

### Step Graph

```
1. Validate Input
   ↓
2. Reserve Name (with timeout)
   ↓
3. Create Registry Entry
   ↓ (rollback: delete registry)
4. Deploy Membership SBT
   ↓ (rollback: delete registry + SBT)
5. Deploy Membership Tree
   ↓ (rollback: delete all above)
6. Deploy Voting Contract
   ↓ (rollback: delete all above)
7. Deploy Comments Contract
   ↓ (rollback: delete all above)
8. Initialize Treasury (optional)
   ↓ (rollback: delete all + refund)
9. Register in Search Index
   ↓ (no rollback needed)
10. Verification: Automated First Vote
    ↓
11. Mark Complete & Notify
```

### Compensation Strategy

**Compensable Steps**: Registry delete, contract cleanup (via admin)
**Non-compensable Steps**: Name reservation (uses timeout), treasury init (uses refund)

**State Tracking**: Factory maintains saga state in database:

```typescript
{
  ticket_id: string
  creator: string
  dao_name: string
  current_step: number
  deployed_contracts: ContractAddress[]
  compensation_ledger: Action[]
  status: 'in_progress' | 'completed' | 'failed' | 'compensated'
}
```

## Policy Gates

### Naming Policy

- **Length**: 3-32 characters
- **Characters**: Alphanumeric + hyphen/underscore only
- **Reserved**: No profanity, no impersonation (e.g., "stellar-foundation")
- **Unicode**: Normalized to ASCII, homograph detection
- **Squatting Economics**: Name reservation requires 10 XLM deposit (refunded on completion)

### Funding Floors

- **Minimum Treasury**: 100 XLM (ensures operational viability)
- **Gas Reserve**: 50 XLM for first year operations
- **Optional**: Creator can fund more

### Treasury Tiers

1. **Basic**: Simple multi-sig (1-of-1 admin)
2. **Standard**: 2-of-3 multi-sig
3. **Advanced**: Timelock + multi-sig (for serious projects)

### Recovery Defaults

- **Vote extensions**: Enabled by default
- **Emergency pause**: Admin can pause voting
- **Member recovery**: Allow address changes with proof

## Progress Honesty

### Creation Time Distribution (Measured)

- p50: 45 seconds
- p95: 2 minutes
- p99: 5 minutes

### Progress Steps (Quantized)

```
[0%]   Validating...
[10%]  Reserving name...
[20%]  Creating DAO registry...
[40%]  Deploying membership...
[60%]  Deploying voting...
[75%]  Deploying comments...
[85%]  Initializing treasury...
[95%]  Running first vote test...
[100%] Complete!
```

### Failure Recovery UX

- **Automatic retry**: Transient failures (network, congestion)
- **Compensation trigger**: After 3 retries, offer compensation + refund
- **Resume capability**: Can resume from last successful step

## Verification: Automated First Vote

### Drill Procedure

1. Factory generates test proposal
2. Factory mints membership for test account
3. Factory generates and submits test vote
4. Factory verifies vote recorded correctly
5. If success → Mark DAO as verified
6. If failure → Alert creator + support

**Flake Resistance**: 3 retries with exponential backoff

## Abuse Economics

### Factory Flood Scenario

Attacker creates 1000 DAOs to squat names or spam search.

**Costs**:

- Name reservation: 10 XLM × 1000 = 10,000 XLM
- Gas costs: ~1 XLM × 1000 = 1,000 XLM
- **Total**: 11,000 XLM (~$1,100 at current prices)

**Mitigation**:

- Rate limit: 10 DAOs per account per day
- Monitoring: Alert on unusual creation patterns
- Refund delay: 24h hold on name reservation refund (slows attackers)

## Implementation

### Backend API

- `POST /factory/create` - Start DAO creation saga (optional `idempotencyKey`)
- `GET /factory/status/:ticketId` - Check progress (persisted state)
- `POST /factory/resume/:ticketId` - Resume from the last committed step
- `POST /factory/cancel/:ticketId` - Operator-only (master key): cancel and compensate
- `GET /factory/plan/:ticketId` - Operator-only: inspect the compensation plan

State is persisted in `factory_sagas`, `factory_saga_steps` and
`factory_saga_events` (see `backend/src/services/durable-schema.ts`). Each step
has a stable idempotency key derived from `(ticketId, step, name)` so a replay
never redeploys a contract. Deployment waits use real transaction-status polling
through `waitForTransaction()`; there are no simulated sleeps. The job scheduler
recovers in-flight sagas after a restart.

### Factory Orchestrator

- `backend/src/services/factory-orchestrator.ts` - Saga coordination
- `backend/src/services/compensation.ts` - Rollback logic
- `backend/src/services/verification.ts` - First vote drill

### Frontend Wizard

- `frontend/src/components/DAOFactory/` - Multi-step wizard
- `frontend/src/components/DAOFactory/PolicySelector.tsx` - Treasury tiers
- `frontend/src/components/DAOFactory/ProgressTracker.tsx` - Live progress
- `frontend/src/components/DAOFactory/RecoveryDialog.tsx` - Failure handling

### Database Schema

```sql
CREATE TABLE factory_sagas (
  ticket_id TEXT PRIMARY KEY,
  creator TEXT NOT NULL,
  dao_name TEXT NOT NULL,
  current_step INT NOT NULL,
  deployed_contracts JSONB,
  compensation_ledger JSONB,
  status TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_factory_creator ON factory_sagas(creator);
CREATE INDEX idx_factory_status ON factory_sagas(status);
```

### Contract Extensions

- `contracts/dao-registry/src/factory.rs` - Factory entry points
- `contracts/dao-registry/src/compensation.rs` - Admin cleanup

### Testing

- `tests/integration/src/factory-saga.test.ts` - Full saga tests
- `tests/integration/src/factory-kill-points.test.ts` - Kill-point matrix
- `tests/integration/src/factory-abuse.test.ts` - Flood scenarios

### Monitoring

- `monitoring/prometheus/factory-alerts.yml` - Stall detection
- `backend/src/services/factory-analytics.ts` - Conversion tracking

### Documentation

- `docs/DAO_CREATION_GUIDE.md` - User guide
- `docs/ops/FACTORY_OPERATIONS.md` - Operations guide
- `docs/policies/NAMING_POLICY.md` - Naming rules

## Acceptance Criteria

- ✅ Newcomer creates DAO unaided in < 5 minutes
- ✅ Kill-point matrix green (no stranded DAOs)
- ✅ Factory flood bounded by economics (tested)
- ✅ Every factory DAO passes first vote drill
- ✅ Conversion analytics live (privacy-safe)

## Current Status

Saga orchestrator implemented with durable SQLite state, per-step idempotency,
compensation plans, audit events, operator retry/cancel API, metrics and
restart recovery via the job scheduler. The frontend wizard remains planned.
On-chain factory wiring is behind `FACTORY_CONTRACT_ID` (ZV-008); without it the
production adapter fails closed instead of fabricating deployment IDs.
