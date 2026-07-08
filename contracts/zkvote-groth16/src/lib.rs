//! # ZKVote Groth16 Verification Library
//!
//! Shared Groth16 zero-knowledge proof verification for ZKVote contracts.
//! Uses the BN254 elliptic curve (alt_bn128) for pairing-based verification.
//!
//! ## Cryptographic Primitives
//!
//! ### BN254 Curve (alt_bn128)
//! - **Definition**: y² = x³ + 3 over 𝔽_p where p = 21888242871839275222246405745257275088696311157297823662689037894645226208583
//! - **Scalar field order**: r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
//!
//! ### Groth16 SNARK
//! - **Paper**: "On the Size of Pairing-based Non-interactive Arguments" by Jens Groth (2016)
//! - **Implementation**: Uses Soroban BN254 host functions for verification

#![no_std]

use soroban_sdk::{contracterror, contracttype, Bytes, BytesN, Env, Vec, U256};

#[cfg(not(any(test, feature = "testutils")))]
use soroban_sdk::crypto::bn254::{Bn254G1Affine, Bn254G2Affine, Fr};

/// BN254 scalar field modulus (Fr) in big-endian bytes
/// r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
/// All public signals (nullifier, root, etc.) must be < r to prevent modular reduction attacks
pub const BN254_FR_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum Groth16Error {
    /// IC vector length doesn't match public signals + 1
    IcLengthMismatch = 30,
    /// Public signal value >= BN254 scalar field modulus (invalid field element)
    SignalNotInField = 31,
    /// Nullifier is zero (invalid)
    InvalidNullifier = 32,
}

/// Groth16 Verification Key for BN254
#[contracttype]
#[derive(Clone)]
pub struct VerificationKey {
    pub alpha: BytesN<64>,   // G1 point
    pub beta: BytesN<128>,   // G2 point
    pub gamma: BytesN<128>,  // G2 point
    pub delta: BytesN<128>,  // G2 point
    pub ic: Vec<BytesN<64>>, // IC points (G1)
}

/// Groth16 Proof
#[contracttype]
#[derive(Clone)]
pub struct Proof {
    pub a: BytesN<64>,  // G1 point
    pub b: BytesN<128>, // G2 point
    pub c: BytesN<64>,  // G1 point
}

/// Validate that a U256 value is within the BN254 scalar field (< r)
///
/// This prevents modular reduction attacks where values >= r are reduced mod r,
/// allowing attackers to submit different U256 values that verify identically.
///
/// SECURITY: All public signals (nullifier, root) MUST be validated before use.
/// Without this check, an attacker could double-vote by submitting nullifier=r+1
/// (stored as different key) which verifies the same as nullifier=1.
///
/// Returns `Err(Groth16Error::SignalNotInField)` if value >= r.
pub fn assert_in_field(env: &Env, value: &U256) -> Result<(), Groth16Error> {
    let modulus = U256::from_be_bytes(env, &Bytes::from_array(env, &BN254_FR_MODULUS));
    if value >= &modulus {
        return Err(Groth16Error::SignalNotInField);
    }
    Ok(())
}

/// Check if a U256 value is within the BN254 scalar field (< r)
/// Returns true if valid, false if >= r.
pub fn is_in_field(env: &Env, value: &U256) -> bool {
    let modulus = U256::from_be_bytes(env, &Bytes::from_array(env, &BN254_FR_MODULUS));
    value < &modulus
}

/// Validate that a nullifier is non-zero and within the BN254 scalar field.
/// Returns appropriate error for zero nullifier or out-of-field value.
pub fn validate_nullifier(env: &Env, nullifier: &U256) -> Result<(), Groth16Error> {
    // Check for zero nullifier
    if nullifier == &U256::from_u32(env, 0) {
        return Err(Groth16Error::InvalidNullifier);
    }
    // Check field bounds
    assert_in_field(env, nullifier)
}

/// Verify a Groth16 proof using BN254 pairing check.
///
/// The Groth16 verification equation is:
/// e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) = 1
///
/// Where vk_x = IC[0] + sum(pub_signals[i] * IC[i+1])
///
/// # Arguments
/// * `env` - Soroban environment
/// * `vk` - Verification key
/// * `proof` - Groth16 proof (A, B, C points)
/// * `pub_signals` - Public signals (must have length = IC.len() - 1)
///
/// # Returns
/// `true` if the proof verifies, `false` otherwise.
///
/// # Test Mode
/// In test mode (cfg(test) or feature="testutils"), always returns true
/// to allow testing without real proofs.
#[allow(unused_variables)]
pub fn verify_groth16(
    env: &Env,
    vk: &VerificationKey,
    proof: &Proof,
    pub_signals: &Vec<U256>,
) -> bool {
    // Validate IC length matches public signals
    if pub_signals.len() + 1 != vk.ic.len() {
        return false;
    }

    // In test mode, skip actual verification
    // WARNING: Test mode bypasses actual BN254 pairing check.
    // The production verification path (below) is NOT exercised by unit tests.
    // Integration tests with real proof vectors are needed to verify this path.
    #[cfg(any(test, feature = "testutils"))]
    {
        true
    }

    #[cfg(not(any(test, feature = "testutils")))]
    {
        // Step 1: Compute vk_x = IC[0] + sum(pub_signals[i] * IC[i+1])
        let vk_x = compute_vk_x(env, vk, pub_signals);

        // Step 2: Negate A using built-in G1 negation (flips Y coordinate)
        let a_point = Bn254G1Affine::from_bytes(proof.a.clone());
        let neg_a = -a_point;

        // Step 3: Build pairing vectors
        let mut g1_vec = Vec::new(env);
        g1_vec.push_back(neg_a);
        g1_vec.push_back(Bn254G1Affine::from_bytes(vk.alpha.clone()));
        g1_vec.push_back(Bn254G1Affine::from_bytes(vk_x));
        g1_vec.push_back(Bn254G1Affine::from_bytes(proof.c.clone()));

        let mut g2_vec = Vec::new(env);
        g2_vec.push_back(Bn254G2Affine::from_bytes(proof.b.clone()));
        g2_vec.push_back(Bn254G2Affine::from_bytes(vk.beta.clone()));
        g2_vec.push_back(Bn254G2Affine::from_bytes(vk.gamma.clone()));
        g2_vec.push_back(Bn254G2Affine::from_bytes(vk.delta.clone()));

        // Step 4: Perform pairing check
        env.crypto().bn254().pairing_check(g1_vec, g2_vec)
    }
}

/// Compute vk_x = IC[0] + sum(pub_signals[i] * IC[i+1])
/// This is the linear combination of IC points weighted by public signals.
#[cfg(not(any(test, feature = "testutils")))]
fn compute_vk_x(_env: &Env, vk: &VerificationKey, pub_signals: &Vec<U256>) -> BytesN<64> {
    // Start with IC[0]
    let ic0 = vk.ic.get(0).expect("IC[0] missing");
    let mut vk_x = Bn254G1Affine::from_bytes(ic0);

    // Add each pub_signal[i] * IC[i+1]
    for i in 0..pub_signals.len() {
        let signal = pub_signals.get(i).expect("signal missing");
        let ic_point_bytes = vk.ic.get(i + 1).expect("IC point missing");
        let ic_point = Bn254G1Affine::from_bytes(ic_point_bytes);

        // Scalar multiplication: signal * IC[i+1]
        let scalar = Fr::from(signal);
        let scaled_point = ic_point * scalar;

        // Add to accumulator
        vk_x = vk_x + scaled_point;
    }

    vk_x.to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::Env;

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
}
