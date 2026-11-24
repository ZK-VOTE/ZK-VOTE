# Contract Upgrade Framework

## Overview

This document describes the upgrade framework for ZK-VOTE smart contracts on Soroban. The framework enables secure contract upgrades with data migration, versioning, and rollback capabilities.

## Architecture

### Versioning System

All contracts implement a version tracking system:

```rust
const VERSION: u32 = 2;  // Current contract version
const VERSION_KEY: Symbol = symbol_short!("ver");

pub fn version(env: Env) -> u32 {
    env.storage()
        .instance()
        .get(&VERSION_KEY)
        .unwrap_or(VERSION)
}
```

### Upgrade Functions

Contracts expose upgrade endpoints:

```rust
/// Upgrade contract WASM (governance-gated)
pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>, admin: Address) {
    admin.require_auth();
    assert_admin(&env, &admin);

    // Deploy new WASM
    env.deployer().update_current_contract_wasm(new_wasm_hash);

    // Emit upgrade event
    ContractUpgraded {
        from: version(env.clone()),
        to: VERSION,
    }.publish(&env);
}

/// Migrate data after upgrade
pub fn migrate(env: Env, from_version: u32, to_version: u32, admin: Address) {
    admin.require_auth();
    assert_admin(&env, &admin);

    // Version-specific migration logic
    match (from_version, to_version) {
        (1, 2) => migrate_v1_to_v2(&env),
        (2, 3) => migrate_v2_to_v3(&env),
        _ => panic!("Unsupported migration path"),
    }

    // Update version
    env.storage().instance().set(&VERSION_KEY, &to_version);
}
```

## Data Migration Patterns

### Pattern 1: Add New Field (Backward Compatible)

```rust
// Version 1
#[contracttype]
pub struct ProposalV1 {
    pub id: u64,
    pub title: String,
}

// Version 2 - Add optional field
#[contracttype]
pub struct ProposalV2 {
    pub id: u64,
    pub title: String,
    pub description: Option<String>,  // New field, optional
}

fn migrate_v1_to_v2(env: &Env) {
    // No data migration needed - new field is optional
    // Old data remains valid
}
```

### Pattern 2: Remove Field

```rust
// Version 1
#[contracttype]
pub struct VoteRecordV1 {
    pub nullifier: U256,
    pub timestamp: u64,
    pub deprecated_field: String,  // To be removed
}

// Version 2
#[contracttype]
pub struct VoteRecordV2 {
    pub nullifier: U256,
    pub timestamp: u64,
    // deprecated_field removed
}

fn migrate_v1_to_v2(env: &Env) {
    // Iterate all VoteRecord keys and rewrite without deprecated field
    // This can be expensive - consider lazy migration
}
```

### Pattern 3: Change DataKey Structure

```rust
// Version 1: Flat keys
enum DataKeyV1 {
    Vote(U256),  // Just nullifier
}

// Version 2: Hierarchical keys
enum DataKeyV2 {
    Vote(u64, u64, U256),  // (dao_id, proposal_id, nullifier)
}

fn migrate_v1_to_v2(env: &Env) {
    // For each old vote:
    //   1. Read from old key
    //   2. Write to new key with additional context
    //   3. Delete old key

    // WARNING: This is expensive and may hit transaction limits
    // Consider deploying a new contract instead
}
```

### Pattern 4: Lazy Migration

For large datasets, migrate on access:

```rust
pub fn get_proposal(env: Env, dao_id: u64, proposal_id: u64) -> ProposalV2 {
    let key = DataKey::Proposal(dao_id, proposal_id);

    match env.storage().persistent().get::<_, ProposalV2>(&key) {
        Some(proposal) => proposal,
        None => {
            // Try loading old format
            let old = env.storage().persistent()
                .get::<_, ProposalV1>(&key)
                .unwrap();

            // Migrate to new format
            let new = ProposalV2 {
                id: old.id,
                title: old.title,
                description: None,  // Default for migrated data
            };

            // Save in new format
            env.storage().persistent().set(&key, &new);
            new
        }
    }
}
```

## Storage Schema Versioning

Track schema version separately from contract version:

```rust
const SCHEMA_VERSION_KEY: Symbol = symbol_short!("schema");

#[contracttype]
pub enum DataKey {
    SchemaVersion,
    // v1 keys
    ProposalV1(u64),
    // v2 keys
    ProposalV2(u64, u64),
}

fn get_schema_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&SCHEMA_VERSION_KEY)
        .unwrap_or(1)
}
```

## Governance-Gated Upgrades

### Multi-Sig Governance

```rust
const GOVERNANCE_THRESHOLD: u32 = 3;  // 3 of 5 multisig

pub fn propose_upgrade(
    env: Env,
    new_wasm_hash: BytesN<32>,
    proposer: Address,
) -> u64 {
    proposer.require_auth();

    let proposal_id = next_upgrade_proposal_id(&env);

    let proposal = UpgradeProposal {
        id: proposal_id,
        wasm_hash: new_wasm_hash,
        proposed_at: env.ledger().timestamp(),
        approvals: Vec::new(&env),
        executed: false,
    };

    env.storage().persistent().set(
        &DataKey::UpgradeProposal(proposal_id),
        &proposal
    );

    proposal_id
}

pub fn approve_upgrade(
    env: Env,
    proposal_id: u64,
    approver: Address,
) {
    approver.require_auth();
    assert_governance_member(&env, &approver);

    let mut proposal = get_upgrade_proposal(&env, proposal_id);

    if !proposal.approvals.contains(&approver) {
        proposal.approvals.push_back(approver);
    }

    env.storage().persistent().set(
        &DataKey::UpgradeProposal(proposal_id),
        &proposal
    );
}

pub fn execute_upgrade(env: Env, proposal_id: u64, executor: Address) {
    executor.require_auth();

    let mut proposal = get_upgrade_proposal(&env, proposal_id);

    // Check threshold
    if proposal.approvals.len() < GOVERNANCE_THRESHOLD {
        panic!("Insufficient approvals");
    }

    // Check timelock
    let timelock_end = proposal.proposed_at + (48 * 3600); // 48 hours
    if env.ledger().timestamp() < timelock_end {
        panic!("Timelock not expired");
    }

    // Execute upgrade
    env.deployer().update_current_contract_wasm(proposal.wasm_hash.clone());

    proposal.executed = true;
    env.storage().persistent().set(
        &DataKey::UpgradeProposal(proposal_id),
        &proposal
    );
}
```

### Time-Lock Mechanism

```rust
const UPGRADE_TIMELOCK: u64 = 48 * 3600;  // 48 hours

#[contracttype]
pub struct UpgradeProposal {
    pub wasm_hash: BytesN<32>,
    pub proposed_at: u64,
    pub executable_at: u64,  // = proposed_at + UPGRADE_TIMELOCK
}

pub fn schedule_upgrade(
    env: Env,
    new_wasm_hash: BytesN<32>,
    admin: Address,
) -> u64 {
    admin.require_auth();
    assert_admin(&env, &admin);

    let now = env.ledger().timestamp();
    let executable_at = now + UPGRADE_TIMELOCK;

    let proposal = UpgradeProposal {
        wasm_hash: new_wasm_hash,
        proposed_at: now,
        executable_at,
    };

    let proposal_id = next_proposal_id(&env);
    env.storage().persistent().set(
        &DataKey::UpgradeProposal(proposal_id),
        &proposal
    );

    UpgradeProposedEvent {
        proposal_id,
        wasm_hash: new_wasm_hash,
        executable_at,
    }.publish(&env);

    proposal_id
}

pub fn execute_upgrade(env: Env, proposal_id: u64) {
    let proposal = get_upgrade_proposal(&env, proposal_id);

    // Check timelock
    if env.ledger().timestamp() < proposal.executable_at {
        panic!("Upgrade timelock not expired");
    }

    // Execute
    env.deployer().update_current_contract_wasm(proposal.wasm_hash);

    // Cleanup
    env.storage().persistent().remove(&DataKey::UpgradeProposal(proposal_id));
}

pub fn cancel_upgrade(env: Env, proposal_id: u64, admin: Address) {
    admin.require_auth();
    assert_admin(&env, &admin);

    env.storage().persistent().remove(&DataKey::UpgradeProposal(proposal_id));

    UpgradeCancelledEvent { proposal_id }.publish(&env);
}
```

## Rollback Mechanism

### Store Previous WASM

```rust
const PREVIOUS_WASM_KEY: Symbol = symbol_short!("prevwasm");

pub fn upgrade_with_rollback(
    env: Env,
    new_wasm_hash: BytesN<32>,
    admin: Address,
) {
    admin.require_auth();

    // Store current WASM hash before upgrade
    let current_wasm = env.deployer().current_contract_wasm();
    env.storage().instance().set(&PREVIOUS_WASM_KEY, &current_wasm);

    // Execute upgrade
    env.deployer().update_current_contract_wasm(new_wasm_hash);
}

pub fn rollback(env: Env, admin: Address) {
    admin.require_auth();
    assert_admin(&env, &admin);

    // Get previous WASM
    let previous_wasm: BytesN<32> = env.storage()
        .instance()
        .get(&PREVIOUS_WASM_KEY)
        .unwrap();

    // Rollback to previous version
    env.deployer().update_current_contract_wasm(previous_wasm);

    RollbackEvent {
        from_version: version(env.clone()),
        to_wasm: previous_wasm,
    }.publish(&env);
}
```

## Testing Upgrade Paths

```rust
#[test]
fn test_upgrade_v1_to_v2() {
    let env = Env::default();

    // Deploy V1
    let contract_v1 = env.register_contract_wasm(None, V1_WASM);
    let client_v1 = V1Client::new(&env, &contract_v1);

    // Create data in V1
    client_v1.create_proposal(&1, &String::from_str(&env, "Test"));

    // Upgrade to V2
    let v2_wasm_hash = env.deployer().upload_contract_wasm(V2_WASM);
    client_v1.upgrade(&v2_wasm_hash, &admin);

    // Migrate data
    let client_v2 = V2Client::new(&env, &contract_v1);
    client_v2.migrate(&1, &2, &admin);

    // Verify data after migration
    let proposal = client_v2.get_proposal(&1);
    assert_eq!(proposal.title, String::from_str(&env, "Test"));
    assert_eq!(proposal.description, None);  // New field defaults to None
}
```

## Deployment Scripts

### deploy.sh Enhancement

```bash
#!/bin/bash

MODE=${1:-"fresh"}  # "fresh" or "upgrade"

if [ "$MODE" = "fresh" ]; then
    # Fresh deployment
    echo "Deploying new contract instance..."
    soroban contract deploy \
        --wasm target/wasm32v1-none/release/voting.wasm \
        --network $NETWORK
else
    # Upgrade existing
    echo "Upgrading existing contract..."
    CONTRACT_ID=$(cat .deployed-contracts | grep voting | awk '{print $2}')

    # Upload new WASM
    WASM_HASH=$(soroban contract install \
        --wasm target/wasm32v1-none/release/voting.wasm \
        --network $NETWORK)

    echo "Proposing upgrade to $WASM_HASH..."

    # Call upgrade function
    soroban contract invoke \
        --id $CONTRACT_ID \
        --fn propose_upgrade \
        --arg $WASM_HASH \
        --network $NETWORK
fi
```

## Compatibility Matrix

| From Version | To Version         | Data Migration | Breaking Changes | Strategy               |
| ------------ | ------------------ | -------------- | ---------------- | ---------------------- |
| 1 → 2        | Add optional field | None           | No               | Direct upgrade         |
| 2 → 3        | Remove field       | Lazy           | No               | Lazy migration         |
| 3 → 4        | Change DataKey     | Full           | Yes              | New contract + migrate |

## Best Practices

1. **Version All Contracts**: Every contract should expose `version()`
2. **Backward Compatible When Possible**: Use optional fields for new data
3. **Test Migration Paths**: Write tests for every upgrade path
4. **Use Timelocks**: Require 48h delay for production upgrades
5. **Multi-Sig Governance**: Never allow single-party upgrades in production
6. **Document Changes**: Maintain CHANGELOG.md with migration notes
7. **Monitor After Upgrade**: Watch for errors post-upgrade, be ready to rollback
8. **Lazy Migration**: For large datasets, migrate on access rather than all-at-once

## Emergency Procedures

### Critical Bug Found

1. **Pause**: Call `pause()` if contract has emergency pause
2. **Notify**: Alert all governance members
3. **Prepare Fix**: Build and test patched WASM
4. **Expedited Upgrade**: Use emergency multi-sig to bypass timelock
5. **Monitor**: Watch contract behavior after patch

### Failed Upgrade

1. **Identify Issue**: Check logs, test failed functions
2. **Rollback**: Execute `rollback()` to previous WASM
3. **Post-Mortem**: Analyze what went wrong
4. **Fix and Retest**: Prepare corrected upgrade
5. **Retry**: Attempt upgrade again with fix

## References

- Soroban Upgradeability: https://soroban.stellar.org/docs/fundamentals-and-concepts/upgradeability
- Contract Migration Patterns: https://soroban.stellar.org/docs/learn/persisting-data
- Multi-Sig Governance: https://soroban.stellar.org/docs/tutorials/multi-sig

## Implementation Checklist

For each contract:

- [x] Add `version()` function
- [ ] Implement `upgrade()` with admin check
- [ ] Implement `migrate()` for data migration
- [ ] Add `ContractUpgraded` event
- [ ] Add governance multi-sig (production)
- [ ] Add timelock mechanism (production)
- [ ] Implement `rollback()` capability
- [ ] Write upgrade tests
- [ ] Update deployment scripts
- [ ] Document migration procedures

---

## Cross-Contract Version Handshakes and Constructor Cascades (SPIKE-051)

### Problem Statement

The 15-member Cargo workspace deploys as separate WASM contracts whose constructor arguments
(`--registry`, `--sbt_contract`, `--tree_contract`) are baked at deploy time. No runtime
version negotiation exists between callee and caller. Upgrading a contract that changes its
return types or error enums breaks callers silently at runtime.

Three specific failure modes are addressed here:

1. **Silent interface breakage** — `membership-tree` returns a new error enum variant;
   `voting` falls through to an unhandled `Err` arm and panics.
2. **Constructor-arg redeploy cascade** — changing the `dao-registry` address requires
   re-deploying `membership-sbt`, `membership-tree`, `voting`, and `comments` in the correct
   dependency order with updated constructor args.
3. **`default-members` vs full workspace divergence** — local builds test 9 of 15 members;
   CI builds all 15. Interface changes to the 6 non-default members are never caught locally.

### Version Handshake Pattern

Every cross-contract call site that may break on callee upgrade must perform a version check
before dispatching. The callee exposes `version() -> u32` (already required by this framework).
The caller pins a `MIN_CALLEE_VERSION` constant and checks at call time:

```rust
// In contracts/voting/src/lib.rs
const MIN_TREE_VERSION: u32 = 3;

fn assert_tree_version(env: &Env, tree_client: &MembershipTreeClient) {
    let v = tree_client.version();
    if v < MIN_TREE_VERSION {
        panic!("membership-tree version {} is below required minimum {}", v, MIN_TREE_VERSION);
    }
}
```

The check runs once per transaction (not per ledger entry) and is gated behind a storage flag
that caches the result for the duration of the transaction to avoid redundant cross-contract
calls.

### Minimum-Version Matrix

| Caller | Callee | Min version | Breaking changes guarded |
|---|---|---|---|
| `voting` | `membership-tree` | 3 | `get_leaf` return shape change in v3 |
| `voting` | `dao-registry` | 2 | `is_member` boolean → `MemberStatus` enum in v2 |
| `comments` | `membership-tree` | 3 | same as above |
| `comments` | `voting` | 2 | `proposal_state` enum extension in v2 |
| `comments` | `dao-registry` | 2 | same as voting |
| `membership-tree` | `membership-sbt` | 2 | `sbt_active` signature change in v2 |

### Constructor-Cascade Redeploy Tooling

The following shell script encodes the dependency order and re-deploys all downstream
contracts when an upstream address changes. It is idempotent: if a contract's WASM hash
and constructor args are unchanged, the deploy is skipped.

```bash
#!/usr/bin/env bash
# scripts/redeploy-cascade.sh
# Usage: ./redeploy-cascade.sh --network testnet [--registry <addr>] [--sbt <addr>] [--tree <addr>]
set -euo pipefail

NETWORK=${NETWORK:-testnet}
CONTRACTS_FILE=".deployed-contracts.${NETWORK}.json"

redeploy_if_changed() {
  local name=$1 wasm=$2 args=$3
  local current_hash
  current_hash=$(stellar contract install --wasm "$wasm" --network "$NETWORK" 2>/dev/null)
  local stored_hash
  stored_hash=$(jq -r ".\"${name}\".wasm_hash // empty" "$CONTRACTS_FILE" 2>/dev/null)
  local stored_args
  stored_args=$(jq -r ".\"${name}\".constructor_args // empty" "$CONTRACTS_FILE" 2>/dev/null)

  if [ "$current_hash" = "$stored_hash" ] && [ "$args" = "$stored_args" ]; then
    echo "  [skip] $name — WASM hash and args unchanged"
    return 0
  fi

  echo "  [deploy] $name"
  local contract_id
  contract_id=$(stellar contract deploy --wasm "$wasm" --network "$NETWORK" $args)
  # Update the contracts file with new address and hash
  jq --arg name "$name" --arg id "$contract_id" --arg hash "$current_hash" --arg a "$args" \
    '.[$name] = {contract_id: $id, wasm_hash: $hash, constructor_args: $a}' \
    "$CONTRACTS_FILE" > /tmp/contracts_tmp.json && mv /tmp/contracts_tmp.json "$CONTRACTS_FILE"
  echo "    → $contract_id"
}

# Parse overrides
REGISTRY_ADDR=$(jq -r '.["dao-registry"].contract_id' "$CONTRACTS_FILE")
SBT_ADDR=$(jq -r '.["membership-sbt"].contract_id' "$CONTRACTS_FILE")
TREE_ADDR=$(jq -r '.["membership-tree"].contract_id' "$CONTRACTS_FILE")

while [[ $# -gt 0 ]]; do
  case $1 in
    --registry) REGISTRY_ADDR=$2; shift 2 ;;
    --sbt)      SBT_ADDR=$2;      shift 2 ;;
    --tree)     TREE_ADDR=$2;     shift 2 ;;
    --network)  NETWORK=$2;       shift 2 ;;
    *) shift ;;
  esac
done

echo "=== Redeploy cascade for network: $NETWORK ==="

# Layer 0: no dependencies
redeploy_if_changed "dao-registry" \
  "target/wasm32v1-none/release/dao_registry.wasm" ""

# Layer 1: depends on registry
redeploy_if_changed "membership-sbt" \
  "target/wasm32v1-none/release/membership_sbt.wasm" \
  "--registry $REGISTRY_ADDR"

redeploy_if_changed "circuit-registry" \
  "target/wasm32v1-none/release/circuit_registry.wasm" ""

# Layer 2: depends on registry + sbt
redeploy_if_changed "membership-tree" \
  "target/wasm32v1-none/release/membership_tree.wasm" \
  "--registry $REGISTRY_ADDR --sbt_contract $SBT_ADDR"

# Layer 3: depends on registry + sbt + tree
redeploy_if_changed "voting" \
  "target/wasm32v1-none/release/voting.wasm" \
  "--registry $REGISTRY_ADDR --sbt_contract $SBT_ADDR --tree_contract $TREE_ADDR"

redeploy_if_changed "comments" \
  "target/wasm32v1-none/release/comments.wasm" \
  "--registry $REGISTRY_ADDR --sbt_contract $SBT_ADDR --tree_contract $TREE_ADDR"

echo "=== Cascade complete ==="
```

### `default-members` vs Full Workspace Alignment

The `default-members` list in `Cargo.toml` omits 6 workspace members
(`zkvote-prover`, `rewards`, `poc-bls12-381`, `token`, `vdf`, `threshold-crypto`).
Local `cargo build` and `cargo test` only cover the 9 default members, which means
interface changes to the 6 non-default members are never caught locally.

**Fix**: add a `[workspace.metadata.ci]` key that CI reads to assert `--workspace`:

```toml
# Cargo.toml — workspace metadata
[workspace.metadata.ci]
# CI must build and test the full workspace, not just default-members.
# Run: cargo test --workspace
full_workspace_required = true
```

CI (`.github/workflows/`) must pass `--workspace` to all `cargo build`, `cargo test`, and
`cargo clippy` invocations. The `default-members` shortlist is kept only for developer
convenience (faster local builds); it must not diverge from the full member set on any
interface-touching change.

### Open Action Items (SPIKE-051 resolution)

- [x] Document version-handshake pattern and minimum-version matrix (this section)
- [x] Document constructor-cascade redeploy tooling and dependency order
- [x] Document `default-members` vs full workspace alignment fix
- [ ] Implement `assert_callee_version` helper in each caller contract (see matrix above)
- [ ] Add `scripts/redeploy-cascade.sh` to repository
- [ ] Update CI workflows to pass `--workspace` to all cargo commands
- [ ] Add integration test: deploy old `membership-tree` (v2) → confirm `voting` panics with version mismatch
- [ ] Add integration test: run cascade script → confirm all downstream contracts updated
- [ ] Update `schema-versioning.md` with cross-contract compatibility policy
