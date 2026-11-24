# Relayer Key Rotation Runbook

This document describes the operational procedures for rotating relayer signing keys and co-signer approval secrets.

## Overview

The ZK-VOTE relayer uses a tiered signing policy with co-signer approvals:

- **Hot tier**: Low-value transactions, hot key alone
- **Warm tier**: Medium value, requires 1 co-signer approval
- **Cold tier**: High value or privileged operations, requires 2 co-signer approvals

Co-signer approvals are HMACs bound to transaction hash and tier, signed with secrets that must be rotated periodically and can be revoked in case of compromise.

## Approval Secret Rotation

### Regular Rotation (Every 90 Days)

1. **Pre-rotation Check**

   ```bash
   # Verify current secret status
   curl -X GET http://localhost:3000/admin/approval-secrets \
     -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

2. **Initiate Rotation**

   ```bash
   # Rotate with 5-minute overlap window
   curl -X POST http://localhost:3000/admin/approval-secrets/rotate \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "cosignerId": "cosigner-1",
       "overlapWindowMs": 300000,
       "reason": "scheduled_rotation"
     }'
   ```

3. **Monitor Overlap Period**
   - Old secret remains valid for 5 minutes
   - In-flight transactions can complete with old approvals
   - New approvals use new secret immediately

4. **Verify Rotation**

   ```bash
   # Check that new version is active
   curl -X GET http://localhost:3000/admin/approval-secrets/status \
     -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

5. **Update Co-signer Systems**
   - Distribute new secret to co-signer services
   - Test approval generation with new secret
   - Confirm approvals verify correctly

### Emergency Rotation (Compromise Response)

If a co-signer approval secret is compromised:

1. **Immediate Revocation**

   ```bash
   # Revoke compromised secret
   curl -X POST http://localhost:3000/admin/approval-secrets/revoke \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "cosignerId": "cosigner-1",
       "version": 5,
       "reason": "suspected_compromise",
       "actor": "security-team"
     }'
   ```

   This will:
   - Immediately invalidate the compromised secret
   - Revoke all pending approvals signed with it
   - Log audit event for investigation

2. **Issue New Secret**

   ```bash
   # Generate new secret immediately
   curl -X POST http://localhost:3000/admin/approval-secrets/rotate \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "cosignerId": "cosigner-1",
       "overlapWindowMs": 0,
       "reason": "compromise_recovery"
     }'
   ```

3. **Audit Trail Review**

   ```bash
   # Check recent approvals with compromised secret
   curl -X GET "http://localhost:3000/admin/audit-log?action=approval_issued" \
     -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

4. **Incident Response**
   - Review all transactions approved with compromised secret
   - Check for unauthorized transactions
   - Update incident response log
   - Notify stakeholders if necessary

## Relayer Hot Key Rotation

### Preparation

1. **Generate New Key**

   ```bash
   stellar keys generate --network testnet
   # Save: Public Key, Secret Key
   ```

2. **Fund New Key**

   ```bash
   # Transfer minimum operating reserve
   stellar payment --source $OLD_KEY --destination $NEW_KEY --amount 100
   ```

3. **Register New Key**
   ```bash
   curl -X POST http://localhost:3000/admin/relayer/register-key \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "id": "relayer-key-v2",
       "publicKey": "$NEW_PUBLIC_KEY",
       "secretKey": "$NEW_SECRET_KEY",
       "role": "primary",
       "makeActive": false
     }'
   ```

### Activation

1. **Gradual Rollout**

   ```bash
   # Set new key as active
   curl -X POST http://localhost:3000/admin/relayer/activate-key \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "keyId": "relayer-key-v2"
     }'
   ```

2. **Monitor Health**
   - Check transaction success rate
   - Monitor error logs
   - Verify account balances

3. **Sweep Old Key** (after 24 hours)

   ```bash
   # Move remaining funds from old key
   curl -X POST http://localhost:3000/admin/relayer/sweep \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "fromKeyId": "relayer-key-v1",
       "sweepSafeAccount": "$SAFE_ACCOUNT_ADDRESS"
     }'
   ```

4. **Retire Old Key**
   ```bash
   # Mark old key as retired
   curl -X POST http://localhost:3000/admin/relayer/retire-key \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "keyId": "relayer-key-v1"
     }'
   ```

## Approval Record Persistence

### Querying Approval History

```bash
# Get approvals for a specific transaction
curl -X GET "http://localhost:3000/admin/approvals?txHash=$TX_HASH" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Get all approvals by cosigner
curl -X GET "http://localhost:3000/admin/approvals?cosignerId=cosigner-1" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Get expired approvals
curl -X GET "http://localhost:3000/admin/approvals?status=expired" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Audit Trail

All approval lifecycle events are logged:

- `approval_issued` - When co-signer creates approval
- `approval_used` - When approval is consumed by transaction
- `approval_revoked` - When approval is manually revoked
- `secret_rotated` - When approval secret is rotated
- `secret_compromised` - When secret is revoked due to compromise

```bash
# Review audit trail
curl -X GET "http://localhost:3000/admin/audit-log?action=approval_*" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Automated Rotation Drill

For automated testing of rotation procedures:

```bash
# Run rotation drill (no actual rotation)
curl -X POST http://localhost:3000/admin/approval-secrets/drill \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "cosignerId": "cosigner-1",
    "dryRun": true
  }'
```

This will:

- Validate current secret configuration
- Simulate rotation process
- Check overlap window handling
- Verify new secret generation
- Test approval verification with both secrets
- Report any issues

## Monitoring & Alerts

### Key Metrics

1. **Approval Age**
   - Alert if any approval > 24 hours old and unused
   - Check for stale approvals blocking transactions

2. **Secret Rotation Status**
   - Alert if secret > 90 days old
   - Warn if rotation overdue

3. **Approval Verification Failures**
   - Alert on repeated verification failures
   - May indicate secret mismatch or compromise

4. **Overlap Window Usage**
   - Monitor approvals using deprecated secrets
   - Should drop to zero after overlap window

### Dashboard Queries

```sql
-- Approvals awaiting use
SELECT COUNT(*) FROM relayer_approval_records
WHERE used_at IS NULL
  AND revoked_at IS NULL
  AND datetime(expires_at) > datetime('now');

-- Secret rotation status
SELECT
  cosigner_id,
  version,
  activated_at,
  deprecated_at,
  julianday('now') - julianday(activated_at) as age_days
FROM relayer_approval_secrets
WHERE revoked_at IS NULL
ORDER BY activated_at DESC;

-- Recent audit events
SELECT * FROM relayer_approval_audit
WHERE timestamp > datetime('now', '-24 hours')
ORDER BY timestamp DESC;
```

## Troubleshooting

### Approval Verification Fails

1. Check secret version mismatch

   ```bash
   # Verify active secret version
   SELECT * FROM relayer_approval_secrets
   WHERE cosigner_id = 'cosigner-1'
     AND revoked_at IS NULL
   ORDER BY version DESC LIMIT 1;
   ```

2. Verify overlap window hasn't expired
   - Check `deprecated_at + overlap_window_ms`
   - Extend if needed for emergency

3. Check audit log for revocations
   ```bash
   # Look for recent revocations
   SELECT * FROM relayer_approval_audit
   WHERE event_type = 'secret_compromised'
     AND cosigner_id = 'cosigner-1'
   ORDER BY timestamp DESC LIMIT 5;
   ```

### High Approval Rejection Rate

- Review signing policy tier limits
- Check co-signer secret synchronization
- Verify network time synchronization (for expiry)
- Check for pending secret rotation

## Security Considerations

1. **Secret Storage**
   - Approval secrets stored in managed secret backend (Vault)
   - Encrypted at rest
   - Access logged and audited

2. **Separation of Duties**
   - Co-signers should be operated by different entities
   - No single operator should have all co-signer secrets

3. **Compromise Detection**
   - Monitor for unusual approval patterns
   - Alert on approval reuse attempts
   - Track failed verification attempts

4. **Rotation Frequency**
   - Regular: Every 90 days
   - Emergency: Immediately upon suspected compromise
   - After personnel changes

## References

- Issue #962: Relayer co-signer approval secret lifecycle
- Issue ZV-123: Approval persistence and rotation
- Issue ZV-075: Secret management integration
- Issue ZV-144: Automated rotation drills
