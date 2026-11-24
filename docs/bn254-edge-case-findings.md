# BN254 Edge-Case Corpus Findings (ZV-117)

**Issue**: #956  
**Status**: GROUNDED  
**Last Updated**: 2024-11-21

## Overview

This document records the results and findings from the BN254 adversarial edge-case corpus that gates every PR touching the Groth16 verifier (`contracts/zkvote-groth16`). The corpus systematically tests boundary conditions, malformed inputs, and known attack vectors to ensure the verifier fails safely and consistently.

## Corpus Structure

The corpus is implemented in `contracts/zkvote-groth16/tests/bn254_edge_case_corpus.rs` and includes:

- **1 control case**: Valid real-world proof that must accept
- **50+ edge cases**: Malformed proofs, boundary values, and attack vectors

### Test Categories

1. **Proof Point Attacks**
   - Identity point injection (G1, G2)
   - Out-of-subgroup G2 points (h-torsion)
   - Field modulus boundary testing
   - Coordinate overflow (all 0xFF bytes)
   - Single-bit flips at critical offsets

2. **Public Signal Attacks**
   - Scalar field modulus boundary (Fr modulus)
   - Modified DAO/proposal/vote parameters
   - Root and nullifier tampering

3. **Verification Key Attacks**
   - VK point identity injection
   - G2 torsion points in pairing parameters
   - IC vector length mismatches
   - Duplicate IC entries
   - Field modulus coordinates

## Key Findings

### ✓ Identity Point Rejection

**Status**: PASS  
The verifier correctly rejects proofs containing identity points (point at infinity) in constant time before entering the pairing operation. This prevents:

- Timing side-channel attacks
- Invalid curve exploitation
- Pairing operation budget exhaustion

**Test Cases**:

- `proof_a_infinity`
- `proof_b_infinity`
- `proof_c_infinity`
- `proof_all_points_infinity`

### ✓ Subgroup Attack Prevention

**Status**: PASS  
G2 torsion points (points on the full curve but not in the prime-order subgroup) are rejected. These could otherwise allow pairing forgeries.

**Test Cases**:

- `proof_b_non_subgroup_g2_torsion`
- `vk_beta_non_subgroup_g2_torsion`
- `vk_gamma_non_subgroup_g2_torsion`
- `vk_delta_non_subgroup_g2_torsion`

The test uses a deterministic G2 torsion point constructed via:

```rust
let torsion = full_curve_point.mul_bigint(Fr::MODULUS).into_affine();
```

### ✓ Field Boundary Validation

**Status**: PASS  
Coordinates at or above the BN254 base field modulus (Fp) are rejected before deserialization.

**Test Cases**:

- `proof_a_coordinate_at_fp_modulus`
- `proof_b_coordinates_at_fp_modulus`
- `proof_c_coordinate_at_fp_modulus`
- `vk_*_coordinates_at_fp_modulus`

### ⚠️ Caller-Guarded Scalar Field Cases

**Status**: OBSERVE  
Public signals at the scalar field modulus (Fr) are **not rejected by the verifier itself** but must be caught by the calling contract's `assert_in_field` guard. The corpus documents these cases so regression tests can verify the guards remain in place.

**Test Cases**:

- `signal_root_at_fr_modulus_observed_caller_guarded`
- `signal_nullifier_at_fr_modulus_observed_caller_guarded`

**Action Required**: The voting contract must call `validate_nullifier` and `assert_in_field` on all public signals before invoking `verify_groth16`. A missing guard would allow out-of-field scalars to produce incorrect pairing results.

### ✓ Proof Malleability Resistance

**Status**: PASS  
Single-bit flips at various offsets (start, middle, end) consistently cause verification failure. No malleability-preserving bit patterns were found.

**Test Coverage**:

- 9 offsets for proof.a (64 bytes)
- 14 offsets for proof.b (128 bytes)
- 9 offsets for proof.c (64 bytes)
- Multiple offsets for VK fields

### ✓ IC Vector Length Enforcement

**Status**: PASS  
The verifier correctly rejects proofs when:

- IC vector is too short (`vk_ic_too_short`)
- IC vector is too long (`vk_ic_too_long`)
- IC[0] is the identity point (`vk_ic0_infinity`)

### ✓ Public Signal Tampering Detection

**Status**: PASS  
Modification of any public signal (root, nullifier, DAO ID, proposal ID, vote choice) causes verification failure, confirming the proof binds to the full public input vector.

## CI Integration

The corpus runs on every PR touching the verifier and is a **required passing job**. CI enforces:

1. **Minimum corpus size**: Control + 50 edge cases
2. **No regressions**: All `Expectation::Reject` cases must not accept
3. **Artifact upload**: Full corpus output is archived for 30 days
4. **Toolchain tuple recording**: Rust version and target are captured

### Failure Handling

- **Acceptance of a rejected case**: CI fails immediately
- **Missing corpus**: Build aborts if test count < 51
- **Stub gate leak**: Separate test ensures `testutils` feature cannot reach a wasm build

## Regression Cases (ZV-117)

### G2 Subgroup Parsing Assumptions

**Risk**: If Soroban's `Bn254G2Affine::from_bytes` ever stops validating subgroup membership, torsion points could bypass pairing checks.

**Mitigation**: The corpus includes a deterministic h-torsion fixture that **must** be rejected. If this test starts accepting, an upstream Soroban change has regressed.

**Test**: `proof_b_non_subgroup_g2_torsion`

## Acceptance Criteria (from #956)

- [x] The full corpus runs on every PR touching the verifier and must pass
- [x] A new unprotected entry point fails the guard check (covered by stub gate test)
- [x] Corpus results and toolchain tuple are archived
- [x] Edge-case findings documentation is generated from results (this file)

## Build Artifact Location

CI uploads corpus output to:

```
Artifacts → bn254-corpus-results → corpus-output.txt
```

Includes:

- Test outcome for each case (Accepted | Rejected | Panicked)
- Observed caller-guarded cases
- Rust toolchain version
- Target triple

## Dependencies

- **ZV-068**: Verifier stub gate enforcement
- **ZV-076**: Proof canonicalization (prevents malleability)
- **Issue #88, #513**: Batch verification (separate from this corpus)

## Future Work

1. **BLS12-381 corpus**: Parallel test suite for `verify_groth16_bls381`
2. **Fuzzing integration**: Property-based testing with `cargo fuzz`
3. **Formal verification**: Machine-checked proofs of field arithmetic bounds
4. **Cross-implementation testing**: Compare rejection behavior against snarkjs/rapidsnark

## References

- Issue: https://github.com/ZK-VOTE/ZK-VOTE/issues/956
- Spike docs: `docs/spikes/698-701-protocol-boundary-findings.md` (#698)
- Test file: `contracts/zkvote-groth16/tests/bn254_edge_case_corpus.rs`
- CI workflow: `.github/workflows/ci.yml`
