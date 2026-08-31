# BN254 Groth16 Verification — Gap Analysis Report

## Executive Summary

This report maps the formal model (`BN254_Groth16.lean`, `Proofs.lean`) to the Rust on-chain verifier (`contracts/zkvote-groth16/src/lib.rs`) and identifies gaps in cryptographic soundness, missing checks, and trust boundaries.

**Status:** The formal model covers the core verification equation, field membership checks, and structural validation. The Rust implementation follows the model closely but has several gaps where checks are either missing, partially enforced, or delegated to trust boundaries.

---

## 1. Verification Equation Mapping

### Formal Model (Lean)
```lean
e(-A, B) · e(α, β) · e(vk_x, γ) · e(C, δ) = 1
```

### Rust Implementation (`verify_groth16_impl`)
```rust
let neg_a = C::g1_neg(&C::g1_from_bytes(env, &Bytes::from(&proof.a)));
let mut g1_vec = [neg_a, alpha, vk_x, proof.c];
let mut g2_vec = [proof.b, beta, gamma, delta];
C::pairing_check(env, g1_vec, g2_vec)
```

### ✅ Match
The Rust implementation correctly implements the 4-pairing product equation. The pairing check delegates to `env.crypto().bn254().pairing_check()` which performs the actual computation.

---

## 2. Assert_in_field Check

### Formal Model
```lean
def assert_in_field (env_fr : ℕ) (value : ℕ) : Prop := value < env_fr
```

### Rust Implementation
```rust
pub fn assert_in_field(env: &Env, value: &U256) -> Result<(), Groth16Error> {
    let modulus = U256::from_be_bytes(env, &Bytes::from_array(env, &BN254_FR_MODULUS));
    if value >= &modulus {
        return Err(Groth16Error::SignalNotInField);
    }
    Ok(())
}
```

### ✅ Match
The Rust implementation correctly checks `value < Fr`. The formal model proves this is exact (sound + complete).

### ⚠️ Gap: BN254_FR_MODULUS vs BN254_MODULUS
The Rust code uses two different moduli:
- `BN254_FR_MODULUS` (scalar field Fr) for signal validation
- `BN254_MODULUS` (base field Fq) in `config.ts`

The formal model confirms `Fr < Fq`, so using the wrong modulus could reject valid values or accept invalid ones. The Rust code correctly uses `BN254_FR_MODULUS` for field checks.

---

## 3. Point-at-Infinity Checks

### Formal Model
```lean
def g1_is_infinity (P : G1Point) : Prop := P.x = 0 ∧ P.y = 0
def valid_proof_elements (proof : Proof) : Prop :=
  ¬(g1_is_infinity proof.a) ∧ ¬(g2_is_infinity proof.b) ∧ ¬(g1_is_infinity proof.c)
```

### Rust Implementation
The point-at-infinity check is performed **only in the Zod validation schemas** (`validation/schemas.ts`):
```typescript
const proofA = hexString(128).refine(
  (val) => !/^0*$/.test(hex.padStart(128, "0")),
  { message: "proof.a cannot be all zeros (point at infinity)" },
);
```

### ⚠️ Gap: Missing On-Chain Check
**The Rust contract code (`lib.rs`) does NOT check for point-at-infinity.** The check is only in the TypeScript validation layer. This means:
1. If a request bypasses the relayer (direct contract call), the check is not enforced
2. The contract trusts the relayer to perform this validation
3. A proof with A=O would still be verified by the pairing equation

**Severity:** MEDIUM — The pairing equation itself rejects trivial proofs (e(-O, B) = e(O, B)^(-1) = 1, so the equation would need the other pairings to cancel, which is unlikely with random VK). However, adding the check on-chain would be defense-in-depth.

**Recommendation:** Add point-at-infinity checks in the Rust contract for all proof elements (A, B, C) and VK elements (α, β, γ, δ).

---

## 4. Subgroup Membership Checks

### Formal Model
```lean
def in_g1_subgroup (P : G1Point) : Prop := P.on_curve
def in_g2_subgroup (Q : G2Point) : Prop := Q.x1 = 0 ∧ Q.x0 = 0 ∧ Q.y1 = 0 ∧ Q.y0 = 0 → False
```

### Rust Implementation
Subgroup membership is **delegated to the Soroban host function**:
```rust
fn g1_from_bytes(env: &Env, bytes: &Bytes) -> Self::G1 {
    let fixed: BytesN<64> = bytes.clone().try_into().expect("Bn254 G1: wrong length");
    Bn254G1Affine::from_bytes(fixed)  // Host validates curve membership
}
```

### ⚠️ Gap: Trust Boundary
The Soroban host's `from_bytes()` is trusted to:
1. Validate that the point is on the curve
2. Validate that the point is in the correct subgroup
3. Reject invalid encodings

This is a reasonable trust boundary (the host is part of the Stellar validator), but the formal model cannot verify this. The Lean model uses axioms for these properties.

**Severity:** LOW — The host is a well-audited component, but a formal proof of the host's behavior would require modeling the entire Stellar runtime.

---

## 5. Compute_vk_x Correctness

### Formal Model
```lean
def compute_vk_x (vk : VerificationKey) (pub_signals : List ℕ) : G1Point :=
  List.foldl (fun acc (pair : ℕ × ℕ) =>
    let signal := pair.2
    ⟨(acc.x + signal * ic_point.x) % Fq, ...⟩
  ) ic0 (pub_signals.enumFrom 0)
```

### Rust Implementation
```rust
fn compute_vk_x<C: Groth16Curve>(env: &Env, vk: &VerificationKey, pub_signals: &Vec<U256>) -> C::G1 {
    let ic0 = vk.ic.get(0).expect("IC[0] missing");
    let mut vk_x = C::g1_from_bytes(env, &Bytes::from(&ic0));
    for i in 0..pub_signals.len() {
        let signal = pub_signals.get(i).expect("signal missing");
        let ic_point = C::g1_from_bytes(env, &Bytes::from(&vk.ic.get(i + 1).expect("IC point missing")));
        let scalar = C::fr_from_u256(&signal);
        let scaled_point = C::g1_mul(env, &ic_point, &scalar);
        vk_x = C::g1_add(env, &vk_x, &scaled_point);
    }
    vk_x
}
```

### ✅ Match
The Rust implementation correctly computes the linear combination. The formal model proves the structure is correct.

### ⚠️ Gap: Signal-to-Scalar Conversion
The Rust code converts signals via `C::fr_from_u256(&signal)` which performs modular reduction. The formal model assumes signals are already in [0, Fr). The `assert_in_field` check should be called before `compute_vk_x`, but this is not explicitly enforced in the Rust code.

**Severity:** LOW — The pairing equation would reject invalid proofs anyway, but explicit field checks before scalar multiplication would be cleaner.

---

## 6. IC Length Check

### Formal Model
```lean
pub_signals.length + 1 = vk.ic.length
```

### Rust Implementation
```rust
if pub_signals.len() + 1 != vk.ic.len() {
    return false;
}
```

### ✅ Match
Both the formal model and Rust implementation perform this check identically.

---

## 7. Nullifier Validation

### Formal Model
```lean
def validate_nullifier (value : ℕ) : Prop := value ≠ 0 ∧ value < Fr
```

### Rust Implementation
```rust
pub fn validate_nullifier(env: &Env, nullifier: &U256) -> Result<(), Groth16Error> {
    if nullifier == &U256::from_u32(env, 0) {
        return Err(Groth16Error::InvalidNullifier);
    }
    assert_in_field(env, nullifier)
}
```

### ✅ Match
The Rust implementation correctly checks non-zero and in-field. The formal model proves both properties are necessary.

---

## 8. VK Validation

### Formal Model
```lean
def valid_vk_elements (vk : VerificationKey) : Prop :=
  ¬(g1_is_infinity vk.alpha) ∧
  ¬(g2_is_infinity vk.beta) ∧
  ¬(g2_is_infinity vk.gamma) ∧
  ¬(g2_is_infinity vk.delta)
```

### Rust Implementation
**No explicit VK element validation in `lib.rs`.** The VK is stored on-chain and set by the admin. The contract assumes the VK is valid.

### ⚠️ Gap: Missing VK Validation
The Rust code does not validate that VK elements are not points at infinity or that they are on the curve. A malicious or malformed VK could potentially be set.

**Severity:** MEDIUM — The admin controls the VK, so this is a trust issue rather than a vulnerability. However, adding VK validation would prevent accidental misconfiguration.

**Recommendation:** Add validation of VK elements when `set_vk` is called.

---

## 9. Test-Mode Bypass

### Formal Model
Not modeled (the formal model only covers the production verification path).

### Rust Implementation
```rust
#[cfg(any(test, feature = "testutils"))]
{
    let _ = (env, vk, proof, pub_signals);
    true  // Always returns true in test mode
}
```

### ⚠️ Gap: No Formal Coverage
The test-mode bypass is not modeled in Lean. This means:
1. No formal proof that test mode is correctly scoped
2. Test coverage of the actual verification path is limited to integration tests

**Severity:** LOW — Test mode is clearly guarded by `#[cfg]` attributes, but the formal model should document this as a known limitation.

---

## 10. BN254 vs BLS12-381 Implementation

### Formal Model
Only BN254 is modeled. The BLS12-381 implementation uses the same verification equation with different curve parameters.

### Rust Implementation
The Rust code implements both BN254 and BLS12-381 via the `Groth16Curve` trait. The BLS12-381 verification uses:
- Different G1/G2 point sizes (96/192 bytes)
- Different field moduli
- The same pairing equation structure

### ⚠️ Gap: BLS12-381 Not Formally Modeled
The BLS12-381 verification path is not covered by the formal model. The same structural checks apply, but the curve-specific parameters differ.

---

## Summary of Gaps

| # | Gap | Severity | Status | Recommendation |
|---|-----|----------|--------|----------------|
| 1 | Point-at-infinity not checked on-chain for proof elements | MEDIUM | Open | Add checks in lib.rs |
| 2 | Subgroup membership delegated to host | LOW | Accepted | Document trust boundary |
| 3 | VK elements not validated on-chain | MEDIUM | Open | Add validation in set_vk |
| 4 | Signal field check not enforced before compute_vk_x | LOW | Open | Add explicit check |
| 5 | Test-mode bypass not formally modeled | LOW | Accepted | Document in formal model |
| 6 | BLS12-381 not formally modeled | LOW | Open | Create BLS12-381 model |
| 7 | Pairing is axiomatized, not proved | LOW | Accepted | Trust host implementation |
| 8 | BN254 Fr primality not formally proved | LOW | Open | Numerical verification |

---

## Trust Boundaries

1. **Soroban Host Functions** — The pairing computation, point deserialization, and curve operations are trusted. A formal proof would require modeling the entire Stellar runtime.

2. **VK Admin** — The VK is set by the contract admin. A malicious admin could set a forged VK. This is by design (admin trust model).

3. **Relayer** — The relayer performs TypeScript-level validation (Zod schemas) that is not enforced on-chain. A direct contract call could bypass these checks.

---

## Formal Model Completeness

| Check | Formal Model | Rust On-Chain | TypeScript | Status |
|-------|-------------|---------------|------------|--------|
| IC length | ✅ Proved | ✅ Enforced | N/A | Complete |
| Field membership | ✅ Proved | ✅ Enforced | N/A | Complete |
| Point-at-infinity (proof) | ✅ Proved | ❌ Not enforced | ✅ Enforced | Gap #1 |
| Point-at-infinity (VK) | ✅ Proved | ❌ Not enforced | N/A | Gap #3 |
| Subgroup membership | ⚠️ Axiomatized | ⚠️ Host trust | N/A | Gap #2 |
| Pairing equation | ✅ Modeled | ✅ Implemented | N/A | Complete |
| Non-zero nullifier | ✅ Proved | ✅ Enforced | N/A | Complete |
| Signal ordering | ✅ Modeled | ✅ Implemented | N/A | Complete |

---

## Recommendations

1. **Immediate:** Add point-at-infinity checks for proof elements (A, B, C) in the Rust contract code. This is a defense-in-depth measure.

2. **Short-term:** Add VK element validation in the `set_vk` function. Check that alpha, beta, gamma, delta are not points at infinity.

3. **Medium-term:** Create a formal model for BLS12-381 verification to ensure parity.

4. **Long-term:** Consider using a verified pairing library (e.g., Bellman's arithmetic circuits) to reduce the trust boundary on the host functions.
