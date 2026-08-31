# Design Document: nova-aggregation

## Overview

This feature completes the Nova IVC recursive vote aggregation pipeline for ZK-VOTE. The pipeline has four distinct layers that must all be wired together:

1. **Rust crate** (`crates/nova-aggregator`) — fixed bug in nullifier validation, added duplicate detection, new `--verify` CLI subcommand, and workspace registration.
2. **TypeScript service** (`backend/src/services/nova-aggregator.ts`) — new `verifyProof` method that shells out to the Rust `--verify` CLI.
3. **HTTP route** (`backend/src/routes/nova.ts`) — new `POST /api/v1/nova/verify` handler; route exported and mounted.
4. **Tests** (`backend/test/nova.test.js`) — node:test + supertest tests with mocked `execAsync` so no Rust toolchain is required at test time.

### Key Design Decisions

- **CLI-as-verification-oracle**: The TypeScript layer does not re-implement proof verification logic. It delegates entirely to the compiled `nova-aggregator` binary, reading the exit code to determine the result. This keeps the TypeScript layer thin and the Rust logic as the single source of truth.
- **Mock boundary at `execAsync`**: The backend tests mock `execAsync` at the module level. This means CI never needs `cargo` installed; the Node test suite is fast and fully isolated.
- **`proptest` for Rust property tests**: The `proptest` crate is the idiomatic choice for property-based testing in Rust. It integrates directly with `#[cfg(test)]` and `cargo test`.
- **No temp file leaks**: Both `aggregateVotes` and `verifyProof` use a `try/finally` block to delete temp files regardless of CLI outcome.

---

## Architecture

```mermaid
graph TD
    A[HTTP Client] -->|POST /api/v1/nova/aggregate| B[Express Router\nnova.ts]
    A -->|POST /api/v1/nova/verify| B
    B -->|aggregateVotes()| C[NovaAggregatorService\nnova-aggregator.ts]
    B -->|verifyProof()| C
    C -->|cargo run --batch ...| D[Rust CLI: nova-aggregator\ncrates/nova-aggregator/src/bin/main.rs]
    C -->|cargo run --verify ...| D
    D -->|NovaAggregator::aggregate_batch| E[Aggregator Engine\naggregator.rs]
    D -->|NovaAggregator::verify_proof| E
    E -->|VoteStepCircuit::step x N| F[Step Circuit\ncircuit.rs]
    F -->|poseidon_hash_2/3| G[SHA-256 hasher\nsha2 crate]
```

The Rust crate is a standalone binary and library. The TypeScript service is the only caller of the binary; it communicates via temp JSON files and exit codes. There is no shared memory or RPC — the boundary is the filesystem and process exit codes.

---

## Components and Interfaces

### 1. `crates/nova-aggregator` (Rust)

#### 1.1 `Cargo.toml` — workspace registration

Add `"crates/nova-aggregator"` to the `members` array in the root `Cargo.toml`. Also add `proptest` as a dev-dependency in `crates/nova-aggregator/Cargo.toml`:

```toml
# crates/nova-aggregator/Cargo.toml
[dev-dependencies]
criterion = "0.5"
proptest = "1.4"
```

#### 1.2 `circuit.rs` — nullifier validation fix

The current code in `VoteStepCircuit::step` (step 4) contains a logic bug:

```rust
// CURRENT (BUG): allows mismatched non-empty nullifiers through
if witness.nullifier != expected_nullifier && !witness.nullifier.is_empty() {
    // Allow matching if explicit nullifier supplied  ← this comment is misleading
}
```

The condition means: "if nullifier doesn't match AND it's not empty, do nothing" — effectively the inverse of what the comment says. Empty strings also slip through because `!witness.nullifier.is_empty()` is false for `""`.

**Fix**: Replace the entire block with a strict equality check:

```rust
// FIXED: reject any nullifier that doesn't exactly match the derived value
let expected_nullifier =
    Self::compute_nullifier(&witness.secret, witness.dao_id, witness.proposal_id);
if witness.nullifier != expected_nullifier {
    return Err(CircuitError::InvalidNullifier);
}
```

This handles both the mismatch case (Requirement 2.1) and the empty-string case (Requirement 2.2) with a single check.

#### 1.3 `aggregator.rs` — duplicate nullifier detection

Add a `HashSet<String>` to track seen nullifiers in `aggregate_batch`. The check must happen **before** calling `VoteStepCircuit::step` (which would fail later on the circuit side; the aggregator-level check gives a clearer error and short-circuits early):

```rust
// crates/nova-aggregator/src/aggregator.rs
use std::collections::HashSet;

pub fn aggregate_batch(
    initial_state: IvcState,
    witnesses: &[VoteWitness],
) -> Result<RecursiveProofPayload, CircuitError> {
    let mut current_state = initial_state.clone();
    let num_votes = witnesses.len() as u64;
    let mut seen_nullifiers: HashSet<String> = HashSet::new();

    for witness in witnesses {
        if !seen_nullifiers.insert(witness.nullifier.clone()) {
            return Err(CircuitError::NullifierAlreadyAccumulated);
        }
        current_state = VoteStepCircuit::step(&current_state, witness)?;
    }
    // ... rest unchanged
}
```

The `HashSet::insert` returns `false` when the element was already present, so `!insert(...)` is the duplicate check.

#### 1.4 `bin/main.rs` — `--verify` subcommand

The CLI currently has a single operating mode (aggregate). Add a mutually exclusive `--verify` mode using a `clap` subcommand or a simple `Option<PathBuf>` argument. The simplest approach that matches the requirements is an optional `--verify` argument; when present, the `--batch`/`--out` arguments become optional:

```rust
#[derive(Parser, Debug)]
#[command(author, version, about = "Nova IVC Recursive Vote Aggregator CLI")]
struct Args {
    /// Path to JSON file containing vote witnesses array (aggregate mode)
    #[arg(short, long, required_unless_present = "verify")]
    batch: Option<PathBuf>,

    /// Path to output JSON file for recursive proof payload (aggregate mode)
    #[arg(short, long, required_unless_present = "verify")]
    out: Option<PathBuf>,

    /// Path to proof JSON file to verify (verify mode)
    #[arg(long)]
    verify: Option<PathBuf>,

    /// Merkle tree root (hex string, aggregate mode only)
    #[arg(short, long,
          default_value = "0x0000000000000000000000000000000000000000000000000000000000000000")]
    root: String,

    /// Run in benchmark mode (aggregate mode only)
    #[arg(long, default_value_t = false)]
    benchmark: bool,
}

fn main() {
    let args = Args::parse();

    if let Some(proof_path) = args.verify {
        // --- VERIFY MODE ---
        let content = match fs::read_to_string(&proof_path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("{}", serde_json::json!({"error": e.to_string()}));
                std::process::exit(2);
            }
        };
        let payload: RecursiveProofPayload = match serde_json::from_str(&content) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("{}", serde_json::json!({"error": e.to_string()}));
                std::process::exit(2);
            }
        };
        let verified = NovaAggregator::verify_proof(&payload);
        println!("{}", serde_json::json!({"verified": verified}));
        std::process::exit(if verified { 0 } else { 1 });
    }

    // --- AGGREGATE MODE (existing logic, unchanged) ---
    // ... existing main body using args.batch.unwrap() and args.out.unwrap()
}
```

Exit codes:
- `0` — proof verified
- `1` — proof failed verification
- `2` — file read/parse error

### 2. `backend/src/services/nova-aggregator.ts` — `verifyProof` method

Add the method to `NovaAggregatorService`. The pattern mirrors `aggregateVotes`: write a temp file, invoke CLI, read exit code, clean up.

```typescript
/**
 * Verifies a previously generated recursive proof by invoking the CLI --verify mode.
 * Returns { verified: true } on exit code 0, { verified: false } on exit code 1.
 * Throws on CLI invocation failure (exit code 2 or unexpected error).
 */
async verifyProof(
  payload: RecursiveProofPayload,
): Promise<{ verified: boolean }> {
  const timestamp = Date.now();
  const proofPath = path.join(this.tempDir, `verify_${timestamp}.json`);

  try {
    fs.writeFileSync(proofPath, JSON.stringify(payload, null, 2), "utf8");

    const cargoCmd = `cargo run -p nova-aggregator --bin nova-aggregator -- --verify "${proofPath}"`;

    try {
      const { stdout } = await execAsync(cargoCmd, {
        cwd: path.resolve(__dirname, "../../../"),
      });
      // Exit code 0 → stdout contains {"verified":true}
      const result = JSON.parse(stdout.trim());
      return { verified: result.verified === true };
    } catch (err: any) {
      // execAsync rejects on non-zero exit code
      // exit code 1 → {"verified":false} on stdout
      if (err.stdout) {
        try {
          const result = JSON.parse(err.stdout.trim());
          if (typeof result.verified === "boolean") {
            return { verified: result.verified };
          }
        } catch {
          // stdout not parseable — fall through to false
        }
      }
      // exit code 2 or any other error
      return { verified: false };
    }
  } finally {
    if (fs.existsSync(proofPath)) fs.unlinkSync(proofPath);
  }
}
```

**Important**: `execAsync` (from `promisify(exec)`) rejects the promise when the child process exits with a non-zero code. The rejection error object carries `stdout` and `stderr` properties. Exit code 1 (verification failed) still produces parseable JSON on stdout, so the catch block attempts to parse `err.stdout` before falling back to `{ verified: false }`.

### 3. `backend/src/routes/nova.ts` — `POST /api/v1/nova/verify` route

Add a new handler to the existing router:

```typescript
import {
  novaAggregatorService,
  VoteWitnessPayload,
  RecursiveProofPayload,
} from "../services/nova-aggregator.js";

/**
 * POST /api/v1/nova/verify
 * Verify a previously generated Nova recursive proof
 */
router.post(
  "/verify",
  bodyLimit("100kb"),
  async (req: Request, res: Response) => {
    try {
      const payload = req.body as RecursiveProofPayload;

      if (
        !payload ||
        !payload.proof_bytes ||
        !payload.initial_state ||
        !payload.final_state
      ) {
        return res.status(400).json({
          error:
            "Invalid payload. proof_bytes, initial_state, and final_state are required.",
        });
      }

      const result = await novaAggregatorService.verifyProof(payload);

      return res.status(200).json({
        success: true,
        verified: result.verified,
      });
    } catch (error: any) {
      console.error("[NovaRoute Verify Error]:", error);
      return res.status(500).json({
        error: error.message || "Internal Nova verification error",
      });
    }
  },
);
```

### 4. `backend/src/routes/index.ts` — export `novaRoutes`

```typescript
export { default as novaRoutes } from "./nova.js";
```

### 5. `backend/src/index.ts` — mount `novaRoutes`

In the import:
```typescript
import {
  // existing exports...
  novaRoutes,
} from "./routes/index.js";
```

In the route mounting section (after `circuitRoutes`):
```typescript
app.use("/api/v1/nova", novaRoutes);
```

The existing `/api/v1/nova/aggregate` handler in `nova.ts` uses a relative path `/aggregate`, so the mount prefix `/api/v1/nova` plus the handler path `/aggregate` gives the full path `POST /api/v1/nova/aggregate`. Same for `/verify`.

---

## Data Models

All data models already exist in `crates/nova-aggregator/src/lib.rs` and are mirrored in `backend/src/services/nova-aggregator.ts`. No new fields are needed.

### Rust types (unchanged)

```rust
pub struct IvcState {
    pub step_count: u64,
    pub root: String,
    pub yes_votes: u64,
    pub no_votes: u64,
    pub acc_nullifier_hash: String,
}

pub struct VoteWitness {
    pub secret: String,
    pub salt: String,
    pub path_elements: Vec<String>,
    pub path_indices: Vec<u8>,
    pub vote_choice: u8,
    pub nullifier: String,
    pub dao_id: u64,
    pub proposal_id: u64,
}

pub struct RecursiveProofPayload {
    pub initial_state: IvcState,
    pub final_state: IvcState,
    pub num_votes: u64,
    pub proof_bytes: String,
    pub timestamp: u64,
}
```

### TypeScript types (unchanged, in `nova-aggregator.ts`)

```typescript
interface IvcState {
  step_count: number;
  root: string;
  yes_votes: number;
  no_votes: number;
  acc_nullifier_hash: string;
}

interface RecursiveProofPayload {
  initial_state: IvcState;
  final_state: IvcState;
  num_votes: number;
  proof_bytes: string;
  timestamp: number;
}
```

### CLI exchange format

The `--verify` command reads a `RecursiveProofPayload` JSON from disk and writes to stdout:

```json
{ "verified": true }
```

or

```json
{ "verified": false }
```

Exit code 2 writes to stderr:
```json
{ "error": "<io or parse error message>" }
```

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

PBT applies to this feature: the Rust aggregation engine contains pure functions (`step`, `aggregate_batch`, `verify_proof`) with rich input spaces (arbitrary secrets, nullifiers, vote choices, batch sizes). The `proptest` crate is used; each property test runs with a minimum of 100 iterations.

### Property Reflection

Before writing the final properties, I review the prework to eliminate redundancy:

- Requirements 2.1 and 2.2 both test nullifier rejection. 2.2 (empty string) is an edge case of 2.1 (any mismatch). A single property that generates any non-matching nullifier (including `""`) covers both. → **Combine into one property**.
- Requirements 5.1, 5.2, 5.3, 5.4 all describe aspects of the tally invariant. 5.1 is about `step_count`, 5.2 about total vote conservation, 5.3/5.4 are edge cases of 5.2 when votes are all-yes or all-no. A single tally invariant property that checks `step_count`, `yes_votes + no_votes`, and the individual counts all at once provides complete coverage. → **Combine into one comprehensive property**.
- Requirements 6.2, 6.3, 6.4 are all tamper detection cases. 6.3 (step_count mismatch) and 6.4 (tally mutation) are both caught by the same mechanism: `verify_proof` recomputes `compress_proof` and compares. A single "tampered proof is rejected" property that mutates any of the detectable fields subsumes all three. → **Combine into one property**.
- Requirements 3.1 and 3.2 are the positive and negative sides of duplicate detection. They are not redundant — one tests rejection, one tests success. Keep as separate properties.
- Requirement 6.1 (round-trip) is distinct from all other properties. Keep.

**Final property list**: 5 distinct properties.

---

### Property 1: Nullifier Validation Rejects Any Non-Matching Nullifier

*For any* `VoteWitness` where the `nullifier` field does not exactly equal `compute_nullifier(secret, dao_id, proposal_id)` (including the empty string), calling `VoteStepCircuit::step` with a test-mode root SHALL return `Err(CircuitError::InvalidNullifier)`.

**Validates: Requirements 2.1, 2.2, 2.3**

---

### Property 2: Duplicate Nullifier in Batch is Rejected

*For any* batch of witnesses with valid distinct nullifiers, introducing a duplicate of any one witness's nullifier at any position in the batch SHALL cause `NovaAggregator::aggregate_batch` to return `Err(CircuitError::NullifierAlreadyAccumulated)`.

**Validates: Requirements 3.1, 3.3**

---

### Property 3: Aggregate/Verify Round-Trip

*For any* non-empty batch of valid vote witnesses (each with correctly derived nullifier, valid `vote_choice ∈ {0,1}`, and a test-mode root), calling `NovaAggregator::aggregate_batch` followed immediately by `NovaAggregator::verify_proof` on the resulting `RecursiveProofPayload` SHALL return `true`.

**Validates: Requirements 6.1**

---

### Property 4: Tally Invariant

*For any* initial `IvcState` and any non-empty batch of valid vote witnesses, after `NovaAggregator::aggregate_batch` completes successfully, the resulting `RecursiveProofPayload` SHALL satisfy all of the following simultaneously:
- `final_state.step_count == initial_state.step_count + num_votes`
- `final_state.yes_votes + final_state.no_votes == initial_state.yes_votes + initial_state.no_votes + num_votes`
- `yes_votes` equals the initial count plus the number of witnesses with `vote_choice == 1`
- `no_votes` equals the initial count plus the number of witnesses with `vote_choice == 0`

**Validates: Requirements 5.1, 5.2, 5.3, 5.4**

---

### Property 5: Tampered Payload is Rejected by verify_proof

*For any* valid `RecursiveProofPayload` produced by `aggregate_batch`, mutating any one of `proof_bytes`, `final_state.yes_votes`, `final_state.no_votes`, or `final_state.step_count` while leaving the rest unchanged SHALL cause `NovaAggregator::verify_proof` to return `false`.

**Validates: Requirements 6.2, 6.3, 6.4**

---

## Error Handling

### Rust (`circuit.rs` / `aggregator.rs`)

| Error | Triggered when | Propagation |
|---|---|---|
| `CircuitError::InvalidVoteChoice` | `vote_choice > 1` | Returned by `step`, propagated by `aggregate_batch` |
| `CircuitError::InvalidNullifier` | Nullifier field ≠ derived nullifier (includes empty string) | Returned by `step`, propagated by `aggregate_batch` |
| `CircuitError::InvalidMerklePath` | `path_elements.len() != path_indices.len()` or path doesn't hash to root | Returned by `step`, propagated by `aggregate_batch` |
| `CircuitError::NullifierAlreadyAccumulated` | Duplicate nullifier detected in batch HashSet | Returned directly by `aggregate_batch` before calling `step` |
| `CircuitError::RootMismatch` | Reserved for future full root verification | Not currently triggered |

### CLI (`bin/main.rs`)

| Exit code | Meaning |
|---|---|
| `0` | Proof verified successfully |
| `1` | Proof failed verification (tampered/invalid) |
| `2` | IO or deserialization error |

### TypeScript service (`nova-aggregator.ts`)

- `aggregateVotes`: If the CLI exits non-zero or the output file doesn't exist, throws an `Error` with the CLI's stderr message. The Express route catches this and returns HTTP 500.
- `verifyProof`: Never throws to the caller. Exit code 1 → `{ verified: false }`. Exit code 2 or unexpected error → `{ verified: false }`. Temp file is always cleaned up in `finally`.

### Express routes (`nova.ts`)

| Scenario | HTTP status |
|---|---|
| Missing `witnesses` / `daoId` / `proposalId` | 400 |
| Missing or malformed proof payload | 400 |
| Aggregation or verification internal error | 500 |
| Success | 200 |

---

## Testing Strategy

### Unit tests — Rust (`cargo test -p nova-aggregator`)

Existing tests in `circuit.rs` and `aggregator.rs` cover the happy path. New unit tests to add:

- `circuit.rs`: test that the fixed nullifier validation rejects a mismatched nullifier and an empty nullifier.
- `aggregator.rs`: test that duplicate nullifier in a 2-element batch returns `NullifierAlreadyAccumulated`.
- `bin/main.rs`: not unit-tested directly (CLI is integration-level); tested via the property tests and the CLI integration tests.

### Property-based tests — Rust (`proptest`)

Add `proptest` to `[dev-dependencies]` in `crates/nova-aggregator/Cargo.toml`. Implement all 5 properties as `proptest!` macro tests inside `#[cfg(test)]` modules.

Each property test must run at least 100 cases. Tag each with a comment:
```
// Feature: nova-aggregation, Property N: <property_text>
```

**Example skeleton for Property 3 (round-trip)**:

```rust
// Feature: nova-aggregation, Property 3: aggregate/verify round-trip
proptest! {
    #[test]
    fn prop_aggregate_verify_roundtrip(
        witnesses in proptest::collection::vec(arb_valid_witness(), 1..=20)
    ) {
        let initial = IvcState::default();
        let payload = NovaAggregator::aggregate_batch(initial, &witnesses)?;
        prop_assert!(NovaAggregator::verify_proof(&payload));
    }
}
```

A helper `arb_valid_witness()` strategy generates `VoteWitness` values with:
- Non-empty `secret` (arbitrary `[a-z]{1,20}` string)
- Non-empty `salt`
- `vote_choice` sampled from `0u8..=1u8`
- Correct `nullifier` computed via `VoteStepCircuit::compute_nullifier`
- Empty `path_elements`/`path_indices` (triggering the test-mode root bypass)
- Unique `dao_id`/`proposal_id` pair (or fixed values; duplicates are handled at batch level)

For Property 2 (duplicate detection), a separate strategy builds a valid unique batch then injects a copy of a randomly-chosen element.

For Property 4 (tally invariant), the strategy tracks how many yes/no witnesses are generated and asserts the expected counts post-aggregation.

For Property 5 (tamper detection), the strategy generates a valid payload and then applies one of four mutations (using `proptest::prop_oneof!`).

### Integration tests — TypeScript (`backend/test/nova.test.js`)

Framework: `node:test` + `supertest` (matching existing test style in the project, e.g. `bridge.test.js`).

**Mock strategy**: `execAsync` is the boundary. Mock it at the module level using `import.meta` rewiring (or a helper that the service exposes for testing). Since the service creates `execAsync` via `promisify(exec)` in module scope, the cleanest approach is to:

1. Extract `execAsync` as a named export or an overridable instance variable on `NovaAggregatorService`:

```typescript
// In NovaAggregatorService constructor:
this._exec = execAsync; // can be swapped in tests
```

2. In tests, instantiate `NovaAggregatorService` with a mocked `exec`.

Alternatively, use `proxyquire` or `esmock` for module-level mocking. Given the existing test pattern (plain `import` with no mock framework), the simplest approach is to expose a `_setExecForTest` method on the service or accept an `exec` parameter in the constructor.

**Test cases** (matching Requirements 10.2–10.4):

```javascript
// backend/test/nova.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

// Mock execAsync before importing the app
// ...

test('POST /api/v1/nova/aggregate returns 200 with proof_bytes for valid payload', async () => {
    const res = await request(app)
        .post('/api/v1/nova/aggregate')
        .send({ daoId: 1, proposalId: 1, witnesses: [witness1, witness2] });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.data.proof_bytes.startsWith('0x'));
});

test('POST /api/v1/nova/aggregate returns 400 when witnesses is missing', async () => {
    const res = await request(app)
        .post('/api/v1/nova/aggregate')
        .send({ daoId: 1, proposalId: 1 });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error);
});

test('verifyProof round-trip: proof from aggregation passes verification', async () => {
    // Use the mocked execAsync to simulate a valid verify response
    const result = await novaAggregatorService.verifyProof(mockValidPayload);
    assert.equal(result.verified, true);
});
```

The `execAsync` mock for the aggregate endpoint returns a mock `RecursiveProofPayload` JSON written to the output path, simulating a successful CLI run. For the verify endpoint mock, it returns exit code 0 with `{"verified":true}` on stdout, and for failure cases it rejects with exit code 1.

### Criterion benchmark (`cargo bench -p nova-aggregator`)

The existing `nova_fold_1k_votes` benchmark in `benches/nova_benchmark.rs` calls `NovaAggregator::aggregate_batch`. After the nullifier bug fix, each benchmark witness must carry a correctly derived nullifier — which the benchmark already does via `VoteStepCircuit::compute_nullifier`. The benchmark will also exercise the new duplicate-detection `HashSet`. Since all benchmark witnesses use distinct secrets, no duplicates will appear and the benchmark will run cleanly.

No changes to the bench file are required. The bench will only start compiling once the crate is registered in the workspace (Requirement 1).
