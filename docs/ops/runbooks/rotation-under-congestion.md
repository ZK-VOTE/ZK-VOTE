# Runbook: Key Rotation Under Network Congestion

## Scenario

Relayer key rotation required during high network load.

## Detection

- Alert: `CombinedFaultRotationCongestion`
- Symptoms: Rotation in progress, tx latency > 10s, potential timeout

## Impact

- Rotation transactions may fail or timeout
- Vote submissions delayed during rotation
- Increased operational costs

## Response Priority

**ROTATE-FIRST** if:

- Security incident (key compromise suspected/confirmed)
- Scheduled rotation during unexpected congestion

**DELAY ROTATION** if:

- Routine prophylactic rotation
- Election in final hour (< 60 min to close)

## Procedure

### 1. Assess Severity (2 minutes)

**Authority**: On-call engineer

```bash
# Check rotation status
curl https://api.zkvote.io/relayer/rotation/status

# Check network congestion
curl https://api.zkvote.io/stellar/network/stats

# Is this security-critical?
# YES: Continue immediately
# NO: Consider delay
```

### 2. Pre-Flight Checks (5 minutes)

**Before proceeding**:

```bash
# Reserve sufficient XLM for fees
./scripts/ops/check-relayer-balance.sh

# Estimate rotation cost at current fees
./scripts/ops/estimate-rotation-cost.sh

# Check if fee surge pricing available
./scripts/ops/check-fee-tiers.sh
```

**Go/No-Go Decision**:

- [ ] Balance sufficient (2x estimated cost)
- [ ] Network latency < 30s p99
- [ ] Rotation authority approved

### 3. Configure Rotation Parameters (5 minutes)

**Adjust for high-load conditions**:

```bash
# Increase timeouts
export ROTATION_TIMEOUT_MS=60000  # 60s vs normal 30s

# Enable fee surge pricing
export ROTATION_FEE_MULTIPLIER=3  # Pay 3x median fee

# Increase retry attempts
export ROTATION_MAX_RETRIES=10  # vs normal 3

# Configure sequence locking
export ROTATION_SEQUENCE_LOCK=true
```

### 4. Execute Rotation (15-30 minutes)

**Monitor continuously**:

```bash
# Start rotation with monitoring
./scripts/ops/rotation-under-load.sh --monitor

# Watch progress in separate terminal
watch -n 5 'curl -s https://api.zkvote.io/relayer/rotation/status'
```

**Steps the script performs**:

1. Generate new keypair
2. Fund new account (high-priority tx)
3. Update relayer configuration
4. Submit change to registry (with retries)
5. Verify new key active
6. Deactivate old key (after grace period)

**Expected duration**:

- Normal: 5-10 minutes
- Under load: 15-30 minutes
- Worst case: 45 minutes (with retries)

### 5. Verify Rotation Success (5 minutes)

**Checkpoints**:

```bash
# New key active?
curl https://api.zkvote.io/relayer/keys/current

# Votes processing with new key?
./scripts/test/submit-test-vote.sh

# Old key deactivated?
curl https://api.zkvote.io/relayer/keys/deprecated
```

**Success criteria**:

- [ ] New key verified on-chain
- [ ] Test vote submitted and verified
- [ ] Old key no longer accepting signatures
- [ ] No votes dropped during rotation

### 6. Post-Rotation Monitoring (1 hour)

**Enhanced monitoring window**:

```bash
# Monitor vote success rate
watch -n 60 './scripts/ops/check-vote-success-rate.sh'

# Watch for signature failures
tail -f /var/log/relayer/signatures.log | grep -i error

# Monitor fee costs
./scripts/ops/monitor-rotation-costs.sh
```

**Alert thresholds**:

- Vote success rate < 95%: Investigate
- Signature errors > 0: Rollback consideration
- Cost > 5x estimate: Document for review

## Rollback Procedure

**If rotation fails or causes issues**:

```bash
# Emergency rollback to old key
./scripts/ops/rotation-rollback.sh

# Verify old key reactivated
./scripts/test/submit-test-vote.sh

# File incident report
./scripts/ops/incident-report.sh rotation-rollback
```

**Rollback time**: < 5 minutes

## Escalation

- **If rotation stalls > 30 min**: Escalate to senior engineer
- **If vote success < 90%**: Consider rollback
- **If compromise confirmed**: Do not rollback, complete rotation

## Cost Management

**During high fees**:

- Budget: 50-200 XLM vs normal 10-20 XLM
- Approval: Required if > 100 XLM
- Recovery: Operational reserve covers; reconcile after

## SLO During Event

- Vote success rate: > 95% (slightly degraded)
- Rotation completion: < 45 minutes
- No vote data loss

## Related Runbooks

- Panic + Fee Surge
- Emergency Security Rotation
- Network Congestion Response
