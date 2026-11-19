# Rust WASM Witness Generation Spike

The repository already defaults vote/comment proof generation to the Rust -> WASM Groth16 prover in `frontend/src/lib/zkproof.ts`, with dynamic `snarkjs` fallback.

## Compatibility Evidence

- `contracts/zkvote-prover/src/witness_wasm.rs` executes compiled Circom witness-calculator WASM through Rust.
- `contracts/zkvote-prover/src/field.rs` documents snarkjs little-endian Montgomery conversion parity.
- `contracts/zkvote-prover/tests/witness_gen.rs` and `prove_vote.rs` cover witness/proof behavior.
- `frontend/src/lib/zkproof.ts` defaults to Rust and loads `snarkjs` only on fallback.

## Benchmark Table

Local benchmark values depend on circuit artifacts and device class, so this table is intentionally a maintained template for release notes:

| Path | Bundle impact | Latency target | Status |
| --- | ---: | ---: | --- |
| Rust -> WASM prover | avoids eager `snarkjs` import | default path | implemented |
| snarkjs fallback | dynamic import only | fallback path | implemented |

## Verification

Run:

```bash
cargo test -p zkvote-prover --features witness
npm run type-check --prefix frontend
```

Closes #309 when paired with the existing implementation.

## Runtime device-provisioning matrix (ZV-129)

The gate in `frontend/src/lib/devicePreflight.ts` uses the exact Merkle depth
from the election witness (ZV-052), checks the required peak against 85% of
the browser's coarse `navigator.deviceMemory` hint, and chooses a worker on
constrained devices. It will **not downgrade the election depth** or upload
private witness material to an unverified remote prover. Unsupported depths
or insufficient measured budgets fail before proving/download.

**Provenance:** the current peak values (420/600/1200 MiB at depths 18/20/25)
are pre-existing *estimated* figures from issue #728, **not benchmarked
release-build hardware measurements**. The following deterministic CI matrix
is computed from `scripts/proof-memory-fixtures.json`. To satisfy the
remaining release-benchmark criterion, replace those estimates with actual
peak-RSS measurements collected on named devices using a release-built
circuit, recording hardware, browser version, build hash, and measurement date.

<!-- device-matrix:start -->
| Device profile | Browser RAM hint | Budget (85%) | Depth 18 | Depth 20 | Depth 25 |
| --- | ---: | ---: | --- | --- | --- |
| Entry-level 0.5 GB | 0.5 GiB | 435 MiB | worker/snarkjs | blocked | blocked |
| Low-end 1 GB | 1 GiB | 870 MiB | worker/snarkjs | worker/snarkjs | blocked |
| Mid-range 2 GB | 2 GiB | 1740 MiB | worker/snarkjs | worker/snarkjs | worker/snarkjs |
| Desktop 4 GB | 4 GiB | 3481 MiB | worker/snarkjs | worker/snarkjs | worker/snarkjs |
| Desktop 8 GB | 8 GiB | 6963 MiB | main/Rust | main/Rust | main/Rust |
<!-- device-matrix:end -->

Regenerate: `node scripts/generate-proof-device-matrix.mjs`
Verify in CI: `node scripts/generate-proof-device-matrix.mjs --check`.
A missing deviceMemory hint is recorded as *unknown*, not as a measured budget;
the worker remains the safer local path, and an OOM still aborts with guidance.
