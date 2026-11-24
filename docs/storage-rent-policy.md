# Storage Rent Policy & TTL Enforcement

> SPIKE-052 / issue #732 / issue #881 (ZV-032) — Soroban storage rent economics, per-DAO footprint accounting, and TTL budget enforcement.

## 1. Overview and Problem Statement

Every DAO on ZK-VOTE spreads persistent and temporary state across multiple smart contracts (registry entries, member roles, multisig proposals, verification keys, Merkle tree nodes, proposals, ballots, nullifiers, and comments). Soroban bills storage rent per entry and per byte at ledger close.

Without per-DAO footprint accounting and TTL extension budgets, malicious actors can:
- Externalize storage costs onto relayers and network participants.
- Grow state unboundedly to exhaust victim DAOs or protocol subsidies.
- Deplete shared relayer TTL budgets to expire critical governance or active voting state.

This document defines the runtime storage rent policy, per-DAO footprint accounting, TTL extension budget and priority rules, cold-state archival, cryptographic commitment verification, reverse-griefing protections, and operational alerting.

---

## 2. Per-DAO Storage Footprint Accounting

Per-DAO storage accounting is implemented at runtime in `contracts/dao-registry/src/lib.rs`.

Each DAO maintains an isolated `StorageFootprint` record stored persistently under `(Symbol::short("ftprint"), dao_id)`:
```rust
pub struct StorageFootprint {
    pub total_entries: u32,
    pub total_bytes: u64,
    pub governance_entries: u32,
    pub governance_bytes: u64,
    pub voting_entries: u32,
    pub voting_bytes: u64,
    pub membership_entries: u32,
    pub membership_bytes: u64,
    pub auxiliary_entries: u32,
    pub auxiliary_bytes: u64,
}
```

### Accounting Invariants:
- **Atomicity**: Accounting adjustments and underlying storage mutations occur in the same Soroban transaction. If a write would exceed the DAO's configured quota, the contract aborts with `RegistryError::StorageQuotaExceeded`, reverting all changes atomically.
- **Deduplication**: Updates to existing entries adjust byte allocations by the delta (`new_bytes - old_bytes`) without incrementing entry counts.
- **Deallocations**: Deletions release entry and byte counters via `release_storage_footprint`.
- **Identity Isolation**: Storage accounting is keyed strictly to `dao_id`. One DAO's writes cannot modify or consume another DAO's accounting footprint.

---

## 3. Storage Categories and Size Calculation

State is classified into four discrete categories:

| Category | Storage Category | Primary Entries | Representative Bytes |
|----------|------------------|-----------------|----------------------|
| **Governance** | `StorageCategory::Governance` (0) | `DaoInfo`, `MultisigConfig`, `MultisigProposal`, `UpgradeProposal` | ~160 – 1024 bytes |
| **Voting** | `StorageCategory::Voting` (1) | `ProposalInfo`, `ElectionConfig`, `Nullifier`, `TallyProof`, `VdfOutput` | ~32 – 512 bytes |
| **Membership** | `StorageCategory::Membership` (2) | `MemberRole`, SBT balances, tree leaves | ~64 bytes |
| **Auxiliary** | `StorageCategory::Auxiliary` (3) | `DaoCreationReceipt`, metadata pointers, comments | ~64 – 256 bytes |

Byte accounting calculations reflect measured serialization overheads:
- `DaoInfo`: 256 bytes
- `DaoCreationReceipt`: 80 bytes
- `MemberRole`: 64 bytes
- `MultisigConfig`: 160 bytes
- `MultisigProposal`: 512 bytes
- `CircuitUpgradeProposal`: 256 bytes
- `ContractUpgradeProposal`: 1024 bytes

---

## 4. Per-DAO Storage Caps and Quotas

DAO quotas are stored in `StorageQuota` under `(Symbol::short("quota"), dao_id)`:
- `DEFAULT_MAX_ENTRIES_PER_DAO`: 105,000 entries (supports 100,000 members + 1,000 proposals + governance records).
- `DEFAULT_MAX_BYTES_PER_DAO`: 50,000,000 bytes (50 MB).

### Quota Adjustments:
Only the validated DAO admin may adjust caps via `set_dao_quota(env, dao_id, max_entries, max_bytes, admin)`:
- Requires `admin.require_auth()`.
- Validates `require_dao_admin(env, dao_id, &admin)`.
- Rejects quota reductions below the DAO's current footprint (`current.total_entries` / `current.total_bytes`), preventing admins from inadvertently bricking active DAOs.

---

## 5. Cost Attribution and Rent Payer Model

| Action | Primary Rent Payer | Notes |
|--------|-------------------|-------|
| DAO Creation | Creator | Pays Soroban instance/entry creation fees |
| Membership Role / SBT Mint | Admin or Joiner | Subject to `MAX_MEMBERS_PER_DAO` and quota |
| Proposal Creation | Proposer | Subject to deposit and per-DAO entry limits |
| Comment Creation | Commenter | Subject to `MAX_COMMENTS_PER_PROPOSAL` |
| Persistent Write Mutations | Caller / Initiator | Charged against DAO's persistent footprint |
| TTL Extensions | Backend Relayer / Treasury | Bounded by DAO's `TtlExtensionBudget` |

---

## 6. TTL Extension Budget and Priority Enforcement

Implemented in `contracts/voting/src/lib.rs`.

Each DAO is allocated an explicit, configurable TTL renewal budget tracked under `DataKey::TtlBudget(dao_id)`:
```rust
pub struct TtlExtensionBudget {
    pub max_budget: u32,
    pub consumed_budget: u32,
    pub period_start_ledger: u32,
    pub period_length_ledgers: u32,
}
```
- `DEFAULT_TTL_BUDGET_PER_PERIOD`: 10,000 units.
- `DEFAULT_TTL_PERIOD_LEDGERS`: 17,280 ledgers (~24 hours at 5s/ledger).
- `MIN_TTL_BUMP_COST`: 10 units (prevents zero/sub-cost spam attacks).

### Priority Ordering:

1. **Critical** (`TtlPriority::Critical` = 0):
   - Scope: Governance records, active election proposals, spent nullifiers, active verification keys (`VotingKey`, `ElectionConfig`).
   - Rule: Permitted up to 100% of available budget.
2. **Standard** (`TtlPriority::Standard` = 1):
   - Scope: Settled/closed proposals, finalized tallies, historical balance checkpoints.
   - Rule: Permitted only when consumed budget does not exceed 85% of `max_budget` (reserves 15% for Critical operations).
3. **Low** (`TtlPriority::Low` = 2):
   - Scope: Cold auxiliary state, historical receipts, unclosed comment threads.
   - Rule: Permitted only when consumed budget does not exceed 50% of `max_budget` (reserves 50% for Standard/Critical operations).

### Budget Exhaustion & Rejection Signals:
When an extension request cannot be granted under the priority rules:
- Emits `TtlExtensionRejectedEvent { dao_id, priority, requested_cost, consumed_budget, max_budget }`.
- Failed requests **do not** consume budget units.
- Relayer defers or drops the low-priority renewal without failing the transaction or impacting sibling DAOs.

---

## 7. Cold-State Archival

Implemented in `backend/src/services/archival.ts`.

### Archival Eligibility:
- Historical event state from closed/ended proposals (`proposal_closed`, `proposal_archived`).
- Events must be older than `archivalAgeDays` (default: 90 days).
- Active election events are **never** eligible for archival.

### Archival Process:
1. Export events into deterministic JSON Lines.
2. Compress with gzip into `events_dao_<id>_<timestamp>.jsonl.gz`.
3. Compute SHA-256 archive checksum.
4. Compute cryptographic state commitment across canonical event records (`computeStateCommitment`).
5. Persist metadata record in SQLite `archive_records`:
   - `archive_id`, `dao_id`, `proposal_id`, `storage_category` ("voting")
   - `file_name`, `file_path`, `event_count`, `checksum`, `commitment`, `status` ("archived")
6. Delete archived records from SQLite active partition in batches within an abortable loop.
7. Execute checkpoint (`wal_checkpoint(TRUNCATE)`).

---

## 8. Cryptographic Commitment Generation & Verification

To prevent corrupted, incomplete, or tampered archives from corrupting the active database upon restoration:

1. **Commitment Generation**:
   Canonical ordering by `(ledger, timestamp, id)`.
   Each event is serialized with sorted JSON keys and hashed via SHA-256:
   $$\text{leaf}_i = \text{SHA-256}(\text{canonical\_json}(e_i))$$
   The aggregate commitment is the SHA-256 digest of the concatenated leaf digests:
   $$\text{commitment} = \text{SHA-256}(\text{leaf}_0 : \text{leaf}_1 : \dots : \text{leaf}_n)$$
2. **Commitment Verification on Restoration**:
   - The archive file's SHA-256 checksum is validated against `archive_records.checksum`.
   - The decompressed events are parsed, canonically sorted, and their commitment recomputed.
   - If `computed_commitment !== record.commitment`, restoration aborts immediately with `verification_failed`.
   - Successful verification allows idempotent re-insertion (`INSERT OR IGNORE`) and status transition to `restored` or `recommitted`.

---

## 9. Reverse-Griefing Protections

A storage quota or TTL budget mechanism can itself be weaponized if an attacker spams state to freeze a DAO or exhaust relayer funds.

Implemented protections:
1. **Isolated Accounting**: Footprints and TTL budgets are isolated per DAO (`dao_id`). An attacker spamming DAO A cannot exhaust DAO B's storage footprint or TTL budget.
2. **Quota Modification Gate**: Quotas can only be raised or lowered by the authenticated DAO admin; unauthorized callers cannot lower caps or manipulate accounting.
3. **Minimum Bump Cost**: Every TTL bump incurs a minimum charge of 10 budget units (`MIN_TTL_BUMP_COST`), neutralizing micro-bump budget exhaustion attacks.
4. **Budget Reservation Headroom**: Standard and Low extensions are cut off at 85% and 50% of budget capacity, ensuring active elections and nullifier bumps are never starved by background renewals.
5. **Rejected Requests Free**: Failed or rejected extensions do not decrement budget counters.
6. **No Shared Relayer Subsidies**: Relayers operate against per-DAO budgets; a depleted budget produces an event and stops renewal for that DAO without affecting others.

---

## 10. Operational Metrics and Alerting

Implemented in `backend/src/services/metrics.ts` adhering to `metric-cardinality.ts`:

### Prometheus Metrics:
- `zkvote_storage_entries_usage{category, status}`: Current entry count by category.
- `zkvote_storage_bytes_usage{category}`: Current byte usage by category.
- `zkvote_storage_limits_configured{type}`: Configured entry and byte caps.
- `zkvote_storage_quota_rejections_total{category, reason}`: Total rejected writes exceeding quotas.
- `zkvote_ttl_budget_consumption_total{priority}`: Consumed TTL budget units.
- `zkvote_ttl_extension_rejections_total{priority, reason}`: Extensions rejected due to budget limits.
- `zkvote_ttl_budget_exhaustion_warnings_total{priority}`: Warning counter for approaching exhaustion.
- `zkvote_archival_operations_total{operation, status}`: Archival and restoration lifecycle events.
- `zkvote_archival_verification_failures_total{reason}`: Commitment verification failures.

### Metric Cardinality Rules:
- Dynamic IDs (`dao_id`, `proposal_id`, addresses) are **strictly banned** from metric labels.
- Only bounded, pre-audited enums (`category`, `priority`, `reason`, `status`, `type`, `operation`) are used.

### Alerting Conditions:
1. **Footprint Warnings**: Fires when a DAO reaches 85% of entry or byte caps; errors at 100%.
2. **TTL Budget Warnings**: Fires when TTL budget reaches 80% of capacity; errors at 100%.
3. **Archival / Verification Failures**: Immediate error alert on corrupted files or commitment mismatches.
4. **Deduplication**: Alerts are throttled with a 5-minute suppression window to prevent alert fatigue.
5. **ZV-044 Integration**: Dispatches to global ZV-044 Alert Manager if loaded; falls back to structured JSON logging otherwise.

---

## 11. Operational Recovery and Restoration Behavior

In the event of accidental archival or audit queries requiring cold state:
1. Call `restoreArchivedState(archiveId, { recommit?: boolean })`:
   - Validates checksum and recomputes cryptographic commitment.
   - Executes inside a database transaction.
   - Inserts records using `INSERT OR IGNORE` (idempotent; safe against duplicate execution).
   - Marks archive status as `restored` or `recommitted`.
2. On corrupted archive:
   - File is left intact; error is logged with detailed reason.
   - No records are inserted into SQLite active tables.
   - An alert is dispatched immediately for operator intervention.
