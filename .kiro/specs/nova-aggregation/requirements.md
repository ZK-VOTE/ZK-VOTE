# Requirements Document

## Introduction

The `nova-aggregation` feature completes the Nova IVC (Incrementally Verifiable Computation) recursive proof aggregation pipeline for the ZK-VOTE system. The current implementation is a scaffold: the fold/verify logic has bugs, the Rust crate is not registered in the Cargo workspace, the backend HTTP route is not wired into the server, no integration tests exist, and the Criterion benchmark cannot run. This feature makes the aggregation pipeline fully functional and verifiable end-to-end — from vote witness ingestion through IVC folding, proof compression, proof verification, and HTTP exposure — with a passing benchmark suite and integration tests.

## Glossary

- **IVC (Incrementally Verifiable Computation)**: A proof technique where each step `F(z_{i-1}, ω_i) → z_i` folds a new witness into the running state, producing a proof whose size is independent of the number of steps.
- **IvcState**: The running accumulator vector `z_i` carrying `step_count`, Merkle `root`, `yes_votes`, `no_votes`, and `acc_nullifier_hash`.
- **VoteWitness**: The private input `ω_i` for a single voter, including `secret`, `salt`, Merkle `path_elements`/`path_indices`, `vote_choice`, `nullifier`, `dao_id`, and `proposal_id`.
- **RecursiveProofPayload**: The serialised output of a completed fold, containing `initial_state`, `final_state`, `num_votes`, `proof_bytes` (hex), and `timestamp`.
- **Nullifier**: A domain-separated hash `Poseidon(secret, dao_id, proposal_id)` that uniquely identifies a vote without revealing the voter's identity. Prevents double-voting.
- **Commitment**: `Poseidon(secret, salt)` — the leaf value in the Merkle identity tree.
- **Merkle Proof**: A sequence of sibling nodes and path indices that proves a commitment leaf belongs to a specific Merkle `root`.
- **NovaAggregator**: The Rust struct in `crates/nova-aggregator/src/aggregator.rs` that orchestrates batch folding and proof verification.
- **VoteStepCircuit**: The Rust struct in `crates/nova-aggregator/src/circuit.rs` that executes one IVC step, validates the witness, and transitions the state.
- **NovaAggregatorService**: The TypeScript service in `backend/src/services/nova-aggregator.ts` that shells out to the Rust CLI for aggregation and verification.
- **Nova Route**: The Express router in `backend/src/routes/nova.ts` mounted under `/api/v1/nova`.
- **Criterion**: A Rust benchmarking library. The bench target `nova_fold_1k_votes` must run via `cargo bench -p nova-aggregator`.

---

## Requirements

### Requirement 1: Workspace Registration

**User Story:** As a Rust developer, I want the `nova-aggregator` crate registered in the Cargo workspace, so that I can build, test, and benchmark it with standard workspace commands.

#### Acceptance Criteria

1. THE `Cargo.toml` workspace `members` array SHALL include `"crates/nova-aggregator"`.
2. WHEN `cargo build -p nova-aggregator` is executed, THE Workspace SHALL compile the crate without errors.
3. WHEN `cargo test -p nova-aggregator` is executed, THE Workspace SHALL run all unit tests in the crate.
4. WHEN `cargo bench -p nova-aggregator` is executed, THE Workspace SHALL run the `nova_fold_1k_votes` Criterion benchmark without compilation errors.

---

### Requirement 2: Nullifier Validation Correctness

**User Story:** As a protocol designer, I want the IVC step circuit to reject any witness whose nullifier field does not match the derived nullifier, so that votes with forged or stale nullifiers are never folded into the proof.

#### Acceptance Criteria

1. WHEN `VoteStepCircuit::step` is called with a `VoteWitness` whose `nullifier` field does not equal `VoteStepCircuit::compute_nullifier(secret, dao_id, proposal_id)`, THEN THE `VoteStepCircuit` SHALL return `Err(CircuitError::InvalidNullifier)`.
2. WHEN `VoteStepCircuit::step` is called with a `VoteWitness` whose `nullifier` field is an empty string, THEN THE `VoteStepCircuit` SHALL return `Err(CircuitError::InvalidNullifier)`.
3. THE `VoteStepCircuit` SHALL accept a witness only when the witness `nullifier` field exactly equals `compute_nullifier(secret, dao_id, proposal_id)`.

---

### Requirement 3: Duplicate Nullifier Detection

**User Story:** As a protocol designer, I want the aggregator to detect and reject duplicate nullifiers within a single batch, so that a voter cannot cast more than one vote in an aggregation run.

#### Acceptance Criteria

1. WHEN `NovaAggregator::aggregate_batch` processes a batch of witnesses in which any two witnesses share the same nullifier, THEN THE `NovaAggregator` SHALL return `Err(CircuitError::NullifierAlreadyAccumulated)` before folding the duplicate.
2. WHEN `NovaAggregator::aggregate_batch` processes a batch of witnesses where all nullifiers are distinct, THEN THE `NovaAggregator` SHALL complete successfully and return an `Ok(RecursiveProofPayload)`.
3. THE `NovaAggregator` SHALL maintain a set of seen nullifiers during batch processing and check each new witness against that set before executing the step.

---

### Requirement 4: Merkle Proof Verification

**User Story:** As a protocol designer, I want the Merkle proof verification to reject invalid paths and only use the test-mode root bypass during explicit test configuration, so that proof security is not inadvertently weakened in production.

#### Acceptance Criteria

1. WHEN `VoteStepCircuit::verify_merkle_proof` is called with a `path_elements` and `path_indices` whose lengths differ, THEN THE `VoteStepCircuit` SHALL return `false`.
2. WHEN `VoteStepCircuit::verify_merkle_proof` is called with a correct inclusion proof for `leaf` against `root`, THEN THE `VoteStepCircuit` SHALL return `true`.
3. WHEN `VoteStepCircuit::verify_merkle_proof` is called with an incorrect path that does not hash to `root`, THEN THE `VoteStepCircuit` SHALL return `false`.
4. WHERE the test-mode root shortcut is enabled (root values `"0x0..."`, `"0xroot..."`, `"0x1234"`), THE `VoteStepCircuit` SHALL bypass path verification and return `true`, so that unit tests can operate without constructing full Merkle trees.

---

### Requirement 5: IVC Tally Invariant

**User Story:** As an election auditor, I want the final IVC state to accurately reflect the folded vote tally, so that the resulting proof certifies an exact count of YES and NO votes.

#### Acceptance Criteria

1. THE `IvcState` after `NovaAggregator::aggregate_batch` completes SHALL satisfy: `final_state.step_count == initial_state.step_count + num_votes`.
2. THE `IvcState` after `NovaAggregator::aggregate_batch` completes SHALL satisfy: `final_state.yes_votes + final_state.no_votes == initial_state.yes_votes + initial_state.no_votes + num_votes`.
3. WHEN all witnesses in a batch have `vote_choice == 1`, THE `NovaAggregator` SHALL set `final_state.yes_votes == initial_state.yes_votes + num_votes` and `final_state.no_votes == initial_state.no_votes`.
4. WHEN all witnesses in a batch have `vote_choice == 0`, THE `NovaAggregator` SHALL set `final_state.no_votes == initial_state.no_votes + num_votes` and `final_state.yes_votes == initial_state.yes_votes`.

---

### Requirement 6: Proof Round-Trip (Aggregate → Verify)

**User Story:** As an election auditor, I want `verify_proof` to confirm any proof generated by `aggregate_batch`, so that the system can confirm a tally has not been tampered with.

#### Acceptance Criteria

1. FOR ALL valid batches of witnesses, calling `NovaAggregator::aggregate_batch` followed by `NovaAggregator::verify_proof` on the resulting payload SHALL return `true` (round-trip property).
2. WHEN `NovaAggregator::verify_proof` is called with a `RecursiveProofPayload` whose `proof_bytes` has been altered, THEN THE `NovaAggregator` SHALL return `false`.
3. WHEN `NovaAggregator::verify_proof` is called with a payload whose `final_state.step_count` does not equal `initial_state.step_count + num_votes`, THEN THE `NovaAggregator` SHALL return `false`.
4. WHEN `NovaAggregator::verify_proof` is called with a payload whose `final_state.yes_votes` or `final_state.no_votes` has been altered while `proof_bytes` remains unchanged, THEN THE `NovaAggregator` SHALL return `false`.

---

### Requirement 7: CLI Verify Subcommand

**User Story:** As a backend operator, I want the `nova-aggregator` CLI to support a `--verify` mode that reads a proof JSON file and exits with code 0 on success, so that the TypeScript service can invoke proof verification without re-running the full aggregation.

#### Acceptance Criteria

1. WHEN the CLI is invoked with `--verify <proof_path>`, THE `nova-aggregator` binary SHALL read the `RecursiveProofPayload` JSON from `<proof_path>`.
2. WHEN the loaded `RecursiveProofPayload` passes `NovaAggregator::verify_proof`, THE CLI SHALL print a JSON result with `"verified": true` to stdout and exit with code `0`.
3. WHEN the loaded `RecursiveProofPayload` fails `NovaAggregator::verify_proof`, THE CLI SHALL print a JSON result with `"verified": false` to stdout and exit with code `1`.
4. IF the file at `<proof_path>` cannot be read or parsed as `RecursiveProofPayload`, THEN THE CLI SHALL print a JSON error message to stderr and exit with code `2`.

---

### Requirement 8: Backend Service Verify Method

**User Story:** As a backend developer, I want `NovaAggregatorService` to expose a `verifyProof` method, so that the API layer can confirm a previously generated proof without re-aggregating.

#### Acceptance Criteria

1. THE `NovaAggregatorService` SHALL expose a `verifyProof(payload: RecursiveProofPayload): Promise<{ verified: boolean }>` method.
2. WHEN `verifyProof` is called with a valid `RecursiveProofPayload`, THE `NovaAggregatorService` SHALL write the payload to a temporary file, invoke the CLI with `--verify`, read the result, and return `{ verified: true }`.
3. WHEN `verifyProof` is called with an invalid or tampered `RecursiveProofPayload`, THE `NovaAggregatorService` SHALL return `{ verified: false }`.
4. THE `NovaAggregatorService` SHALL delete the temporary proof file after the CLI invocation completes, regardless of success or failure.

---

### Requirement 9: Nova Route Registration

**User Story:** As a backend developer, I want the Nova aggregation route mounted in the Express application, so that clients can reach `POST /api/v1/nova/aggregate` through the running server.

#### Acceptance Criteria

1. THE `backend/src/routes/index.ts` SHALL export `novaRoutes` from `./nova.js`.
2. THE `backend/src/index.ts` SHALL mount `novaRoutes` on the Express application so that requests to `/nova/aggregate` are handled by the Nova router.
3. WHEN a `POST /api/v1/nova/aggregate` request is received with a valid body containing `daoId`, `proposalId`, and a non-empty `witnesses` array, THE Nova Route SHALL return HTTP `200` with a JSON body containing `success: true` and a `data` field with the `RecursiveProofPayload`.
4. WHEN a `POST /api/v1/nova/aggregate` request is received with a missing or non-array `witnesses` field, THE Nova Route SHALL return HTTP `400` with a JSON body containing an `error` field.

---

### Requirement 10: Backend Integration Test

**User Story:** As a QA engineer, I want a `backend/test/nova.test.js` integration test, so that CI can confirm the aggregate endpoint works end-to-end.

#### Acceptance Criteria

1. THE `nova.test.js` file SHALL use `node:test` and `supertest` consistent with existing backend tests.
2. WHEN `POST /api/v1/nova/aggregate` is called with a valid payload containing at least two witnesses, THE test SHALL assert HTTP status `200` and that `response.body.data.proof_bytes` is a non-empty hex string.
3. WHEN `POST /api/v1/nova/aggregate` is called with a payload missing `witnesses`, THE test SHALL assert HTTP status `400`.
4. WHEN the proof returned by the aggregate endpoint is passed to `novaAggregatorService.verifyProof`, THE test SHALL assert that `verified` equals `true`.

---

### Requirement 11: Criterion Benchmark Execution

**User Story:** As a performance engineer, I want the Criterion benchmark `nova_fold_1k_votes` to execute without errors, so that I can measure per-vote fold latency at scale.

#### Acceptance Criteria

1. WHEN `cargo bench -p nova-aggregator` is executed, THE Workspace SHALL complete the `nova_fold_1k_votes` benchmark without panicking or returning a non-zero exit code.
2. THE `nova_fold_1k_votes` benchmark SHALL fold exactly `1000` vote witnesses in a single `b.iter` call.
3. THE benchmark SHALL produce timing output to stdout compatible with the Criterion HTML report format.
