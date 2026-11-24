# EPIC-003: Election-Day Combined-Fault Drill Implementation Plan

## Overview

Test and prepare for simultaneous failures during high-load election scenarios.

## Fault Combination Matrix

### Priority 1 Combinations (Highest Risk)

1. **Fee Surge + Panic Mode** - Most likely during election final hour
2. **Key Compromise + Rotation Under Load** - Security incident during peak traffic
3. **Network Congestion + Vote Submission Spike** - Organic load scenario

### Priority 2 Combinations

4. **Panic Mode + Dispute Surge** - User confusion amplification
5. **Backend Degradation + Push Notification Failure** - Silent failure cascade
6. **Rotation + Fee Escalation** - Operational costs spike

### Priority 3 Combinations

7. **Three-way: Surge + Panic + Rotation** - Worst-case scenario

## Response Order Doctrine

### Panic-First Situations

When to trigger panic before other actions:

- Evidence of active vote manipulation
- Compromised nullifier detection
- Smart contract vulnerability discovered

**Authority**: Senior on-call engineer + 1 peer approval

### Rotate-First Situations

When to rotate keys before panic:

- Suspected key compromise without active attack
- Planned security upgrade under load
- Prophylactic rotation before peak traffic

**Authority**: Security lead approval required

### Sequence for Combined Events

1. **Assess severity**: Which fault poses immediate integrity risk?
2. **Communicate**: Alert team + prepare user notification
3. **Execute primary response**: Panic or rotate based on doctrine
4. **Monitor impact**: Track voter success rate
5. **Secondary response**: Address remaining faults
6. **Post-incident review**: Blameless retrospective

## Degraded-Election SLOs

### Normal Operation

- Vote success rate: > 99%
- Vote latency p99: < 5s
- Relayer availability: > 99.9%

### Degraded Operation (Combined Faults)

- Vote success rate: > 90% (acceptable floor)
- Vote latency p99: < 30s (acceptable degradation)
- Relayer availability: > 95% (minimum threshold)

**Alert Threshold**: Any SLO breach triggers escalation

## Implementation

### Chaos Harness

- `tests/chaos/combined-faults.ts` - Fault injection framework
- `tests/chaos/scenarios/` - Pre-defined combination scenarios
- `scripts/test/game-day.sh` - Game day orchestration script

### Response Tooling

- `scripts/ops/panic-trigger.sh` - Controlled panic activation
- `scripts/ops/rotation-under-load.sh` - Hot rotation procedure
- `backend/src/services/degraded-mode.ts` - Graceful degradation logic

### Monitoring Extensions

- `monitoring/prometheus/combined-fault-detection.yml` - Multi-fault alerts
- `monitoring/grafana/election-day-dashboard.json` - Real-time status

### Runbooks

- `docs/ops/runbooks/panic-plus-surge.md` - Response guide
- `docs/ops/runbooks/rotation-under-congestion.md` - Procedure
- `docs/ops/runbooks/three-way-fault.md` - Worst-case handling

### Frontend Degraded UX

- `frontend/src/components/DegradedElectionBanner.tsx` - User notification
- `frontend/src/components/VoteRetry.tsx` - Enhanced retry logic

### Game Day Program

- `docs/ops/GAME_DAY_CHARTER.md` - Program definition
- Cadence: Quarterly mandatory drills
- Participants: All on-call engineers + observers
- Freeze criteria: Defined escape hatch conditions
- Review: Within 48h post-drill

## Drill Scenarios

### Scenario 1: Fee Surge + Panic

1. Inject 10x normal vote traffic
2. Trigger fee surge on Stellar
3. Activate panic mode at 15min mark
4. Measure: voter success rate, support tickets, recovery time

### Scenario 2: Compromise + Rotation Under Congestion

1. Simulate key compromise signal
2. Start rotation procedure
3. Inject network congestion
4. Measure: rotation completion time, votes during rotation

### Scenario 3: Full Game Day

1. Announce drill 24h prior
2. Full team participation
3. Three-way fault injection
4. Measure all SLOs
5. Post-drill retrospective

## Acceptance Criteria

- ✅ Matrix published with 7 ranked combinations
- ✅ Top 3 combinations drilled with measured impact
- ✅ Response doctrine documented and followed
- ✅ Game day program running quarterly
- ✅ Degraded SLOs monitored with active alerts

## Current Status

Planning complete. Chaos harness and first drills pending implementation.
