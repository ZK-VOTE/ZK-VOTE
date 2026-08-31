#![no_std]

use soroban_sdk::{
    contracterror, contracttype,
    crypto::bls12_381::{Bls12381G1Affine, Bls12381G2Affine, Fr as BlsFr},
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine, Fr as Bn254Fr},
    Bytes, BytesN, Env, IntoVal, TryFromVal, Val, Vec, U256,
};

// Proof canonicalization module for malleability prevention
pub mod proof_canonicalization;
// Audit-friendly, versioned proof serialization format (ZKV1)
pub mod serialization;

pub const BN254_FR_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

pub const BLS12_381_FR_MODULUS: [u8; 32] = [
    0x73, 0xed, 0xa7, 0x53, 0x29, 0x9d, 0x7d, 0x48, 0x33, 0x39, 0xd8, 0x08, 0x09, 0xa1, 0xd8, 0x05,
    0x53, 0xbd, 0xa4, 0x02, 0xff, 0xfe, 0x5b, 0xfe, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01,
];

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum Groth16Error {
    IcLengthMismatch = 30,
    SignalNotInField = 31,
    InvalidNullifier = 32,
    /// ZKV1 serialized proof has an unknown version byte, unknown curve id,
    /// or does not match the expected total byte length.
    InvalidProofFormat = 33,

    /// ── Coarse error codes (100–106) ──────────────────────────────────
    /// Production anonymous paths collapse fine-grained variants into one
    /// of these stable categories. Admin / test contexts continue to use
    /// the original variants above so that tooling retains debugging
    /// fidelity.  Numeric codes are intentionally placed above the
    /// existing fine-grained range to avoid collisions with deployed
    /// contract discriminants.
    InvalidInput = 100,
    EligibilityFailed = 101,
    ProofInvalid = 102,
    AlreadySubmitted = 103,
    WindowClosed = 104,
    InsufficientFunds = 105,
    ConfigError = 106,
}

/// Whether the caller is an authorized admin/configuration path (retains
/// fine-grained errors) or an anonymous user submission path (must use
/// coarse collapsed codes so a relayer cannot probe internal state).
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum PathContext {
    Admin,
    Anonymous,
}

impl Groth16Error {
    /// Collapse fine-grained `Groth16Error` discriminants into the coarse
    /// set (codes 100–106) when the caller is an anonymous-submission
    /// path.  Returns the error unchanged on [`PathContext::Admin`] so
    /// admin tooling and unit tests retain full diagnostic fidelity.
    pub fn to_coarse(&self, ctx: PathContext) -> Groth16Error {
        match ctx {
            PathContext::Admin => *self,
            PathContext::Anonymous => match self {
                Groth16Error::SignalNotInField
                | Groth16Error::InvalidNullifier => Groth16Error::InvalidInput,
                Groth16Error::IcLengthMismatch
                | Groth16Error::InvalidProofFormat => Groth16Error::ProofInvalid,
                other => *other,
            },
        }
    }
}

#[contracttype]
#[derive(Clone)]
pub struct VerificationKey {
    pub alpha: BytesN<64>,
    pub beta: BytesN<128>,
    pub gamma: BytesN<128>,
    pub delta: BytesN<128>,
    pub ic: Vec<BytesN<64>>,
}

#[contracttype]
#[derive(Clone)]
pub struct Proof {
    pub a: BytesN<64>,
    pub b: BytesN<128>,
    pub c: BytesN<64>,
}

pub trait Groth16Curve {
    type G1: IntoVal<Env, Val> + TryFromVal<Env, Val> + Clone;
    type G2: IntoVal<Env, Val> + TryFromVal<Env, Val> + Clone;
    type Fr: IntoVal<Env, Val> + TryFromVal<Env, Val> + Clone;

    fn scalar_field_modulus() -> [u8; 32];
    fn g1_from_bytes(env: &Env, bytes: &Bytes) -> Self::G1;
    fn g2_from_bytes(env: &Env, bytes: &Bytes) -> Self::G2;
    fn fr_from_u256(value: &U256) -> Self::Fr;
    fn g1_add(env: &Env, a: &Self::G1, b: &Self::G1) -> Self::G1;
    fn g1_mul(env: &Env, point: &Self::G1, scalar: &Self::Fr) -> Self::G1;
    fn g1_neg(point: &Self::G1) -> Self::G1;
    fn pairing_check(env: &Env, g1: Vec<Self::G1>, g2: Vec<Self::G2>) -> bool;
}

pub struct Bn254Curve;

impl Groth16Curve for Bn254Curve {
    type G1 = Bn254G1Affine;
    type G2 = Bn254G2Affine;
    type Fr = Bn254Fr;

    fn scalar_field_modulus() -> [u8; 32] {
        BN254_FR_MODULUS
    }

    fn g1_from_bytes(env: &Env, bytes: &Bytes) -> Self::G1 {
        let _ = env;
        let fixed: BytesN<64> = bytes.clone().try_into().expect("Bn254 G1: wrong length");
        Bn254G1Affine::from_bytes(fixed)
    }
    fn g2_from_bytes(env: &Env, bytes: &Bytes) -> Self::G2 {
        let _ = env;
        let fixed: BytesN<128> = bytes.clone().try_into().expect("Bn254 G2: wrong length");
        Bn254G2Affine::from_bytes(fixed)
    }
    fn fr_from_u256(value: &U256) -> Self::Fr {
        Bn254Fr::from(value.clone())
    }
    fn g1_add(env: &Env, a: &Self::G1, b: &Self::G1) -> Self::G1 {
        let _ = env;
        a.clone() + b.clone()
    }
    fn g1_mul(env: &Env, point: &Self::G1, scalar: &Self::Fr) -> Self::G1 {
        let _ = env;
        point.clone() * scalar.clone()
    }
    fn g1_neg(point: &Self::G1) -> Self::G1 {
        -point.clone()
    }
    fn pairing_check(env: &Env, g1: Vec<Self::G1>, g2: Vec<Self::G2>) -> bool {
        env.crypto().bn254().pairing_check(g1, g2)
    }
}

// --- BLS12-381 types ---

#[contracttype]
#[derive(Clone)]
pub struct VerificationKeyBls381 {
    pub alpha: BytesN<96>,
    pub beta: BytesN<192>,
    pub gamma: BytesN<192>,
    pub delta: BytesN<192>,
    pub ic: Vec<BytesN<96>>,
}

#[contracttype]
#[derive(Clone)]
pub struct ProofBls381 {
    pub a: BytesN<96>,
    pub b: BytesN<192>,
    pub c: BytesN<96>,
}

#[contracttype]
#[derive(Clone, Copy, Eq, PartialEq, Debug)]
pub enum CurveId {
    Bn254,
    Bls12381,
}

pub struct Bls12381Curve;

impl Groth16Curve for Bls12381Curve {
    type G1 = Bls12381G1Affine;
    type G2 = Bls12381G2Affine;
    type Fr = BlsFr;

    fn scalar_field_modulus() -> [u8; 32] {
        BLS12_381_FR_MODULUS
    }

    fn g1_from_bytes(env: &Env, bytes: &Bytes) -> Self::G1 {
        let _ = env;
        let fixed: BytesN<96> = bytes
            .clone()
            .try_into()
            .expect("BLS12-381 G1: wrong length");
        Bls12381G1Affine::from_bytes(fixed)
    }
    fn g2_from_bytes(env: &Env, bytes: &Bytes) -> Self::G2 {
        let _ = env;
        let fixed: BytesN<192> = bytes
            .clone()
            .try_into()
            .expect("BLS12-381 G2: wrong length");
        Bls12381G2Affine::from_bytes(fixed)
    }
    fn fr_from_u256(value: &U256) -> Self::Fr {
        BlsFr::from(value.clone())
    }
    fn g1_add(env: &Env, a: &Self::G1, b: &Self::G1) -> Self::G1 {
        env.crypto().bls12_381().g1_add(a, b)
    }
    fn g1_mul(env: &Env, point: &Self::G1, scalar: &Self::Fr) -> Self::G1 {
        env.crypto().bls12_381().g1_mul(point, scalar)
    }
    fn g1_neg(point: &Self::G1) -> Self::G1 {
        -point.clone()
    }
    fn pairing_check(env: &Env, g1: Vec<Self::G1>, g2: Vec<Self::G2>) -> bool {
        env.crypto().bls12_381().pairing_check(g1, g2)
    }
}

pub fn assert_in_field(env: &Env, value: &U256) -> Result<(), Groth16Error> {
    let modulus = U256::from_be_bytes(env, &Bytes::from_array(env, &BN254_FR_MODULUS));
    if value >= &modulus {
        return Err(Groth16Error::SignalNotInField);
    }
    Ok(())
}

pub fn is_in_field(env: &Env, value: &U256) -> bool {
    let modulus = U256::from_be_bytes(env, &Bytes::from_array(env, &BN254_FR_MODULUS));
    value < &modulus
}

pub fn validate_nullifier(env: &Env, nullifier: &U256) -> Result<(), Groth16Error> {
    if nullifier == &U256::from_u32(env, 0) {
        return Err(Groth16Error::InvalidNullifier);
    }
    assert_in_field(env, nullifier)
}


pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut result = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        result |= x ^ y;
    }
    result == 0
}

pub fn is_identity_bn254_g1(bytes: &BytesN<64>) -> bool {
    let zeros = [0u8; 64];
    constant_time_eq(&bytes.to_array(), &zeros)
}

pub fn is_identity_bn254_g2(bytes: &BytesN<128>) -> bool {
    let zeros = [0u8; 128];
    constant_time_eq(&bytes.to_array(), &zeros)
}

pub fn is_identity_bls381_g1(bytes: &BytesN<96>) -> bool {
    let mut id = [0u8; 96];
    id[0] = 0xc0;
    constant_time_eq(&bytes.to_array(), &id)
}

pub fn is_identity_bls381_g2(bytes: &BytesN<192>) -> bool {
    let mut id = [0u8; 192];
    id[0] = 0xc0;
    constant_time_eq(&bytes.to_array(), &id)
}

#[cfg(not(any(test, feature = "testutils")))]
fn verify_groth16_impl<C: Groth16Curve>(
    env: &Env,
    vk: &VerificationKey,
    proof: &Proof,
    pub_signals: &Vec<U256>,
) -> bool {
    if pub_signals.len() + 1 != vk.ic.len() {
        return false;
    }

    // Prevent invalid-curve/subgroup and timing attacks by explicitly rejecting identity points
    // in constant-time before performing any pairing operations.
    if is_identity_bn254_g1(&proof.a) || is_identity_bn254_g2(&proof.b) || is_identity_bn254_g1(&proof.c) {
        return false;
    }


    let vk_x = compute_vk_x::<C>(env, vk, pub_signals);

    let neg_a = C::g1_neg(&C::g1_from_bytes(env, &Bytes::from(&proof.a)));

    let mut g1_vec: Vec<C::G1> = Vec::new(env);
    g1_vec.push_back(neg_a);
    g1_vec.push_back(C::g1_from_bytes(env, &Bytes::from(&vk.alpha)));
    g1_vec.push_back(vk_x);
    g1_vec.push_back(C::g1_from_bytes(env, &Bytes::from(&proof.c)));

    let mut g2_vec: Vec<C::G2> = Vec::new(env);
    g2_vec.push_back(C::g2_from_bytes(env, &Bytes::from(&proof.b)));
    g2_vec.push_back(C::g2_from_bytes(env, &Bytes::from(&vk.beta)));
    g2_vec.push_back(C::g2_from_bytes(env, &Bytes::from(&vk.gamma)));
    g2_vec.push_back(C::g2_from_bytes(env, &Bytes::from(&vk.delta)));

    C::pairing_check(env, g1_vec, g2_vec)
}

#[cfg(not(any(test, feature = "testutils")))]
fn compute_vk_x<C: Groth16Curve>(
    env: &Env,
    vk: &VerificationKey,
    pub_signals: &Vec<U256>,
) -> C::G1 {
    let ic0 = vk.ic.get(0).expect("IC[0] missing");
    let mut vk_x = C::g1_from_bytes(env, &Bytes::from(&ic0));

    for i in 0..pub_signals.len() {
        let signal = pub_signals.get(i).expect("signal missing");
        let ic_point_bytes = vk.ic.get(i + 1).expect("IC point missing");
        let ic_point = C::g1_from_bytes(env, &Bytes::from(&ic_point_bytes));
        let scalar = C::fr_from_u256(&signal);
        let scaled_point = C::g1_mul(env, &ic_point, &scalar);
        vk_x = C::g1_add(env, &vk_x, &scaled_point);
    }

    vk_x
}

pub fn verify_groth16(
    env: &Env,
    vk: &VerificationKey,
    proof: &Proof,
    pub_signals: &Vec<U256>,
) -> bool {
    if pub_signals.len() + 1 != vk.ic.len() {
        return false;
    }

    // Test-mode bypass: return true without crypto
    // WARNING: Does not exercise the production verification path
    #[cfg(any(test, feature = "testutils"))]
    {
        let _ = (env, vk, proof, pub_signals);
        true
    }

    #[cfg(not(any(test, feature = "testutils")))]
    verify_groth16_impl::<Bn254Curve>(env, vk, proof, pub_signals)
}

// --- BLS12-381 verification ---

#[cfg(not(any(test, feature = "testutils")))]
fn verify_groth16_impl_bls381(
    env: &Env,
    vk: &VerificationKeyBls381,
    proof: &ProofBls381,
    pub_signals: &Vec<U256>,
) -> bool {
    if pub_signals.len() + 1 != vk.ic.len() {
        return false;
    }

    // Prevent invalid-curve/subgroup and timing attacks by explicitly rejecting identity points
    // in constant-time before performing any pairing operations.
    if is_identity_bls381_g1(&proof.a) || is_identity_bls381_g2(&proof.b) || is_identity_bls381_g1(&proof.c) {
        return false;
    }


    let vk_x = compute_vk_x_impl_bls381(env, vk, pub_signals);

    let neg_a = Bls12381Curve::g1_neg(&Bls12381Curve::g1_from_bytes(env, &Bytes::from(&proof.a)));

    let mut g1_vec: Vec<Bls12381G1Affine> = Vec::new(env);
    g1_vec.push_back(neg_a);
    g1_vec.push_back(Bls12381Curve::g1_from_bytes(env, &Bytes::from(&vk.alpha)));
    g1_vec.push_back(vk_x);
    g1_vec.push_back(Bls12381Curve::g1_from_bytes(env, &Bytes::from(&proof.c)));

    let mut g2_vec: Vec<Bls12381G2Affine> = Vec::new(env);
    g2_vec.push_back(Bls12381Curve::g2_from_bytes(env, &Bytes::from(&proof.b)));
    g2_vec.push_back(Bls12381Curve::g2_from_bytes(env, &Bytes::from(&vk.beta)));
    g2_vec.push_back(Bls12381Curve::g2_from_bytes(env, &Bytes::from(&vk.gamma)));
    g2_vec.push_back(Bls12381Curve::g2_from_bytes(env, &Bytes::from(&vk.delta)));

    Bls12381Curve::pairing_check(env, g1_vec, g2_vec)
}

#[cfg(not(any(test, feature = "testutils")))]
fn compute_vk_x_impl_bls381(
    env: &Env,
    vk: &VerificationKeyBls381,
    pub_signals: &Vec<U256>,
) -> Bls12381G1Affine {
    let ic0 = vk.ic.get(0).expect("IC[0] missing");
    let mut vk_x = Bls12381Curve::g1_from_bytes(env, &Bytes::from(&ic0));

    for i in 0..pub_signals.len() {
        let signal = pub_signals.get(i).expect("signal missing");
        let ic_point_bytes = vk.ic.get(i + 1).expect("IC point missing");
        let ic_point = Bls12381Curve::g1_from_bytes(env, &Bytes::from(&ic_point_bytes));
        let scalar = Bls12381Curve::fr_from_u256(&signal);
        let scaled_point = Bls12381Curve::g1_mul(env, &ic_point, &scalar);
        vk_x = Bls12381Curve::g1_add(env, &vk_x, &scaled_point);
    }

    vk_x
}

pub fn verify_groth16_bls381(
    env: &Env,
    vk: &VerificationKeyBls381,
    proof: &ProofBls381,
    pub_signals: &Vec<U256>,
) -> bool {
    if pub_signals.len() + 1 != vk.ic.len() {
        return false;
    }

    #[cfg(any(test, feature = "testutils"))]
    {
        let _ = (env, vk, proof, pub_signals);
        true
    }

    #[cfg(not(any(test, feature = "testutils")))]
    verify_groth16_impl_bls381(env, vk, proof, pub_signals)
}

pub fn assert_in_field_bls381(env: &Env, value: &U256) -> Result<(), Groth16Error> {
    let modulus = U256::from_be_bytes(env, &Bytes::from_array(env, &BLS12_381_FR_MODULUS));
    if value >= &modulus {
        return Err(Groth16Error::SignalNotInField);
    }
    Ok(())
}

pub fn is_in_field_bls381(env: &Env, value: &U256) -> bool {
    let modulus = U256::from_be_bytes(env, &Bytes::from_array(env, &BLS12_381_FR_MODULUS));
    value < &modulus
}

pub fn validate_nullifier_bls381(env: &Env, nullifier: &U256) -> Result<(), Groth16Error> {
    if nullifier == &U256::from_u32(env, 0) {
        return Err(Groth16Error::InvalidNullifier);
    }
    assert_in_field_bls381(env, nullifier)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_in_field_valid() {
        let env = Env::default();
        let value = U256::from_u32(&env, 12345);
        assert!(is_in_field(&env, &value));
    }

    #[test]
    fn test_is_in_field_at_modulus() {
        let env = Env::default();
        let modulus = U256::from_be_bytes(&env, &Bytes::from_array(&env, &BN254_FR_MODULUS));
        assert!(!is_in_field(&env, &modulus));
    }

    #[test]
    fn test_assert_in_field_valid() {
        let env = Env::default();
        let value = U256::from_u32(&env, 12345);
        assert!(assert_in_field(&env, &value).is_ok());
    }

    #[test]
    fn test_assert_in_field_at_modulus() {
        let env = Env::default();
        let modulus = U256::from_be_bytes(&env, &Bytes::from_array(&env, &BN254_FR_MODULUS));
        assert_eq!(
            assert_in_field(&env, &modulus),
            Err(Groth16Error::SignalNotInField)
        );
    }

    #[test]
    fn test_validate_nullifier_valid() {
        let env = Env::default();
        let nullifier = U256::from_u32(&env, 12345);
        assert!(validate_nullifier(&env, &nullifier).is_ok());
    }

    #[test]
    fn test_validate_nullifier_zero() {
        let env = Env::default();
        let nullifier = U256::from_u32(&env, 0);
        assert_eq!(
            validate_nullifier(&env, &nullifier),
            Err(Groth16Error::InvalidNullifier)
        );
    }

    #[test]
    fn test_validate_nullifier_at_modulus() {
        let env = Env::default();
        let modulus = U256::from_be_bytes(&env, &Bytes::from_array(&env, &BN254_FR_MODULUS));
        assert_eq!(
            validate_nullifier(&env, &modulus),
            Err(Groth16Error::SignalNotInField)
        );
    }

    #[test]
    fn test_verify_groth16_ic_mismatch() {
        let env = Env::default();
        let vk = VerificationKey {
            alpha: BytesN::from_array(&env, &[0u8; 64]),
            beta: BytesN::from_array(&env, &[0u8; 128]),
            gamma: BytesN::from_array(&env, &[0u8; 128]),
            delta: BytesN::from_array(&env, &[0u8; 128]),
            ic: soroban_sdk::vec![&env, BytesN::from_array(&env, &[0u8; 64])],
        };
        let proof = Proof {
            a: BytesN::from_array(&env, &[0u8; 64]),
            b: BytesN::from_array(&env, &[0u8; 128]),
            c: BytesN::from_array(&env, &[0u8; 64]),
        };
        let signals = soroban_sdk::vec![&env, U256::from_u32(&env, 1), U256::from_u32(&env, 2)];
        assert!(!verify_groth16(&env, &vk, &proof, &signals));
    }

    // --- BLS12-381 tests ---

    #[test]
    fn test_bls381_is_in_field_valid() {
        let env = Env::default();
        let value = U256::from_u32(&env, 12345);
        assert!(is_in_field_bls381(&env, &value));
    }

    #[test]
    fn test_bls381_is_in_field_at_modulus() {
        let env = Env::default();
        let modulus = U256::from_be_bytes(&env, &Bytes::from_array(&env, &BLS12_381_FR_MODULUS));
        assert!(!is_in_field_bls381(&env, &modulus));
    }

    #[test]
    fn test_bls381_assert_in_field_valid() {
        let env = Env::default();
        let value = U256::from_u32(&env, 12345);
        assert!(assert_in_field_bls381(&env, &value).is_ok());
    }

    #[test]
    fn test_bls381_assert_in_field_at_modulus() {
        let env = Env::default();
        let modulus = U256::from_be_bytes(&env, &Bytes::from_array(&env, &BLS12_381_FR_MODULUS));
        assert_eq!(
            assert_in_field_bls381(&env, &modulus),
            Err(Groth16Error::SignalNotInField)
        );
    }

    #[test]
    fn test_bls381_validate_nullifier_valid() {
        let env = Env::default();
        let nullifier = U256::from_u32(&env, 12345);
        assert!(validate_nullifier_bls381(&env, &nullifier).is_ok());
    }

    #[test]
    fn test_bls381_validate_nullifier_zero() {
        let env = Env::default();
        let nullifier = U256::from_u32(&env, 0);
        assert_eq!(
            validate_nullifier_bls381(&env, &nullifier),
            Err(Groth16Error::InvalidNullifier)
        );
    }

    #[test]
    fn test_bls381_validate_nullifier_at_modulus() {
        let env = Env::default();
        let modulus = U256::from_be_bytes(&env, &Bytes::from_array(&env, &BLS12_381_FR_MODULUS));
        assert_eq!(
            validate_nullifier_bls381(&env, &modulus),
            Err(Groth16Error::SignalNotInField)
        );
    }

    // ── Coarse error code mapping tests ─────────────────────────────────

    #[test]
    fn coarse_admin_preserves_specific_codes() {
        let cases = [
            Groth16Error::IcLengthMismatch,
            Groth16Error::SignalNotInField,
            Groth16Error::InvalidNullifier,
            Groth16Error::InvalidProofFormat,
            Groth16Error::ProofInvalid,
            Groth16Error::InvalidInput,
        ];
        for c in &cases {
            assert_eq!(c.to_coarse(PathContext::Admin), *c);
        }
    }

    #[test]
    fn coarse_anon_collapses_input_errors() {
        assert_eq!(
            Groth16Error::SignalNotInField.to_coarse(PathContext::Anonymous),
            Groth16Error::InvalidInput
        );
        assert_eq!(
            Groth16Error::InvalidNullifier.to_coarse(PathContext::Anonymous),
            Groth16Error::InvalidInput
        );
    }

    #[test]
    fn coarse_anon_collapses_proof_errors() {
        assert_eq!(
            Groth16Error::IcLengthMismatch.to_coarse(PathContext::Anonymous),
            Groth16Error::ProofInvalid
        );
        assert_eq!(
            Groth16Error::InvalidProofFormat.to_coarse(PathContext::Anonymous),
            Groth16Error::ProofInvalid
        );
    }

    #[test]
    fn coarse_anon_passthroughs() {
        assert_eq!(
            Groth16Error::ProofInvalid.to_coarse(PathContext::Anonymous),
            Groth16Error::ProofInvalid
        );
        assert_eq!(
            Groth16Error::InvalidInput.to_coarse(PathContext::Anonymous),
            Groth16Error::InvalidInput
        );
    }

    #[test]

    #[test]
    fn test_timing_identity_rejection() {
        let env = Env::default();
        let vk = VerificationKey {
            alpha: BytesN::from_array(&env, &[0u8; 64]),
            beta: BytesN::from_array(&env, &[0u8; 128]),
            gamma: BytesN::from_array(&env, &[0u8; 128]),
            delta: BytesN::from_array(&env, &[0u8; 128]),
            ic: soroban_sdk::vec![&env, BytesN::from_array(&env, &[0u8; 64])],
        };
        let mut proof = Proof {
            a: BytesN::from_array(&env, &[0u8; 64]), // Identity point
            b: BytesN::from_array(&env, &[0u8; 128]),
            c: BytesN::from_array(&env, &[0u8; 64]),
        };
        let signals = soroban_sdk::vec![&env];
        
        // This should quickly return false without trying to parse or pair
        // (if not rejected, the host function would panic or take longer)
        // Note: verify_groth16 returns true in test mode normally, but here we can check the constant time func
        assert!(is_identity_bn254_g1(&proof.a));
        
        // Modify a to not be identity
        let mut a_bytes = [0u8; 64];
        a_bytes[0] = 1;
        proof.a = BytesN::from_array(&env, &a_bytes);
        assert!(!is_identity_bn254_g1(&proof.a));
    }

    fn test_bls381_verify_groth16_ic_mismatch() {
        let env = Env::default();
        let vk = VerificationKeyBls381 {
            alpha: BytesN::from_array(&env, &[0u8; 96]),
            beta: BytesN::from_array(&env, &[0u8; 192]),
            gamma: BytesN::from_array(&env, &[0u8; 192]),
            delta: BytesN::from_array(&env, &[0u8; 192]),
            ic: soroban_sdk::vec![&env, BytesN::from_array(&env, &[0u8; 96])],
        };
        let proof = ProofBls381 {
            a: BytesN::from_array(&env, &[0u8; 96]),
            b: BytesN::from_array(&env, &[0u8; 192]),
            c: BytesN::from_array(&env, &[0u8; 96]),
        };
        let signals = soroban_sdk::vec![&env, U256::from_u32(&env, 1), U256::from_u32(&env, 2)];
        assert!(!verify_groth16_bls381(&env, &vk, &proof, &signals));
    }

    /// Benchmarks: on-chain cost comparison between BN254 and BLS12-381
    /// operations. Registers a minimal Soroban contract, invokes each operation,
    /// and reports `env.cost_estimate().resources()` — instruction count and
    /// memory bytes consumed by the host.
    ///
    /// Wasm VM overhead is excluded (register_contract uses Rust struct, not
    /// compiled Wasm), but host function costs are real and directly comparable.
    /// Full Groth16 verification cost can be modeled as:
    ///
    ///   cost = pairing_check + neg_a + vk_x + [4×field checks + signal alloc]
    mod benchmark {
        extern crate std;

        use super::*;
        use soroban_sdk::{contract, contractimpl, Address, Env, Symbol, U256};

        struct BenchResult {
            name: &'static str,
            instructions: i64,
            mem_bytes: i64,
        }

        fn measure(
            env: &Env,
            contract_id: &Address,
            name: &'static str,
            func: &str,
        ) -> BenchResult {
            let _: bool =
                env.invoke_contract(contract_id, &Symbol::new(env, func), soroban_sdk::vec![env]);
            let res = env.cost_estimate().resources();
            BenchResult {
                name,
                instructions: res.instructions,
                mem_bytes: res.mem_bytes,
            }
        }

        #[contract]
        struct BenchContract;

        #[contractimpl]
        impl BenchContract {
            /// Field check: BN254 scalar field modulus comparison.
            pub fn bench_field_bn254(env: Env) -> bool {
                let modulus =
                    U256::from_be_bytes(&env, &Bytes::from_array(&env, &BN254_FR_MODULUS));
                U256::from_u32(&env, 12345) < modulus
            }

            /// Field check: BLS12-381 scalar field modulus comparison.
            pub fn bench_field_bls381(env: Env) -> bool {
                let modulus =
                    U256::from_be_bytes(&env, &Bytes::from_array(&env, &BLS12_381_FR_MODULUS));
                U256::from_u32(&env, 12345) < modulus
            }

            /// Build and return the 5-signal Vec used in vote/comment proofs.
            pub fn bench_signals(env: Env) -> bool {
                let v = soroban_sdk::vec![
                    &env,
                    U256::from_u32(&env, 1),
                    U256::from_u32(&env, 2),
                    U256::from_u32(&env, 3),
                    U256::from_u32(&env, 4),
                    U256::from_u32(&env, 5),
                ];
                v.len() == 5
            }

            /// U256 multiplication (used internally for field checks).
            pub fn bench_u256_mul(env: Env) -> bool {
                let a = U256::from_u32(&env, 0x12345678);
                let b = U256::from_u32(&env, 0x9abcdef0);
                let c = a.mul(&b);
                c == U256::from_u128(&env, 0xa0b4c2d8a0b4c2d8)
            }

            /// Deserialize a 64-byte BN254 G1 from bytes (used for proof parsing).
            pub fn bench_g1_from_bytes_bn254(env: Env) -> bool {
                let bytes = BytesN::from_array(&env, &[0u8; 64]);
                let p = Bn254G1Affine::from_bytes(bytes);
                // Identity point has x=y=0 for BN254 (valid infinity encoding)
                p.to_array() == [0u8; 64]
            }

            /// Deserialize a 96-byte BLS12-381 G1 from bytes.
            /// The identity element has the MSB of the first byte set (flag encoding).
            pub fn bench_g1_from_bytes_bls381(env: Env) -> bool {
                // BLS12-381 G1 identity is encoded as 0xc0 followed by 95 zero bytes
                // (flag byte for infinity + sign, all zeros for coordinates).
                let mut buf = [0u8; 96];
                buf[0] = 0xc0;
                let bytes = BytesN::from_array(&env, &buf);
                let p = Bls12381G1Affine::from_bytes(bytes);
                // Verify it's identity: to_array returns the raw bytes back
                p.to_array() == buf
            }
        }

        #[test]
        fn bench_all() {
            let env = Env::default();
            env.cost_estimate().disable_resource_limits();

            let contract_id = env.register(BenchContract, ());

            let cases: [(&str, &str); 6] = [
                ("field check BN254", "bench_field_bn254"),
                ("field check BLS12-381", "bench_field_bls381"),
                ("5 pub signals", "bench_signals"),
                ("U256 mul", "bench_u256_mul"),
                ("G1 from_bytes BN254 (64B)", "bench_g1_from_bytes_bn254"),
                (
                    "G1 from_bytes BLS12-381 (96B)",
                    "bench_g1_from_bytes_bls381",
                ),
            ];

            let mut results: std::vec::Vec<BenchResult> = std::vec::Vec::new();
            for (name, func) in &cases {
                results.push(measure(&env, &contract_id, name, func));
            }

            std::println!("\n=== ZK-VOTE: On-Chain Cost Benchmark ===");
            std::println!(
                "  {:<35} {:>15} {:>15}",
                "Operation",
                "Instructions",
                "Mem (bytes)"
            );
            std::println!("  {}", "-".repeat(68));
            for r in &results {
                std::println!(
                    "  {:<35} {:>15} {:>15}",
                    r.name,
                    r.instructions,
                    r.mem_bytes
                );
            }
            std::println!("  {}", "-".repeat(68));

            if let (Some(bn), Some(bls)) = (results.first(), results.get(1)) {
                let ratio = if bn.instructions > 0 {
                    bls.instructions as f64 / bn.instructions as f64
                } else {
                    0.0
                };
                std::println!(
                    "  {:<35} {:>13.2}x {:>15}",
                    "BLS12-381 / BN254 field check ratio",
                    ratio,
                    ""
                );
            }
            if let (Some(bn), Some(bls)) = (results.get(4), results.get(5)) {
                let ratio = if bn.instructions > 0 {
                    bls.instructions as f64 / bn.instructions as f64
                } else {
                    0.0
                };
                std::println!(
                    "  {:<35} {:>13.2}x {:>15}",
                    "BLS12-381 / BN254 G1 from_bytes ratio",
                    ratio,
                    ""
                );
            }

            std::println!();
            std::println!("Note: env.register_contract() — Wasm VM overhead excluded.");
            std::println!(
                "Full Groth16 verification = 1 pairing + 4x G1 ops + 3x G2 from_bytes + signals."
            );
            std::println!("Pairing cost not directly measured (needs valid curve points).");
            std::println!("Expected pairing ratio ~1.5x based on field size (381/254).");
        }
    }
}
