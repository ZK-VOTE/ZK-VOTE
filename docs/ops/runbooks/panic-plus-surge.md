# Runbook: Panic Mode + Fee Surge

## Scenario

Panic mode activated during network fee surge (typically election final hour).

## Detection

- Alert: `CombinedFaultFeeSurgePanic`
- Symptoms: Vote submissions failing, fees 5x+ normal, panic mode active

## Impact

- Users cannot submit votes during panic
- High fees make rotation expensive
- Support ticket surge expected

## Response Priority

**PANIC-FIRST**: Integrity over availability

## Procedure

### 1. Assess Situation (2 minutes)

**Authority**: Senior on-call engineer

```bash
# Check halt status (ZV-114 / #954 - see "Tiered Emergency Halt" below)
curl https://api.zkvote.io/voting/halt/status

# Check fee levels
curl https://api.zkvote.io/stellar/fees

# Check vote success rate
curl https://api.zkvote.io/metrics | grep vote_success_rate
```

**Decision Point**: Is panic justified?

- YES: Continue to step 2
- NO: Consider panic deactivation (requires security lead approval)

### 2. Communicate Status (5 minutes)

**Authority**: On-call engineer

- [ ] Post degraded status banner
- [ ] Update status page
- [ ] Alert support team (expect 3x normal ticket volume)
- [ ] Internal Slack: #incident-response

**Template**:

```
Status: DEGRADED
Voting temporarily paused for security review.
Fee surge: Network congestion may delay operations.
ETA: Under investigation
```

### 3. Monitor Fee Trends (Ongoing)

**Baseline**: Track fee median every 60 seconds

```bash
# Watch fees
watch -n 60 'curl -s https://horizon.stellar.org/ledgers?order=desc&limit=1 | jq .base_fee'
```

**Thresholds**:

- < 5x baseline: Improving
- 5-10x: Holding
- > 10x: Worsening

### 4. Plan Recovery (15 minutes)

**If fees stabilizing (< 5x)**:

- Prepare to deactivate panic
- Schedule verification window
- Brief support on recovery

**If fees high (> 10x)**:

- Extend panic duration
- Consider election extension
- Coordinate with Stellar Foundation if network-wide

### 5. Execute Recovery (Variable)

**Requirements**:

- [ ] Fees below 3x baseline for 10 minutes
- [ ] No active compromise indicators
- [ ] Security lead approval

```bash
# Deactivate panic (contract call, made directly against the voting
# contract by a guardian/quorum signer - there is no backend endpoint
# for this; see "Tiered Emergency Halt" below for what actually exists).

# Verify halt status (read-only, public, unauthenticated):
curl https://api.zkvote.io/voting/halt/status
```

### 6. Post-Incident (Within 24h)

- [ ] Blameless retrospective
- [ ] Update fee surge thresholds if needed
- [ ] Document lessons learned
- [ ] Review panic justification

## Escalation

- **If panic > 2 hours**: Notify CEO
- **If compromise confirmed**: Follow security incident playbook
- **If fees remain high**: Contact Stellar Foundation

## SLO During Event

- Vote success rate: > 0% (panic halts all votes)
- Recovery time: < 2 hours from fee stabilization
- Support response: < 15 minutes

## Tiered Emergency Halt (ZV-114 / Issue #954)

The legacy `pause`/`unpause` on the voting contract is a single
contract-wide guardian kill switch (blocks everything, 72h auto-expiry,
no quorum) - that is what "panic mode" above has always meant, and it is
unchanged. `contracts/voting/src/lib.rs` additionally now supports a
**tiered** halt, scoped to one of three named tiers rather than
everything at once:

| Tier                  | Bit    | What it blocks                                                                                 |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| Vote submission       | `0x1`  | `vote`, `vote_encrypted`, `vote_with_circuit`, `cast_votes`                                       |
| Tally finalization    | `0x2`  | `submit_recursive_tally`, `submit_universal_tally`                                                |
| Treasury execution    | `0x4`  | No entrypoint exists in this contract yet - exposed for a future treasury contract to cross-call `is_tier_halted` before paying out |

**Activation** has two paths:

- **Fast (single guardian)**: `activate_halt(tiers, reason, guardian)`.
  Expires automatically after `FAST_HALT_MAX_DURATION` (24h) if never
  ratified - "temporary halts expire automatically if not ratified".
- **Ratified (quorum)**: configured signers call `ratify_halt(signer)`;
  once the configured threshold approves, the halt becomes durable (no
  expiry) until a quorum resumes it.

**Resume**: the activating guardian alone may stand down their own
*unratified* fast halt (`resume_halt`). A *ratified* halt can only be
resumed by a quorum of configured signers - a single compromised guardian
can activate a halt alone, but can never undo one a quorum deliberately
ratified.

**Status**: `GET /voting/halt/status` (public, unauthenticated - whether
voting is halted is not privileged information) returns each tier's
current boolean status, backed by `backend/src/services/haltStatus.ts`
calling the contract's `is_tier_halted` live. Also surfaced read-only in
the frontend's DAO Settings page.

**Still needed** (not done here): a parsed `get_halt_status()` exposing
`reason`/`activatedBy`/`ratified`/`expiresAt` through the backend/UI (the
contract-level getter exists; only the boolean gate is wired through the
backend so far, see haltStatus.ts's module doc for why); gating a real
treasury-execution entrypoint once one exists; an actual drill exercising
this runbook end to end with the new tiers (this document describes the
mechanism, it has not been drilled).

## Related Runbooks

- Key Rotation Under Load
- Three-Way Fault Response
- Election Extension Procedure
