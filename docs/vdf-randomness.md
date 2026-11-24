# Verifiable Delay Function (VDF) for Election Randomness

## Overview

The ZK-VOTE system uses a Verifiable Delay Function (VDF) to provide verifiable,
unpredictable randomness for deterministic candidate ordering in elections. The
VDF ensures that:

1. **Unpredictability**: The output cannot be predicted before the computation completes
2. **Verifiability**: Anyone can verify the correctness of the output
3. **Sequentiality**: Computation requires sequential work (cannot be parallelized)

## VDF Construction

### Iterated SHA256

The VDF is defined as:

```
y = SHA256^T(x)
```

Where:
- `x` is the input seed (32 bytes, derived from election parameters)
- `T` is the delay parameter (number of SHA256 iterations)
- `y` is the VDF output (32 bytes)

SHA256 is an inherently sequential hash function — each iteration depends on the
previous output. There is no known shortcut to compute SHA256^T faster than T
sequential evaluations.

### Why Iterated SHA256 vs. Other VDFs

| Construction | Pros | Cons |
|---|---|---|
| **Wesolowski VDF** | Compact proofs (~128 bytes), O(log T) verification | Requires RSA group (2048+ bit modular arithmetic), not feasible in Soroban WASM |
| **Pietrzak VDF** | Simple verification | Requires group of unknown order, complex implementation |
| **Iterated SHA256 (this project)** | Uses existing Soroban SHA256 host function, simple implementation, widely audited | O(T/k) verification with k checkpoints, larger proofs |

The iterated SHA256 construction was chosen because:
- Soroban provides a native SHA256 host function
- No additional cryptographic primitives needed
- Simple to implement and audit
- The existing Groth16 verification infrastructure can be leveraged for future
  VDF proof verification

## Integration with Election System

### VDF Input Derivation

The VDF input is derived from election-specific parameters to prevent
precomputation:

```
vdf_input = SHA256(dao_id || proposal_id || block_hash || admin_seed)
```

Where:
- `dao_id` (8 bytes, big-endian): DAO identifier
- `proposal_id` (8 bytes, big-endian): Proposal identifier
- `block_hash` (32 bytes): Ledger hash at election creation time
- `admin_seed` (32 bytes): Additional entropy provided by the DAO admin

### VDF Delay Parameter

The delay parameter `T` determines the minimum time before the VDF output
can be revealed. It is set by the DAO admin at election configuration time.

**Guidelines for T selection:**

| T (iterations) | Approximate Compute Time | Use Case |
|---|---|---|
| 1,000 | ~0.1 ms | Minimal delay, basic unpredictability |
| 100,000 | ~10 ms | Standard elections |
| 1,000,000 | ~100 ms | High-security elections |
| 10,000,000 | ~1 s | Maximum security |

> **Note**: These times are measured on modern server hardware. On slower
> devices (e.g., mobile), computation may take 10-100x longer.

### On-Chain Verification

The VDF output is verified on-chain using **checkpoint-based verification**:

1. The VDF chain is divided into `N` equal segments
2. A checkpoint hash is computed at each segment boundary
3. The contract verifies each segment by recomputing `T/N` SHA256 iterations
4. The total on-chain work is bounded by `T` iterations

With `N` checkpoints, each segment requires `T/N` SHA256 calls, for a total
of `N * (T/N) = T` on-chain hashes. For large `T`, this is expensive.

**Optimization**: The number of checkpoints can be tuned to balance on-chain
cost against proof size. The default configuration uses `MIN_VDF_CHECKPOINTS = 3`
and `MAX_VDF_CHECKPOINTS = 100`.

### VDF Lifecycle

1. **Election Creation**: DAO admin creates a proposal
2. **VDF Configuration**: DAO admin calls `set_vdf_delay()` to set T
   - The VDF input is derived and stored on-chain
3. **VDF Computation**: Anyone (typically the backend relayer) computes the VDF
   - `y = SHA256^T(vdf_input)`
   - Checkpoints are generated for on-chain verification
4. **VDF Submission**: After the delay period, submit VDF output via `submit_vdf_output()`
   - The contract verifies the proof on-chain
   - If valid, the VDF output is stored and marked as finalized
5. **Candidate Ordering**: `candidate_order_key()` uses the VDF output as the
   randomness seed for deterministic candidate ordering

### Security Properties

1. **Unpredictability**: The VDF output depends on the election creation block hash,
   which is unknown before the election is created. The sequential computation of
   T SHA256 iterations ensures the output cannot be predicted before T iterations
   complete.

2. **Non-repudiation**: Anyone can recompute the VDF and verify the output
   independently. The checkpoint proof allows on-chain verification.

3. **Front-running resistance**: The VDF input includes the admin_seed, which adds
   additional entropy that only the admin knows before election creation.

4. **Bias resistance**: The VDF output is deterministic given the inputs. No party
   can influence the output after the input is committed.

## Smart Contract Interface

### Functions

```rust
// Set VDF delay parameter
fn set_vdf_delay(env, dao_id, proposal_id, delay, admin)

// Submit VDF output with proof
fn submit_vdf_output(env, dao_id, proposal_id, vdf_output, checkpoints, proposal_creation_time)

// Get VDF output (None if not submitted)
fn get_vdf_output(env, dao_id, proposal_id) -> Option<BytesN<32>>

// Get VDF delay parameter
fn get_vdf_delay(env, dao_id, proposal_id) -> u64

// Get VDF input seed
fn get_vdf_input(env, dao_id, proposal_id) -> Option<BytesN<32>>

// Check if VDF is finalized
fn is_vdf_finalized(env, dao_id, proposal_id) -> bool

// Finalize candidate seed using VDF output
fn finalize_with_vdf(env, dao_id, proposal_id) -> BytesN<32>

// Get candidate ordering key (uses VDF output if available)
fn candidate_order_key(env, dao_id, proposal_id, candidate) -> BytesN<32>
```

### Events

```rust
VdfSubmittedEvent { dao_id, proposal_id, output, delay }
VdfVerifiedEvent { dao_id, proposal_id, verified }
```

## Backend Service

The backend relayer provides a VDF computation service (`src/services/vdf.ts`)
that:

- Computes the VDF for a given input and delay parameter
- Generates checkpoint proofs for on-chain verification
- Verifies VDF outputs
- Benchmarks computation time

### API

```typescript
// Compute VDF
computeVdf(inputHex: string, iterations: number): {
  output: string;       // 64 hex chars
  checkpoints: string[]; // array of 64-hex-char strings
  duration: number;     // computation time in ms
}

// Verify VDF output
verifyVdf(inputHex: string, iterations: number, outputHex: string, checkpoints: string[]): boolean

// Derive VDF input from election parameters
deriveVdfInput(daoId: number, proposalId: number, blockHashHex: string, adminSeedHex: string): string

// Benchmark VDF computation
benchmarkVdf(iterationsArray: number[]): BenchmarkResult[]

// Estimate VDF computation time
estimateVdfTime(iterations: number): number
```

## VDF Crate (Rust)

The `contracts/vdf` crate provides Rust implementation of the VDF:

```rust
// Compute VDF: y = SHA256^T(x)
fn compute_vdf(env, x: &BytesN<32>, t: u64) -> BytesN<32>

// Verify VDF with checkpoints
fn verify_vdf(env, x: &BytesN<32>, t: u64, y: &BytesN<32>, checkpoints: &Vec<BytesN<32>>) -> bool

// Generate challenge positions for probabilistic verification
fn generate_challenges(env, x: &BytesN<32>, y: &BytesN<32>, t: u64, num_challenges: u32) -> Vec<u64>

// Create checkpoint hashes
fn create_checkpoints(env, x: &BytesN<32>, t: u64, num_checkpoints: u32) -> Vec<BytesN<32>>

// Derive VDF input from election parameters
fn derive_vdf_input(env, dao_id: u64, proposal_id: u64, creation_block_hash: &BytesN<32>, admin_seed: &BytesN<32>) -> BytesN<32>
```

## Benchmarks

To benchmark VDF computation time on your hardware:

```bash
# Rust benchmarks
cd contracts/vdf && cargo test

# Backend benchmarks
cd backend && npx tsx -e "
import { benchmarkVdf } from './src/services/vdf.js';
const results = benchmarkVdf([1000, 10000, 100000, 1000000]);
console.table(results);
"
```

## Future Improvements

1. **Groth16-based VDF proof**: Create a Circom circuit that proves correct VDF
   computation. This would reduce on-chain verification to O(1) via the existing
   Groth16 verifier.

2. **Wesolowski VDF**: Implement Wesolowski VDF with RSA group, using
   `num-bigint` for modular arithmetic. This would provide constant-size proofs
   (2 group elements) and O(log T) verification.

3. **VDF service API**: Expose VDF computation as a REST API endpoint for
   external consumers.

4. **VDF circuit ceremonies**: If Groth16-based VDF proof is adopted, conduct
   a trusted setup ceremony for the VDF circuit.

## Durability, trust assumptions and migration path

The backend ordering state is now stored in SQLite (`randomness_orderings`,
`randomness_shares`, `randomness_commits`) rather than a process-local `Map`.
`GET /randomness/ordering/:daoId` and `GET /randomness/verify/:daoId` read only
from that store, so a finalized ordering is byte-identical after a restart and
across replicas. Finalization is a single synchronous DB transaction using the
`committed` flag; a late threshold share is rejected with 409 and can never
mutate an existing commit. Verification independently re-derives the combined
seed from the persisted VDF output and shares, re-checks the replay nonce and
validates the immutable commit record.

### What the current construction does and does not prove

- **It proves sequential work to an off-chain verifier.** Output is
  `SHA256^T(input)` and verification recomputes the chain against persisted
  checkpoints. Checkpoints bound memory, not work: verification still costs
  `T` hashes.
- **It is not a proof of sequential work (PoSW).** Anyone who runs the same
  hashes gets the same result; there is no compact proof that the work took a
  minimum wall-clock time. SHA-256 is sequential within one chain but an
  attacker with faster hardware can finish earlier. The delay-security table
  assumes a 10x sequential speedup; that assumption is the security margin.
- **The admin controls `admin_seed`.** The seed is optional in
  `POST /randomness/seed` and, when omitted, generated by the relay. A
  malicious admin who supplies it learns the VDF input before anyone else and
  can precompute the output. Threshold shares mitigate the *final* seed, but
  the VDF delay guarantee against that admin is weaker than the original
  design text implies. Production deployments should require the seed to come
  from an election block hash, not an admin-supplied value.
- **XOR shares are a count threshold, not a cryptographic threshold.** The last
  share submitted can compute the combined contribution before anyone else.
  Treat `requiredShares` as a liveness gate; use the on-chain commit–reveal
  `candidate_seed` path in `contracts/voting` when bias resistance matters.
- **On-chain VDF verification is weaker than off-chain.** Soroban's CPU budget
  only permits spot-checking a handful of segments. The ledger timestamp, not
  the VDF, enforces the minimum delay on-chain. `contracts/vdf` is a helper
  library; the state and verifier live in `contracts/voting`.

### Migration path to a real VDF with an on-chain verifier

1. Keep the persisted ordering schema and endpoints as the stable API; the
   backend becomes the *prover* and the contract the *verifier*.
2. Replace `SHA256^T` with a Wesolowski VDF over a class group or RSA group,
   emitting a constant-size proof `(pi, y)`. Store the proof alongside the
   checkpoints in `randomness_commits.payload` (additive, versioned field).
3. Add a Soroban verifier that checks the Wesolowski proof in O(log T)
   instructions; expose it through `contracts/voting::submit_vdf_output` so the
   output is pinned on-chain before finalization.
4. Require `blockHashHex` to be sourced from a finalized ledger (not an admin
   string) and record the contributing authority set + share hashes, which the
   backend already emits as `authoritySet` / `shareHashes`.
5. Flip verification to `proofValid && onChainOutputMatches` and keep the
   iterated-SHA256 check as a legacy path for existing persisted orderings.
   This is a data migration, not a beacon-randomness redesign (#498 is out of
   scope).

## References

- [Verifiable Delay Functions (Boneh, Bonneau, Bünz, Fisch, 2018)](https://eprint.iacr.org/2018/601)
- [Wesolowski VDF (2019)](https://eprint.iacr.org/2018/623)
- [Pietrzak VDF (2019)](https://eprint.iacr.org/2018/627)
- [Chia VDF Implementation](https://github.com/Chia-Network/vdf)
- [Ethereum Research: VDFs](https://ethresear.ch/t/verifiable-delay-functions-vdfs/372)
