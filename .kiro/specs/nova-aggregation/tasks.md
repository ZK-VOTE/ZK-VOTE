# Implementation Plan: nova-aggregation

## Overview

Complete the Nova IVC recursive vote aggregation pipeline end-to-end. The work spans four layers: (1) register the Rust crate in the Cargo workspace and fix two correctness bugs in the Rust library, (2) add a `--verify` CLI subcommand, (3) add a `verifyProof` method to the TypeScript service and a new HTTP route, (4) wire the route into the Express app, and (5) write integration tests for the backend. Property-based tests cover the five correctness properties defined in the design.

## Tasks

- [x] 1. Register `crates/nova-aggregator` in the workspace and add `proptest` dev-dependency
  - In root `Cargo.toml`, add `"crates/nova-aggregator"` to the `members` array
  - In `crates/nova-aggregator/Cargo.toml`, add `proptest = "1.4"` to `[dev-dependencies]`
  - Verify `cargo build -p nova-aggregator` compiles without errors
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Fix nullifier validation in `crates/nova-aggregator/src/circuit.rs`
  - [x] 2.1 Replace the broken no-op nullifier check in `VoteStepCircuit::step` (step 4)
    - Remove the existing `if witness.nullifier != expected_nullifier && !witness.nullifier.is_empty()` block
    - Replace with: `if witness.nullifier != expected_nullifier { return Err(CircuitError::InvalidNullifier); }`
    - The `expected_nullifier` binding already exists just above — no duplication needed
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ]* 2.2 Write unit tests for nullifier validation in `circuit.rs`
    - Add test `test_mismatched_nullifier_rejected`: call `VoteStepCircuit::step` with a witness whose `nullifier` is `"wrong"` and assert `Err(CircuitError::InvalidNullifier)`
    - Add test `test_empty_nullifier_rejected`: call `VoteStepCircuit::step` with a witness whose `nullifier` is `""` and assert `Err(CircuitError::InvalidNullifier)`
    - _Requirements: 2.1, 2.2_

- [x] 3. Add duplicate nullifier detection in `crates/nova-aggregator/src/aggregator.rs`
  - [x] 3.1 Add `HashSet`-based duplicate detection to `aggregate_batch`
    - Add `use std::collections::HashSet;` at the top of the file
    - Declare `let mut seen_nullifiers: HashSet<String> = HashSet::new();` inside `aggregate_batch` before the witness loop
    - Inside the loop, before calling `VoteStepCircuit::step`, add: `if !seen_nullifiers.insert(witness.nullifier.clone()) { return Err(CircuitError::NullifierAlreadyAccumulated); }`
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ]* 3.2 Write unit test for duplicate nullifier rejection in `aggregator.rs`
    - Add test `test_duplicate_nullifier_rejected`: build a 2-element witness batch where both witnesses share the same nullifier; assert that `aggregate_batch` returns `Err(CircuitError::NullifierAlreadyAccumulated)`
    - _Requirements: 3.1, 3.3_

- [x] 4. Checkpoint — run `cargo test -p nova-aggregator`
  - Ensure all existing tests plus the new unit tests pass, ask the user if any questions arise.

- [x] 5. Add `--verify` CLI subcommand to `crates/nova-aggregator/src/bin/main.rs`
  - [x] 5.1 Update `Args` struct to make `--batch` and `--out` optional with `required_unless_present`
    - Change `batch: PathBuf` to `batch: Option<PathBuf>` with `#[arg(short, long, required_unless_present = "verify")]`
    - Change `out: PathBuf` to `out: Option<PathBuf>` with `#[arg(short, long, required_unless_present = "verify")]`
    - Add `verify: Option<PathBuf>` with `#[arg(long)]`
    - Add `use nova_aggregator::RecursiveProofPayload;` to the imports
    - _Requirements: 7.1_

  - [x] 5.2 Add verify mode branch at the top of `main()`
    - Add `if let Some(proof_path) = args.verify { ... }` block before the existing aggregate logic
    - Inside the block: read the file with `fs::read_to_string`; on IO error print `serde_json::json!({"error": e.to_string()})` to stderr and `std::process::exit(2)`
    - Deserialize to `RecursiveProofPayload` with `serde_json::from_str`; on parse error exit 2 the same way
    - Call `NovaAggregator::verify_proof(&payload)`; print `serde_json::json!({"verified": verified})` to stdout; exit 0 if `verified`, exit 1 otherwise
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 5.3 Update aggregate mode body to use `.unwrap()` on the now-optional `batch` and `out`
    - Replace `args.batch` with `args.batch.unwrap()` (only reached when `--batch` was required by clap)
    - Replace `args.out` with `args.out.unwrap()`
    - _Requirements: 7.1_

- [x] 6. Add property-based tests to `crates/nova-aggregator/src/aggregator.rs`
  - [x] 6.1 Add `arb_valid_witness` strategy and shared proptest helpers
    - Inside the `#[cfg(test)]` block, add `use proptest::prelude::*;`
    - Implement `fn arb_valid_witness() -> impl Strategy<Value = VoteWitness>` using `proptest::strategy::Strategy`; generate `secret` as `[a-z]{1,20}`, `salt` as `[a-z]{1,10}`, `vote_choice` from `0u8..=1u8`, derive `nullifier` via `VoteStepCircuit::compute_nullifier`, leave `path_elements`/`path_indices` empty, use fixed `dao_id = 1` / `proposal_id = 100`
    - _Requirements: 3.2_

  - [ ]* 6.2 Write property test for Property 1: nullifier mismatch → `InvalidNullifier`
    - **Property 1: Nullifier Validation Rejects Any Non-Matching Nullifier**
    - **Validates: Requirements 2.1, 2.2, 2.3**
    - Use `proptest!` macro; generate an `arb_valid_witness()` and a separate arbitrary `bad_nullifier: String`; set `witness.nullifier = bad_nullifier`; filter out cases where `bad_nullifier` accidentally equals the derived nullifier; assert `VoteStepCircuit::step` returns `Err(CircuitError::InvalidNullifier)`
    - Add comment: `// Feature: nova-aggregation, Property 1: nullifier mismatch → InvalidNullifier`

  - [ ]* 6.3 Write property test for Property 2: duplicate nullifier → `NullifierAlreadyAccumulated`
    - **Property 2: Duplicate Nullifier in Batch is Rejected**
    - **Validates: Requirements 3.1, 3.3**
    - Use `proptest!` macro; generate a `vec(arb_valid_witness(), 1..=10)` of unique witnesses, then duplicate one entry at a random position; assert `aggregate_batch` returns `Err(CircuitError::NullifierAlreadyAccumulated)`
    - Add comment: `// Feature: nova-aggregation, Property 2: duplicate nullifier → NullifierAlreadyAccumulated`

  - [ ]* 6.4 Write property test for Property 3: aggregate → verify round-trip
    - **Property 3: Aggregate/Verify Round-Trip**
    - **Validates: Requirements 6.1**
    - Use `proptest!` macro; generate `vec(arb_valid_witness(), 1..=20)` with unique nullifiers ensured by using distinct secrets; call `aggregate_batch` then `verify_proof`; assert result is `true`
    - Add comment: `// Feature: nova-aggregation, Property 3: aggregate/verify round-trip`

  - [ ]* 6.5 Write property test for Property 4: tally invariant
    - **Property 4: Tally Invariant**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
    - Use `proptest!` macro; generate a valid batch; count expected yes/no before calling `aggregate_batch`; assert `final_state.step_count == num_votes`, `final_state.yes_votes + final_state.no_votes == num_votes`, `final_state.yes_votes == expected_yes`, `final_state.no_votes == expected_no`
    - Add comment: `// Feature: nova-aggregation, Property 4: tally invariant`

  - [ ]* 6.6 Write property test for Property 5: tampered proof → verify returns false
    - **Property 5: Tampered Payload is Rejected by verify_proof**
    - **Validates: Requirements 6.2, 6.3, 6.4**
    - Use `proptest!` macro with `prop_oneof!` to select one of four mutations: flip a char in `proof_bytes`, increment `final_state.yes_votes`, increment `final_state.no_votes`, or increment `final_state.step_count`; assert `verify_proof` returns `false` for each mutation
    - Add comment: `// Feature: nova-aggregation, Property 5: tampered payload rejected`

- [x] 7. Checkpoint — run `cargo test -p nova-aggregator` and `cargo bench -p nova-aggregator`
  - All unit tests and property tests must pass
  - Bench must compile and start without panic (no need to wait for full bench results)
  - Ask the user if any questions arise.

- [x] 8. Add `verifyProof` method to `backend/src/services/nova-aggregator.ts`
  - Add `async verifyProof(payload: RecursiveProofPayload): Promise<{ verified: boolean }>` method to `NovaAggregatorService`
  - Write payload to `path.join(this.tempDir, \`verify_${timestamp}.json\`)` using `fs.writeFileSync`
  - Run `cargo run -p nova-aggregator --bin nova-aggregator -- --verify "${proofPath}"` via `execAsync` with `cwd` set to the repo root
  - On success (exit 0): parse stdout JSON and return `{ verified: result.verified === true }`
  - On rejection (exit 1): parse `err.stdout` JSON; if `typeof result.verified === "boolean"` return `{ verified: result.verified }`; otherwise return `{ verified: false }`
  - On any other error (exit 2 or unexpected): return `{ verified: false }`
  - Wrap in `try/finally` to always delete the temp file with `fs.unlinkSync` if it exists
  - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 9. Add `POST /api/v1/nova/verify` route to `backend/src/routes/nova.ts`
  - Import `RecursiveProofPayload` from `../services/nova-aggregator.js`
  - Add `router.post("/verify", bodyLimit("100kb"), async (req, res) => { ... })` handler after the existing `/aggregate` handler
  - Validate that `req.body` contains `proof_bytes`, `initial_state`, and `final_state`; return 400 with `{ error: "..." }` if missing
  - Call `novaAggregatorService.verifyProof(payload)` and return `{ success: true, verified: result.verified }` with status 200
  - Catch any thrown errors and return 500 with `{ error: error.message }`
  - _Requirements: 9.3, 9.4_

- [x] 10. Wire nova routes into the backend
  - [x] 10.1 Export `novaRoutes` from `backend/src/routes/index.ts`
    - Add `export { default as novaRoutes } from "./nova.js";` to the end of the exports list
    - _Requirements: 9.1_

  - [x] 10.2 Mount `novaRoutes` in `backend/src/index.ts`
    - Add `novaRoutes` to the named imports from `"./routes/index.js"`
    - Add `app.use("/api/v1/nova", novaRoutes);` after `app.use(circuitRoutes);` and before `app.use(errorHandler);`
    - _Requirements: 9.2_

- [ ] 11. Create `backend/test/nova.test.js`
  - [ ] 11.1 Set up test file with `node:test`, `supertest`, and `execAsync` mock infrastructure
    - Import `test`, `assert`, `request`, and the `NovaAggregatorService` class
    - Add a `_setExecForTest(mockFn)` method to `NovaAggregatorService` (or use constructor injection) so tests can swap `execAsync` without spawning cargo
    - Create a mock `execAsync` for aggregate mode that writes a stub `RecursiveProofPayload` JSON to the output path arg and resolves; create a separate mock for verify mode that resolves with `{ stdout: '{"verified":true}' }`
    - _Requirements: 10.1_

  - [ ]* 11.2 Write test: POST /aggregate → 200 with `proof_bytes` starting with `0x`
    - Call `POST /api/v1/nova/aggregate` with `{ daoId: 1, proposalId: 1, witnesses: [w1, w2] }` where `w1`/`w2` are minimal valid witness objects
    - Assert `res.statusCode === 200`, `res.body.success === true`, and `res.body.data.proof_bytes.startsWith("0x")`
    - _Requirements: 10.2_

  - [ ]* 11.3 Write test: POST /aggregate missing `witnesses` → 400
    - Call `POST /api/v1/nova/aggregate` with `{ daoId: 1, proposalId: 1 }` (no `witnesses` field)
    - Assert `res.statusCode === 400` and `res.body.error` is truthy
    - _Requirements: 10.3_

  - [ ]* 11.4 Write test: `verifyProof` with mocked valid response → `verified: true`
    - Instantiate `NovaAggregatorService` with the verify-mode mock
    - Call `verifyProof` with a minimal valid `RecursiveProofPayload` object
    - Assert `result.verified === true`
    - _Requirements: 10.4_

- [~] 12. Final checkpoint — run all tests
  - Run `cargo test -p nova-aggregator` and confirm it passes
  - Run `cargo bench -p nova-aggregator` and confirm it compiles without error (interrupt after compilation if needed)
  - Run `cd backend && npm test` and confirm `nova.test.js` passes alongside existing tests
  - Ask the user if any questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Checkpoints (tasks 4, 7, 12) ensure incremental validation at logical boundaries
- Property tests (tasks 6.2–6.6) validate all five correctness properties from the design document
- The `_setExecForTest` mock boundary keeps the Node test suite fast and cargo-free at test time
- The bench target (`nova_fold_1k_votes`) needs no source changes — it already calls `VoteStepCircuit::compute_nullifier` for every witness, so it will work correctly once task 1 registers the crate
