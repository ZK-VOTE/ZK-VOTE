# Signal registry, module invariants, and verification notes

This document is the map for the `voting` contract after the
"split into cohesive modules" refactor. The refactor was mechanical: the single
`#[contractimpl] impl Voting` block in `lib.rs` now contains only thin wrappers
that delegate to free functions in domain modules. No storage key, event topic,
`#[contracttype]` name, error discriminant, or public-signal layout was changed.

## 1. Public signal registry

Signal order is part of the circuit ABI. It is pinned by the constants in
`contracts/voting/src/types.rs` and by the `soroban_sdk::vec![...]` construction
sites in `vote_submission.rs` and `tally.rs`.

| Circuit | Signals (in order) | Count | IC length | Constant |
|---------|--------------------|-------|-----------|----------|
| Vote (BN254) | `root, nullifier, dao_id, proposal_id, vote_choice, num_candidates` | 6 | 7 | `NUM_PUBLIC_SIGNALS`, `VOTE_CIRCUIT_IC_LEN` |
| Vote (BLS12-381) | as above | 6 | 7 | `NUM_PUBLIC_SIGNALS`, `VOTE_CIRCUIT_IC_LEN` |
| Vote (depth-specific circuit, #93) | as above | 6 | 7 | `DepthVk` / `ProposalDepthVkHash` |
| Tally (BN254) | `dao_id, proposal_id, num_votes, yes_votes, no_votes, nullifier_acc` | 6 | 7 | `TALLY_NUM_PUBLIC_SIGNALS`, `TALLY_CIRCUIT_IC_LEN` |
| Quadratic vote (issue #50) | `root, dao_id, proposal_id, nullifier, total_credits_spent, allocations_hash` | 6 | 7 | `QV_NUM_PUBLIC_SIGNALS`, `QV_CIRCUIT_IC_LEN` |
| Weighted vote (#301) | vote signals plus domain tag `DOMAIN_TAG_WEIGHTED` (`0x7774_5f76`) | 6 + tag | 7 | `DOMAIN_TAG_WEIGHTED`, `MAX_WEIGHT`, `MIN_WEIGHT` |

Invariants that must hold at every call site:

- Every signal is checked to be inside the scalar field before conversion
  (`Voting::assert_in_field` / `assert_in_field_bls381`).
- A VK is accepted only if `ic.len() <= MAX_IC_LENGTH (21)` and, for the vote
  circuit, matches the declared signal count. `set_vk` additionally requires an
  MPC transcript attestation from the configured transcript registry.
- The tally's `num_votes` must equal the number of spent nullifiers for the
  proposal; the nullifier accumulator is monotonic and opaque to clients.
- Domain tags (weighted, batch, commit-reveal) are circuit-specific and prevent
  cross-circuit replay.

## 2. Module map and invariants

| Module | Owns | Invariants (also in each file's `//!` header) |
|--------|------|-----------------------------------------------|
| `types.rs` | All constants, `VotingError`, `DataKey`, `#[contracttype]` value types | `DataKey` is append-only (variant order **is** the storage discriminant); error discriminants are a public ABI; `symbol_short!` key strings are exact bytes; XDR names are the Rust identifiers, not module paths. |
| `events.rs` | All `#[contractevent]` structs | Struct name is the first event topic; `#[topic]` field order/types are ABI-stable. |
| `vote_submission.rs` | Proposal creation, `vote`, `vote_weighted`, `vote_bls381`, `cast_votes`, `vote_with_circuit`, token-gating/query helpers | One nullifier per `(dao_id, proposal_id)`, stored in temporary storage with TTL from `end_time + NULLIFIER_GRACE_LEDGERS`; proof checked against the VK pinned at creation or the registered depth VK; roots must be in history and not predate creation/revocation; one shared reentrancy lock. |
| `tally.rs` | Recursive tally submission/verification, result publication, proposal lifecycle, nullifier queries/migration | `num_votes` equals spent-nullifier count; tally VK must be configured; failed pairing checks publish nothing; states form `Registration → Active → Closed → Archived` with `Archived` terminal. |
| `admin.rs` | Guardian, pause/unpause, VK management (BN254/BLS/tally/recursive/depth), election config metadata | Admin paths require `require_auth()` plus registry admin check; guardian paths require the configured guardian; VK updates bump the version and write both `VotingKey` and `VkByVersion`; pause auto-expires after `MAX_PAUSE_DURATION`. |
| `migrations.rs` | `__constructor`, version/layout queries, upgrade/rollback, circuit- and transcript-registry hooks | Upgrades are registry-gated; version increases monotonically; storage downgrade rejected; `UpgradeMigration(to_version)` written and `StorageMigratedEvent`/`ContractUpgraded` emitted before Wasm swap. |
| `encrypted_tally.rs` | Randomness commit/reveal, VDF submit/verify, candidate seed and ordering | One commit/reveal per participant per proposal, bounded participant count; seed finalized once, from verified VDF or commit-reveal fallback; VDF bound to its delay and input seed. |
| `storage.rs`, `quadratic.rs`, `sybil.rs`, `commit_reveal.rs`, `stark_verifier.rs` | Pre-existing ancillary modules | Untouched by this refactor. |

`lib.rs` retains: crate/module declarations, the `pub use` re-exports that keep
`crate::VotingError`, `voting::DataKey`, etc. resolving, `panic_coarse`, the thin
`#[contractimpl] impl Voting` wrappers, and the crate-internal helper methods
(`pub(crate)`) shared by the modules. Keeping helpers as inherent methods means
all pre-existing `Self::helper(...)` call sites remain valid with no rewritten
logic.

### Test organization

- `test.rs` remains the home of the large cross-cutting integration suite: its
  cases configure several contracts at once (tree, registry, SBT, transcript
  registry) and exercise multiple domains per test, so splitting them would
  change shared setup and is deliberately avoided.
- Each new module has a focused `#[cfg(test)] mod tests` that pins its
  domain-specific constants and invariants.
- `storage_layout_test.rs` is the storage-layout regression suite: it asserts
  the exact `symbol_short!` key strings, version constants, and the XDR bytes
  (variant-name symbol plus argument order) of representative `DataKey`
  variants. These tests must keep passing unchanged.

## 3. Migration / upgrade hooks

The upgrade hooks are in `migrations.rs`:

- `apply_upgrade_from_registry(wasm_hash, from_version, to_version, storage_version, migration_payload)`
  verifies the current version and payload length, bumps `VERSION_KEY` and
  `STORAGE_VERSION_KEY`, records `ContractMigrationInfo` under
  `UpgradeMigration(to_version)`, emits `StorageMigratedEvent` and
  `ContractUpgraded`, then calls `update_current_contract_wasm`.
- `rollback_upgrade_from_registry(wasm_hash, from_version, to_version)` is the
  registry-gated inverse and records `UpgradeRollback(from_version)`.
- `storage_layout()` / `storage_version()` / `migration_for_version()` expose
  the metadata for clients. `get_pending_vk_proposal()` and
  `is_vk_proposal_ready()` are the circuit-registry side of a VK migration.
- Adding a new `DataKey` variant requires appending to the enum in `types.rs`
  and extending `storage_layout_test.rs`; never insert in the middle.

## 4. Verification performed

- `cargo check -p voting --offline`: passes.
- `cargo test -p voting --offline --no-run`: passes (all test targets compile).
- `cargo test -p voting --offline`: the network suite reports 77 passed / 55
  failed. The 55 failures are **pre-existing on this branch**: their shared
  `setup_env_with_registry()` helper does not configure a transcript registry,
  while `set_vk` now requires a transcript attestation. They fail identically
  with the pre-refactor logic restored. This refactor introduces no new
  failures.
- Snapshot equivalence: the test suite was run twice in a throwaway copy of the
  tree — once with the refactored code, once with the pre-refactor method bodies
  mechanically restored. All 133 snapshots produced by both runs were
  byte-identical (`diff -rq` reported zero differing files). The committed
  `contracts/voting/test_snapshots/` directory in the working tree was restored
  from HEAD and was not modified by these runs. Snapshots in the repository are
  therefore unchanged; they already differ from newly generated ones because of
  the transcript-registry change noted above, not because of this refactor.

## 5. Measuring Wasm size / instruction count

The refactor is expected to be size- and instruction-neutral: it only changes
where a function's source lives, and the compiler inlines the thin wrappers.
**No measurements were taken for this change; do not treat any number as
measured.** To measure on a machine with the `wasm32v1-none` target installed:

```bash
rustup target add wasm32v1-none
cargo build --target wasm32v1-none --release -p voting

# Optimized size (Binaryen):
wasm-opt -Oz contracts/voting/target/wasm32v1-none/release/voting.wasm \
  -o /tmp/voting.opt.wasm
ls -l /tmp/voting.opt.wasm

# Section breakdown / rough instruction count:
wasm-objdump -h /tmp/voting.opt.wasm
wasm-objdump -d /tmp/voting.opt.wasm | grep -cE '^\s*[0-9a-f]+:'
```

Use the same SDK/toolchain and the same flags for the before and after builds,
and compare `wasm-opt -Oz` byte size plus the `wasm-objdump` code-section size /
instruction count. Any significant increase should be investigated before
merging.
