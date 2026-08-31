# ZK Voting Protocol: Anti-Flash Loan Mechanism

## Overview

This document describes the anti-flash loan protection mechanism implemented in the ZK-VOTE protocol. Flash loan attacks allow an attacker to borrow large amounts of tokens, use them to gain voting power, vote, and return the tokens — all within a single transaction. The ZK-VOTE protocol prevents this through a combination of balance snapshotting, time-weighted average balances, and transfer cooldowns.

## Attack Vector

If election eligibility is gated on token balance (e.g., requiring governance token holdings to vote), without protection:

1. Attacker flash-loans a large amount of governance tokens from a lending protocol
2. Attacker registers for an election (which checks current balance)  
3. Attacker casts a vote with inflated voting power
4. Attacker returns the borrowed tokens
5. All within a single Stellar transaction (multi-operation)

## Protection Mechanisms

### 1. Balance Snapshotting

**Location**: `contracts/voting/src/lib.rs` — `DataKey::BalanceSnapshot`, `create_balance_snapshot()`

When a proposal (election) is created, the current ledger sequence is recorded as the snapshot point in `ProposalInfo.snapshot_ledger`. Token balances are frozen at this point for eligibility determination.

**Key components**:
- `BalanceSnapshotInfo` struct stores `snapshot_ledger` (ledger sequence) and `timestamp`
- `ProposalInfo.snapshot_ledger` field records when the proposal was created
- `create_balance_snapshot()` captures the snapshot
- `get_balance_snapshot()` retrieves the snapshot for verification

### 2. Voter Eligibility at Snapshot Time

**Location**: `contracts/voting/src/lib.rs` — `check_voter_eligibility()`

Voter eligibility checks the voter's balance at the snapshot ledger, not the current ledger. This prevents flash loans because:

- The snapshot was taken at proposal creation (before the attacker could borrow)
- Current balance is irrelevant for eligibility
- Flash loans cannot change historical balance data

**Flow**:
1. `ElectionConfig` stores `min_balance`, `twab_window`, and `snapshot_ledger`
2. `check_voter_eligibility()` verifies `balance_at_snapshot >= cfg.min_balance`
3. Token contracts call this function before allowing votes in token-gated elections

### 3. Election Configuration

**Location**: `contracts/voting/src/lib.rs` — `ElectionConfig`, `DataKey::ElectionConfig`

Each proposal can have an `ElectionConfig` that defines:

| Field | Type | Description |
|-------|------|-------------|
| `snapshot_ledger` | `u32` | Ledger sequence at configuration creation |
| `min_balance` | `i128` | Minimum token balance required to vote |
| `twab_window` | `u64` | Time window for TWAB computation (0 = disable TWAB) |
| `candidate_seed` | `Option<BytesN<32>>` | Finalized election randomness used for candidate ordering |

Configured via `set_election_config()` and retrieved via `get_election_config()`.

### 4. Time-Weighted Average Balance (TWAB)

**Location**: `contracts/voting/src/lib.rs` — `record_balance_checkpoint()`, `get_time_weighted_average_balance()`

TWAB provides Sybil resistance by measuring the average balance over time, not just at a single point. This prevents:

- Flash loans (instant balance changes don't affect the average)
- Balance renting (temporary transfers for voting power)

**How it works**:
- `BalanceCheckpoint` stores (dao_id, address, ledger_seq) -> balance
- Token contracts call `record_balance_checkpoint()` when balances change
- `get_time_weighted_average_balance()` computes the average across a ledger range
- TWAB = Σ(balance_i × duration_i) / total_duration

### 5. Transfer Cooldown

**Location**: 
- `contracts/voting/src/lib.rs` — `set_voter_cooldown()`, `clear_voter_cooldown()`, `is_in_transfer_cooldown()`
- `contracts/membership-sbt/src/lib.rs` — `set_election_cooldown()`, `clear_election_cooldown()`, `is_in_cooldown()`

During an active election, registered voters enter a transfer cooldown that prevents them from:

- Transferring governance tokens out (reducing their stake)
- Leaving the DAO (bypassing membership requirements)
- Having their SBT revoked to avoid vote accountability

**Cooldown enforcement**:
- `set_voter_cooldown()` sets a 7-day cooldown when a voter registers/votes
- `is_in_transfer_cooldown()` is called by token contracts before allowing transfers
- `leave()` in SBT contract checks cooldown before allowing departure
- Cooldown is cleared when the election ends via `clear_voter_cooldown()`

## Election Randomness

Stellar has no native VRF oracle, so elections use a multi-party commit-reveal
protocol to produce a verifiable seed:

1. During the first hour after proposal creation, between two and 32 DAO members
   commit `SHA-256(dao_id || proposal_id || participant_xdr || secret)`.
2. During the next hour, each committer authenticates and reveals their
   32-byte secret. The contract rejects missing, repeated, or mismatched
   reveals.
3. Anyone may finalize after the commit window. The contract hashes the
   election identifiers and every reveal from the fixed on-chain committer
   list, then stores the result in `ElectionConfig.candidate_seed`.
4. Candidate ordering is derived by sorting candidates by
   `SHA-256(candidate_seed || candidate_id)`. Anyone can recompute and verify
   these order keys.

The election admin cannot provide or filter the reveal list at finalization.
Every recorded committer must reveal, so an admin cannot choose a favorable
subset after seeing the values. Domain separation prevents a commitment from
being reused for another election or participant.

This favors integrity over liveness: a committer who withholds a reveal can
prevent finalization. Clients should monitor both windows and treat an
unfinalized seed as a failed randomness round rather than falling back to
admin-selected or transaction PRNG data.

## Integration Guide

### For Token Contracts

Token contracts should integrate with the voting contract to enforce flash loan protection:

```rust
// Before allowing a transfer, check cooldown
fn transfer(..., from: Address, ...) {
    let voting_contract: Address = ...;
    let in_cooldown: bool = env.invoke_contract(
        &voting_contract,
        &Symbol::new(&env, "is_in_transfer_cooldown"),
        vec![&env, dao_id.into_val(&env), from.clone().into_val(&env)],
    );
    if in_cooldown {
        panic!("Transfer blocked: voter is in election cooldown");
    }
    // Proceed with transfer
}

// Record balance checkpoints for TWAB
fn after_balance_change(..., voter: Address, new_balance: i128) {
    let voting_contract: Address = ...;
    env.invoke_contract(
        &voting_contract,
        &Symbol::new(&env, "record_balance_checkpoint"),
        vec![&env, dao_id.into_val(&env), voter.into_val(&env), new_balance.into_val(&env)],
    );
}
```

### For Election Creation

```rust
// Create a token-gated election
fn create_token_gated_proposal(...) {
    let proposal_id = voting_contract.create_proposal(...);
    
    // Create balance snapshot
    voting_contract.create_balance_snapshot(dao_id, proposal_id);
    
    // Configure token-gating
    voting_contract.set_election_config(
        dao_id, 
        proposal_id, 
        min_balance: 1000 * 10^7, // 1000 tokens (7 decimal places)
        twab_window: 86400, // 24-hour TWAB window
    );
}
```

### For Voting

```rust
fn vote_with_token_gate(..., voter, proposal_id) {
    // Check eligibility at snapshot time (not current balance)
    let eligible = voting_contract.check_voter_eligibility(
        dao_id, 
        proposal_id, 
        voter,
        current_balance,
        balance_at_snapshot_ledger,
    );
    if !eligible {
        panic!("Insufficient balance at snapshot time");
    }
    
    // Set cooldown to prevent transfer after voting
    voting_contract.set_voter_cooldown(dao_id, voter);
    
    // Submit vote
    voting_contract.vote(...);
}
```

## Storage Keys

### Voting Contract

| DataKey | Type | Description |
|---------|------|-------------|
| `BalanceSnapshot(dao_id, proposal_id)` | `BalanceSnapshotInfo` | Balance snapshot at proposal creation |
| `ElectionConfig(dao_id, proposal_id)` | `ElectionConfig` | Token-gating configuration |
| `TransferCooldown(dao_id, address)` | `u64` | Cooldown end timestamp |
| `BalanceCheckpoint(dao_id, address, ledger)` | `i128` | Balance at a specific ledger |

### Membership SBT Contract

| DataKey | Type | Description |
|---------|------|-------------|
| `TransferCooldown(dao_id, address)` | `u64` | Cooldown end timestamp for SBT transfers |
| `InActiveElection(dao_id, address)` | `bool` | Whether member is in an active election |

## Error Codes

| Contract | Error | Code | Description |
|----------|-------|------|-------------|
| Voting | `TransferCooldownActive` | 27 | Transfer blocked during active election |
| Voting | `InsufficientSnapshotBalance` | 28 | Balance at snapshot time below minimum |
| SBT | `CooldownActive` | 6 | Cannot leave DAO during active election |

## Poseidon Hash Parameters

Every commitment, nullifier and Merkle node in the protocol is a Poseidon hash
over the BN254 scalar field, so the parameter set is part of the protocol's
security argument rather than an implementation detail.

| Parameter | Value |
|-----------|-------|
| Field | BN254 `Fr` (254-bit prime) |
| S-box | `x^5` |
| Full rounds `R_F` | 8 |
| Partial rounds `R_P` | 57 for `t=3`, 56 for `t=4`, 60 for `t=5` |
| Security level | 128 bits |

State widths in use: `t=3` for Merkle node and leaf-domain hashing (the only
width the on-chain contract carries parameters for), `t=4` for the vote
nullifier `Poseidon(secret, daoId, proposalId)`, `t=5` for the identity
commitment `Poseidon(DOMAIN_TAG, secret, salt, blindingFactor)`.

These values are not chosen; they are derived. The round constants come from
the Grain LFSR specified in Grassi et al. (USENIX Security 2021, Appendix F),
seeded only by the parameters above, and the MDS matrix is the Cauchy matrix
built from the continuation of that same stream. `circuits/utils/poseidon_param_audit.js`
re-derives both from the seed, re-runs the reference generator's three
matrix-security tests (no invariant subspace, no subspace trail, no iterated
subspace trail) against the shipped values, and checks `R_F`/`R_P` against the
published statistical, interpolation and Gröbner-basis bounds — including with
the designers' security margin stripped off, to show how much margin remains.
`circuits/poseidon_params.test.js` runs all of it in CI, and the on-chain
vendored copy in `contracts/membership-tree/src/poseidon_params.rs` is pinned
to the same derivation by a shared SHA-256 digest.

Full detail, including the current cryptanalysis picture and why Poseidon2 is
not adopted, is in [docs/poseidon-parameters.md](./poseidon-parameters.md).

## Security Considerations

1. **Ledger sequence vs timestamp**: Snapshots use ledger sequence numbers which are monotonically increasing and cannot be manipulated. Timestamps are used only for cooldown expiry.

2. **TWAB granularity**: Balance checkpoints should be recorded at every balance change to ensure accurate TWAB computation. Sparse checkpoints reduce accuracy.

3. **Cooldown duration**: The 7-day cooldown is a default that should be adjusted based on the election duration. Short elections may use shorter cooldowns; long elections should extend it.

4. **Gas costs**: TWAB computation iterates over checkpoints within a range. For frequently-traded tokens, this could be expensive. Consider limiting the checkpoint range.

## Proof Serialization Format (ZKV1)

The ZK proof pipeline (snarkjs JSON &rarr; backend `stellar.ts` &rarr; Soroban `Proof`/`BytesN<256>`) previously converted between representations without a single documented byte layout. `ZKV1` is the canonical, versioned wire format used to move a Groth16 proof between components, implemented identically in:

- Rust: `contracts/zkvote-groth16/src/serialization.rs` (`serialize_proof` / `deserialize_proof`)
- TypeScript: `backend/src/services/proofSerialization.ts` (`serializeProof` / `deserializeProof`)

### Byte layout

```
[ version (1B) | curve_id (1B) | A_x (32B) | A_y (32B)
  | B_x1 (32B) | B_x2 (32B) | B_y1 (32B) | B_y2 (32B)
  | C_x (32B) | C_y (32B) ]
```

| Field | Size | Description |
|-------|------|--------------|
| `version` | 1 byte | Format version, currently `0x01`. Bumped on any incompatible layout change so old/new decoders can safely reject data they don't understand. |
| `curve_id` | 1 byte | `0x00` = BN254, `0x01` = BLS12-381. |
| `A` | 64 bytes | G1 affine point, `X \|\| Y`, each coordinate 32-byte **big-endian**. |
| `B` | 128 bytes | G2 affine point, `X_c1 \|\| X_c0 \|\| Y_c1 \|\| Y_c0`, each 32-byte big-endian (matches the existing `G2Hex` convention in `backend/src/types/index.ts`). |
| `C` | 64 bytes | G1 affine point, same layout as `A`. |

Total length: `1 + 1 + 64 + 128 + 64 = 258` bytes.

**Endianness**: all field-element bytes are big-endian, matching `hexToBytes`/`proofToScVal` in `backend/src/services/stellar.ts` and the `BytesN<64>`/`BytesN<128>` big-endian convention already used by the contract.

### Example proof vector (interoperability fixture)

For cross-implementation testing (see `backend/test/proof-serialization.test.js`), the following degenerate-but-well-formed vector round-trips through both the Rust and TypeScript implementations:

```
a = 0x01 repeated 64 times
b = 0x02 repeated 128 times
c = 0x03 repeated 64 times
version = 0x01, curve_id = 0x00 (BN254)

ZKV1 bytes (hex) = 0x0100 + ("01" * 64) + ("02" * 128) + ("03" * 64)
```

### Relationship to `proofToScVal`

`backend/src/services/stellar.ts::proofToScVal` continues to build the Soroban `Map { a, b, c }` argument the deployed `Groth16Curve::verify` entry point expects — that map's field order and point sizes are exactly the `A`/`B`/`C` slice of the ZKV1 format (i.e. ZKV1 bytes `[2..258]`). `ZKV1` adds the explicit version/curve header on top so a proof can be stored, logged, or handed to an external auditor as a single self-describing blob without needing out-of-band knowledge of which curve or format revision produced it. `proofToScVal`'s existing point-at-infinity and length validation is reused by `serializeProof`, so a proof that would be rejected by the contract call path is also rejected by the ZKV1 encoder.

### Scope note

This format currently covers the BN254 G1&times;G2&times;G1 proof shape used by the single on-chain `Proof` type (`contracts/zkvote-groth16/src/lib.rs`). The BLS12-381 curve id byte is defined and round-trip tested, but `ProofBls381` uses different point sizes (`BytesN<96>`/`BytesN<192>`); encoding those is a straightforward follow-up (a `curve_id`-dependent length) left out of this change to keep the initial format landing minimal and unambiguous for the BN254 path that is actually deployed today.
