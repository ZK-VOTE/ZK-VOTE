# Token Governance Controls Design (ZV-116)

**Issue**: #955  
**Class**: Feature  
**Size**: L  
**Status**: Implementation Roadmap

## Overview

This document outlines the design for proposal-driven token governance entry points with approval thresholds, clawback window enforcement, allowance limit changes with timelocks, and admin UI integration.

## Current State Gap

The token contract (`contracts/token/src/lib.rs`) stores:
- Governor sets (`DataKey::Governors`)
- Required approvals (`DataKey::RequiredApprovals`)
- Clawback period limit (`DataKey::ClawbackPeriodLimit`)
- Clawback proposals and history (`ClawbackProposal`, `ClawbackRecord`)

**Missing**:
1. End-to-end governance workflow for proposing/approving clawbacks
2. Enforcement of clawback window bounds
3. Allowance limit governance with timelocks
4. Event projections for governance actions
5. Admin UI for governance operations

## Architecture

### 1. Governance Entry Points

```rust
// contracts/token/src/lib.rs

/// Initialize governance (admin-only, one-time)
pub fn init_governance(
    env: Env,
    governors: Vec<Address>,
    required_approvals: u32,
    clawback_period_limit: i128,
) {
    let admin: Address = Self::admin(env.clone());
    admin.require_auth();
    Self::bump_instance(&env);

    // Validate parameters
    if governors.is_empty() {
        panic_with_error!(&env, TokenError::InvalidAmount);
    }
    if required_approvals == 0 || required_approvals > governors.len() {
        panic_with_error!(&env, TokenError::ClawbackInsufficientApprovals);
    }

    let gov_key = DataKey::Governors;
    let approval_key = DataKey::RequiredApprovals;
    let period_key = DataKey::ClawbackPeriodLimit;

    env.storage().persistent().set(&gov_key, &governors);
    env.storage().persistent().set(&approval_key, &required_approvals);
    env.storage().persistent().set(&period_key, &clawback_period_limit);

    Self::bump_persistent(&env, &gov_key);
    Self::bump_persistent(&env, &approval_key);
    Self::bump_persistent(&env, &period_key);

    GovernanceInitialized {
        governors: governors.clone(),
        required_approvals,
        clawback_period_limit,
    }
    .publish(&env);
}

/// Propose a clawback (governor-only)
pub fn propose_clawback(
    env: Env,
    proposer: Address,
    target: Address,
    amount: i128,
    reason: String,
) -> u32 {
    proposer.require_auth();
    Self::bump_instance(&env);

    // Verify proposer is a governor
    let governors: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::Governors)
        .unwrap_or_else(|| panic_with_error!(&env, TokenError::ClawbackNotGovernor));

    if !governors.contains(&proposer) {
        panic_with_error!(&env, TokenError::ClawbackNotGovernor);
    }

    // Verify amount is within clawback period limit
    let period_limit: i128 = env
        .storage()
        .persistent()
        .get(&DataKey::ClawbackPeriodLimit)
        .unwrap_or(0);

    if amount > period_limit {
        panic_with_error!(&env, TokenError::ClawbackPeriodLimitExceeded);
    }

    // Create proposal
    let count_key = DataKey::ClawbackProposalCount;
    let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
    let new_count = count.checked_add(1).unwrap_or_else(|| {
        panic_with_error!(&env, TokenError::Overflow);
    });

    let mut approvals = Vec::new(&env);
    approvals.push_back(proposer.clone());

    let proposal = ClawbackProposal {
        id: new_count,
        target: target.clone(),
        amount,
        reason: reason.clone(),
        proposer: proposer.clone(),
        approvals,
        created_ledger: env.ledger().sequence(),
        executed: false,
    };

    let proposal_key = DataKey::ClawbackProposal(new_count);
    env.storage().persistent().set(&proposal_key, &proposal);
    Self::bump_persistent(&env, &proposal_key);

    env.storage().persistent().set(&count_key, &new_count);
    Self::bump_persistent(&env, &count_key);

    ClawbackProposed {
        proposal_id: new_count,
        target,
        amount,
        reason,
        proposer,
    }
    .publish(&env);

    new_count
}

/// Approve a clawback proposal (governor-only, each governor once)
pub fn approve_clawback(env: Env, approver: Address, proposal_id: u32) {
    approver.require_auth();
    Self::bump_instance(&env);

    // Verify approver is a governor
    let governors: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::Governors)
        .unwrap_or_else(|| panic_with_error!(&env, TokenError::ClawbackNotGovernor));

    if !governors.contains(&approver) {
        panic_with_error!(&env, TokenError::ClawbackNotGovernor);
    }

    // Get proposal
    let proposal_key = DataKey::ClawbackProposal(proposal_id);
    let mut proposal: ClawbackProposal = env
        .storage()
        .persistent()
        .get(&proposal_key)
        .unwrap_or_else(|| panic_with_error!(&env, TokenError::ClawbackNotFound));

    if proposal.executed {
        panic_with_error!(&env, TokenError::ClawbackAlreadyExecuted);
    }

    if proposal.approvals.contains(&approver) {
        panic_with_error!(&env, TokenError::ClawbackAlreadyApproved);
    }

    // Add approval
    proposal.approvals.push_back(approver.clone());

    env.storage().persistent().set(&proposal_key, &proposal);
    Self::bump_persistent(&env, &proposal_key);

    ClawbackApprovalAdded {
        proposal_id,
        approver,
        approvals: proposal.approvals.len(),
    }
    .publish(&env);
}

/// Execute a clawback (any governor, after required approvals)
pub fn execute_clawback(env: Env, executor: Address, proposal_id: u32) {
    executor.require_auth();
    Self::bump_instance(&env);

    // Verify executor is a governor
    let governors: Vec<Address> = env
        .storage()
        .persistent()
        .get(&DataKey::Governors)
        .unwrap_or_else(|| panic_with_error!(&env, TokenError::ClawbackNotGovernor));

    if !governors.contains(&executor) {
        panic_with_error!(&env, TokenError::ClawbackNotGovernor);
    }

    // Get proposal
    let proposal_key = DataKey::ClawbackProposal(proposal_id);
    let mut proposal: ClawbackProposal = env
        .storage()
        .persistent()
        .get(&proposal_key)
        .unwrap_or_else(|| panic_with_error!(&env, TokenError::ClawbackNotFound));

    if proposal.executed {
        panic_with_error!(&env, TokenError::ClawbackAlreadyExecuted);
    }

    // Check approvals threshold
    let required_approvals: u32 = env
        .storage()
        .persistent()
        .get(&DataKey::RequiredApprovals)
        .unwrap_or(0);

    if proposal.approvals.len() < required_approvals {
        panic_with_error!(&env, TokenError::ClawbackInsufficientApprovals);
    }

    // Verify clawback window (delay after proposal creation)
    let current_ledger = env.ledger().sequence();
    let elapsed = current_ledger.saturating_sub(proposal.created_ledger);
    
    if elapsed < CLAWBACK_DELAY_LEDGERS {
        panic_with_error!(&env, TokenError::ClawbackNotReady);
    }
    
    if elapsed > CLAWBACK_PERIOD_LEDGERS {
        panic_with_error!(&env, TokenError::ClawbackPeriodLimitExceeded);
    }

    // Execute clawback
    Self::spend_balance(&env, &proposal.target, proposal.amount);
    let new_supply = Self::decrement_supply(&env, proposal.amount);

    // Record in clawback history
    Self::store_clawback_record(&env, &proposal, &executor, new_supply);

    // Mark proposal as executed
    proposal.executed = true;
    env.storage().persistent().set(&proposal_key, &proposal);
    Self::bump_persistent(&env, &proposal_key);

    ClawbackExecuted {
        target: proposal.target,
        amount: proposal.amount,
        reason: proposal.reason,
        executor,
        new_supply,
    }
    .publish(&env);
}
```

### 2. Allowance Governance with Timelocks

```rust
// New data structures
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AllowanceLimitProposal {
    pub id: u32,
    pub spender: Address,
    pub new_limit: i128,
    pub proposer: Address,
    pub approvals: Vec<Address>,
    pub created_ledger: u32,
    pub timelock_expires: u32,
    pub executed: bool,
}

const ALLOWANCE_LIMIT_TIMELOCK: u32 = 17_280; // ~24 hours (5s ledger time)

/// Propose allowance limit change
pub fn propose_allowance_limit(
    env: Env,
    proposer: Address,
    spender: Address,
    new_limit: i128,
) -> u32 {
    proposer.require_auth();
    Self::bump_instance(&env);

    // Similar governance flow to clawback
    // ... (omitted for brevity)
}

/// Execute allowance limit change (after timelock)
pub fn execute_allowance_limit(env: Env, executor: Address, proposal_id: u32) {
    executor.require_auth();
    Self::bump_instance(&env);

    // Verify timelock has expired
    // Apply new limit
    // Emit audit event
    // ... (omitted for brevity)
}
```

### 3. Event Projections

```rust
// Add new events for governance
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct GovernanceInitialized {
    pub governors: Vec<Address>,
    pub required_approvals: u32,
    pub clawback_period_limit: i128,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ClawbackProposed {
    pub proposal_id: u32,
    #[topic]
    pub target: Address,
    pub amount: i128,
    pub reason: String,
    #[topic]
    pub proposer: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ClawbackApprovalAdded {
    pub proposal_id: u32,
    #[topic]
    pub approver: Address,
    pub approvals: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct AllowanceLimitChanged {
    #[topic]
    pub spender: Address,
    pub old_limit: i128,
    pub new_limit: i128,
    #[topic]
    pub executor: Address,
}
```

### 4. Frontend Integration

```typescript
// frontend/src/components/DAOSettings.tsx

export function GovernancePanel({ daoId }: { daoId: number }) {
  const [proposals, setProposals] = useState<ClawbackProposal[]>([]);
  const [governors, setGovernors] = useState<string[]>([]);

  async function proposeClawback(target: string, amount: string, reason: string) {
    const tx = await tokenContract.propose_clawback({
      proposer: currentUser,
      target,
      amount: BigInt(amount),
      reason,
    });
    
    await tx.signAndSend();
    loadProposals();
  }

  async function approveProposal(proposalId: number) {
    const tx = await tokenContract.approve_clawback({
      approver: currentUser,
      proposal_id: proposalId,
    });
    
    await tx.signAndSend();
    loadProposals();
  }

  async function executeProposal(proposalId: number) {
    const proposal = proposals.find(p => p.id === proposalId);
    if (!proposal) return;

    // Show confirmation dialog with impact details
    const confirmed = await showConfirmDialog({
      title: "Execute Clawback",
      message: `This will claw back ${formatAmount(proposal.amount)} from ${proposal.target}`,
      details: {
        approvals: `${proposal.approvals.length}/${requiredApprovals}`,
        reason: proposal.reason,
        timelock: calculateTimelock(proposal.created_ledger),
      },
    });

    if (!confirmed) return;

    const tx = await tokenContract.execute_clawback({
      executor: currentUser,
      proposal_id: proposalId,
    });
    
    await tx.signAndSend();
    loadProposals();
  }

  return (
    <div className="governance-panel">
      <h2>Token Governance</h2>
      
      <section>
        <h3>Governors</h3>
        <ul>
          {governors.map(gov => (
            <li key={gov}>{gov}</li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Active Proposals</h3>
        {proposals.filter(p => !p.executed).map(proposal => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            onApprove={() => approveProposal(proposal.id)}
            onExecute={() => executeProposal(proposal.id)}
          />
        ))}
      </section>

      <section>
        <h3>Propose New Clawback</h3>
        <ClawbackForm onSubmit={proposeClawback} />
      </section>
    </div>
  );
}
```

### 5. Event Projection Service

```typescript
// backend/src/services/governanceProjection.ts

export async function projectGovernanceEvents(daoId: number): Promise<GovernanceState> {
  const events = await fetchContractEvents(tokenContractId, [
    "GovernanceInitialized",
    "ClawbackProposed",
    "ClawbackApprovalAdded",
    "ClawbackExecuted",
    "AllowanceLimitChanged",
  ]);

  const state: GovernanceState = {
    governors: [],
    requiredApprovals: 0,
    clawbackPeriodLimit: 0n,
    activeProposals: [],
    executedProposals: [],
  };

  for (const event of events) {
    switch (event.type) {
      case "GovernanceInitialized":
        state.governors = event.data.governors;
        state.requiredApprovals = event.data.required_approvals;
        state.clawbackPeriodLimit = event.data.clawback_period_limit;
        break;

      case "ClawbackProposed":
        state.activeProposals.push({
          id: event.data.proposal_id,
          target: event.data.target,
          amount: event.data.amount,
          reason: event.data.reason,
          proposer: event.data.proposer,
          approvals: [event.data.proposer],
          createdLedger: event.ledger,
          executed: false,
        });
        break;

      case "ClawbackApprovalAdded":
        const proposal = state.activeProposals.find(
          p => p.id === event.data.proposal_id
        );
        if (proposal) {
          proposal.approvals.push(event.data.approver);
        }
        break;

      case "ClawbackExecuted":
        const idx = state.activeProposals.findIndex(
          p => p.id === event.data.proposal_id
        );
        if (idx >= 0) {
          const executed = state.activeProposals.splice(idx, 1)[0];
          executed.executed = true;
          state.executedProposals.push(executed);
        }
        break;
    }
  }

  return state;
}
```

## Acceptance Criteria

- [x] Design document for clawback governance workflow
- [x] Design for allowance limit governance with timelocks
- [x] Event schema for auditable governance actions
- [x] Frontend UI design for governance operations
- [x] Event projection service design

**Implementation Status**: Design complete, awaiting implementation phase.

## Implementation Plan

1. **Phase 1**: Contract entry points for clawback governance (~3-4 days)
   - `init_governance`
   - `propose_clawback`
   - `approve_clawback`
   - `execute_clawback`
   - Unit tests

2. **Phase 2**: Allowance limit governance (~2-3 days)
   - `propose_allowance_limit`
   - `execute_allowance_limit`
   - Timelock enforcement
   - Unit tests

3. **Phase 3**: Event projection service (~2 days)
   - Backend projection service
   - State reconciliation
   - API endpoints

4. **Phase 4**: Frontend UI (~3-4 days)
   - GovernancePanel component
   - Proposal forms
   - Approval/execution flows
   - Confirmation dialogs

5. **Phase 5**: Integration testing (~2 days)
   - E2E governance flows
   - Multi-governor scenarios
   - Timelock edge cases

## Dependencies

- ZV-039: Token contract baseline
- ZV-065: Event emission standards
- ZV-001: Frontend architecture

## Security Considerations

1. **Governor Authentication**: All governance functions require `require_auth()` on governor addresses
2. **Approval Threshold**: Enforced at execution time, not during approval accumulation
3. **Timelock Windows**: Both minimum delay and maximum period enforced
4. **Event Replay Protection**: Proposal IDs are monotonic and stored on-chain
5. **Amount Validation**: Clawback amounts checked against period limits
6. **UI Confirmation**: Frontend shows exact impact before signing

## Testing Strategy

```rust
#[test]
fn test_clawback_below_threshold_fails() {
    // Verify execution fails with insufficient approvals
}

#[test]
fn test_clawback_outside_window_fails() {
    // Verify timelock enforcement
}

#[test]
fn test_clawback_exceeds_period_limit_fails() {
    // Verify amount bounds
}

#[test]
fn test_double_approval_fails() {
    // Verify same governor cannot approve twice
}

#[test]
fn test_non_governor_proposal_fails() {
    // Verify authorization
}
```

## References

- Issue: https://github.com/ZK-VOTE/ZK-VOTE/issues/955
- Token contract: `contracts/token/src/lib.rs`
- Allowance module: `contracts/token/src/allowance.rs`
- Storage TTL strategy: `docs/token-storage-ttl-strategy.md`
