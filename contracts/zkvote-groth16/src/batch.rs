//! Batch Groth16 verification for proofs sharing one verification key (#90).
//!
//! # Why
//!
//! Verifying a vote costs four BN254 pairings plus one multi-scalar
//! multiplication over the verification key's `IC` vector. Pairings dominate
//! that cost by an order of magnitude, so an election with many voters pays
//! `4N` pairings — the part of the protocol that scales worst.
//!
//! # The identity
//!
//! Groth16's check for proof `i` can be written as a single product equalling
//! the target group's identity:
//!
//! ```text
//! e(-A_i, B_i) . e(alpha, beta) . e(vk_x_i, gamma) . e(C_i, delta) == 1
//! ```
//!
//! Raising equation `i` to an independent random scalar `r_i` and multiplying
//! all `N` of them together gives, using `e(X, Y)^r == e(rX, Y)`:
//!
//! ```text
//! PROD_i e(-r_i A_i, B_i)
//!   . e((SUM_i r_i) alpha, beta)
//!   . e(SUM_i r_i vk_x_i, gamma)
//!   . e(SUM_i r_i C_i,    delta) == 1
//! ```
//!
//! The last three terms collapse because `beta`, `gamma` and `delta` are the
//! same G2 points for every proof; only the `B_i` differ, so those stay
//! separate. The batch therefore costs **`N + 3` pairings instead of `4N`**.
//!
//! This is the small-exponents batch test of Bellare, Garay and Rabin. If any
//! single proof is invalid, the combined equation holds only if the adversary
//! guessed the randomisers, which happens with probability at most
//! `N / 2^128` here.
//!
//! # Why the randomisers must be unpredictable
//!
//! Batching with attacker-chosen or publicly-predictable `r_i` is unsound: two
//! invalid proofs can be crafted whose errors cancel in the combination. The
//! randomisers are therefore derived by Fiat-Shamir from a hash committing to
//! the verification key, *every* proof and *every* public signal in the batch.
//! A prover cannot choose a proof after seeing the randomisers, because
//! changing any proof changes every randomiser.
//!
//! # Hoisting shared public signals
//!
//! `vk_x_i = IC[0] + SUM_j s_ij . IC[j+1]` normally costs `k+1` scalar
//! multiplications per proof. In a real batch most signals are identical
//! across proofs — every vote in one election shares `daoId`, `proposalId` and
//! `numCandidates`, and in `Fixed` mode the Merkle `root` as well. Splitting
//! `vk_x_i` into a shared point `S` and a per-proof remainder `P_i`:
//!
//! ```text
//! SUM_i r_i vk_x_i = (SUM_i r_i) . S + SUM_i r_i P_i
//! ```
//!
//! collapses the shared columns into one scalar multiplication for the whole
//! batch instead of one per proof. The columns are detected from the inputs, so
//! callers get the saving without declaring anything.
//!
//! # All-or-nothing
//!
//! A batch verifies as a unit. A `false` result means *at least one* proof in
//! the batch is invalid, not which one; a caller that needs to identify the
//! culprit must fall back to per-proof verification. Callers must therefore
//! never treat a failed batch as evidence against any particular submitter.

use soroban_sdk::{Bytes, BytesN, Env, Vec, U256};

use crate::{is_in_field, Proof, VerificationKey};
#[cfg(not(any(test, feature = "testutils")))]
use crate::{Bn254Curve, Groth16Curve};

/// Domain separation for the Fiat-Shamir transcript. Bumping this string
/// invalidates every previously derived randomiser, which is what a change to
/// the transcript layout requires.
const BATCH_TRANSCRIPT_TAG: &[u8] = b"ZKVOTE-GROTH16-BATCH-V1";

/// Randomiser width in bytes. 128 bits bounds the batch soundness error at
/// `N / 2^128` while keeping the scalars small.
const RANDOMIZER_BYTES: u32 = 16;

/// Batches larger than this are rejected outright: the pairing check has to fit
/// in one transaction's resource budget, and an unbounded batch is a way to
/// build a transaction that can never succeed.
pub const MAX_BATCH_SIZE: u32 = 64;

/// Builds the Fiat-Shamir transcript for a batch.
///
/// The digest commits to the verification key, the number of proofs, every
/// proof point and every public signal. Any change to any of them yields
/// different randomisers, which is what stops a prover from choosing proofs
/// with knowledge of the combination.
pub fn batch_transcript(
    env: &Env,
    vk: &VerificationKey,
    proofs: &Vec<Proof>,
    pub_signals: &Vec<Vec<U256>>,
) -> BytesN<32> {
    let mut transcript = Bytes::from_slice(env, BATCH_TRANSCRIPT_TAG);

    transcript.append(&Bytes::from(&vk.alpha));
    transcript.append(&Bytes::from(&vk.beta));
    transcript.append(&Bytes::from(&vk.gamma));
    transcript.append(&Bytes::from(&vk.delta));
    transcript.append(&Bytes::from_array(env, &vk.ic.len().to_be_bytes()));
    for point in vk.ic.iter() {
        transcript.append(&Bytes::from(&point));
    }

    transcript.append(&Bytes::from_array(env, &proofs.len().to_be_bytes()));
    for proof in proofs.iter() {
        transcript.append(&Bytes::from(&proof.a));
        transcript.append(&Bytes::from(&proof.b));
        transcript.append(&Bytes::from(&proof.c));
    }

    for signals in pub_signals.iter() {
        transcript.append(&Bytes::from_array(env, &signals.len().to_be_bytes()));
        for signal in signals.iter() {
            transcript.append(&signal.to_be_bytes());
        }
    }

    env.crypto().sha256(&transcript).into()
}

/// Derives `count` independent 128-bit randomisers from the transcript.
///
/// Each is `sha256(transcript || i)` truncated to 16 bytes. Independent draws
/// rather than powers of one challenge: both are sound, but independent draws
/// avoid needing modular multiplication, which the SDK's `Fr` does not expose.
pub fn batch_randomizers(env: &Env, transcript: &BytesN<32>, count: u32) -> Vec<U256> {
    let mut out = Vec::new(env);
    for i in 0..count {
        let mut input = Bytes::from(transcript);
        input.append(&Bytes::from_array(env, &i.to_be_bytes()));
        let digest: BytesN<32> = env.crypto().sha256(&input).into();

        // U256::from_be_bytes wants exactly 32 bytes, so left-pad the 16-byte
        // draw with zeros; the result is a 128-bit scalar in a 256-bit word.
        let mut scalar_bytes = Bytes::from_array(env, &[0u8; 16]);
        scalar_bytes.append(&Bytes::from(&digest).slice(0..RANDOMIZER_BYTES));
        let mut scalar = U256::from_be_bytes(env, &scalar_bytes);

        // A zero randomiser would drop a proof from the combination entirely.
        // The probability is 2^-128, but the guard costs nothing.
        if scalar == U256::from_u32(env, 0) {
            scalar = U256::from_u32(env, 1);
        }
        out.push_back(scalar);
    }
    out
}

/// Structural validation shared by the real and stubbed implementations.
///
/// Returns false when the batch could never verify regardless of the curve
/// arithmetic: wrong shape, empty, oversized, or a signal outside the scalar
/// field. Out-of-field signals matter because `Fr` reduces on construction, so
/// two different `U256` values could otherwise denote the same statement.
fn batch_shape_is_valid(
    env: &Env,
    vk: &VerificationKey,
    proofs: &Vec<Proof>,
    pub_signals: &Vec<Vec<U256>>,
) -> bool {
    let n = proofs.len();
    if n == 0 || n > MAX_BATCH_SIZE {
        return false;
    }
    if pub_signals.len() != n {
        return false;
    }
    for signals in pub_signals.iter() {
        if signals.len() + 1 != vk.ic.len() {
            return false;
        }
        for signal in signals.iter() {
            if !is_in_field(env, &signal) {
                return false;
            }
        }
    }
    true
}

/// Indices of the public-signal columns that are not constant across the batch.
// Only the real verifier calls this; under `testutils` the stub short-circuits
// before any curve work, but the unit tests still exercise it directly.
#[cfg_attr(feature = "testutils", allow(dead_code))]
fn varying_columns(pub_signals: &Vec<Vec<U256>>, env: &Env) -> Vec<u32> {
    let mut varying = Vec::new(env);
    let first = pub_signals.get(0).expect("non-empty batch");
    for column in 0..first.len() {
        let reference = first.get(column).expect("signal missing");
        let mut differs = false;
        for signals in pub_signals.iter() {
            if signals.get(column).expect("signal missing") != reference {
                differs = true;
                break;
            }
        }
        if differs {
            varying.push_back(column);
        }
    }
    varying
}

#[cfg(not(any(test, feature = "testutils")))]
fn verify_groth16_batch_impl(
    env: &Env,
    vk: &VerificationKey,
    proofs: &Vec<Proof>,
    pub_signals: &Vec<Vec<U256>>,
) -> bool {
    use soroban_sdk::crypto::bn254::Bn254G1Affine;

    let n = proofs.len();
    let randomizers = batch_randomizers(env, &batch_transcript(env, vk, proofs, pub_signals), n);
    let varying = varying_columns(pub_signals, env);

    // Shared part of vk_x: IC[0] plus every column that is constant across the
    // batch, computed once for the whole batch instead of once per proof.
    let first = pub_signals.get(0).expect("non-empty batch");
    let mut shared: Bn254G1Affine =
        Bn254Curve::g1_from_bytes(env, &Bytes::from(&vk.ic.get(0).expect("IC[0] missing")));
    for column in 0..first.len() {
        if varying.contains(column) {
            continue;
        }
        let signal = first.get(column).expect("signal missing");
        let ic_point = Bn254Curve::g1_from_bytes(
            env,
            &Bytes::from(&vk.ic.get(column + 1).expect("IC point missing")),
        );
        let scaled = Bn254Curve::g1_mul(env, &ic_point, &Bn254Curve::fr_from_u256(&signal));
        shared = Bn254Curve::g1_add(env, &shared, &scaled);
    }

    let mut g1: Vec<Bn254G1Affine> = Vec::new(env);
    let mut g2 = Vec::new(env);

    let mut randomizer_sum = U256::from_u32(env, 0);
    let mut combined_varying: Option<Bn254G1Affine> = None;
    let mut combined_c: Option<Bn254G1Affine> = None;

    for i in 0..n {
        let proof = proofs.get(i).expect("proof missing");
        let signals = pub_signals.get(i).expect("signals missing");
        let r = randomizers.get(i).expect("randomizer missing");
        let r_fr = Bn254Curve::fr_from_u256(&r);

        // e(-r_i A_i, B_i)
        let a = Bn254Curve::g1_from_bytes(env, &Bytes::from(&proof.a));
        let scaled_a = Bn254Curve::g1_mul(env, &a, &r_fr);
        g1.push_back(Bn254Curve::g1_neg(&scaled_a));
        g2.push_back(Bn254Curve::g2_from_bytes(env, &Bytes::from(&proof.b)));

        // SUM_i r_i: each randomiser is 128 bits and the batch is capped at 64
        // proofs, so the sum is well under the 254-bit modulus and cannot wrap.
        randomizer_sum = randomizer_sum.add(&r);

        // r_i * (the columns that actually differ between proofs)
        if !varying.is_empty() {
            let mut partial: Option<Bn254G1Affine> = None;
            for column in varying.iter() {
                let signal = signals.get(column).expect("signal missing");
                let ic_point = Bn254Curve::g1_from_bytes(
                    env,
                    &Bytes::from(&vk.ic.get(column + 1).expect("IC point missing")),
                );
                let scaled = Bn254Curve::g1_mul(env, &ic_point, &Bn254Curve::fr_from_u256(&signal));
                partial = Some(match partial {
                    None => scaled,
                    Some(acc) => Bn254Curve::g1_add(env, &acc, &scaled),
                });
            }
            if let Some(partial) = partial {
                let weighted = Bn254Curve::g1_mul(env, &partial, &r_fr);
                combined_varying = Some(match combined_varying {
                    None => weighted,
                    Some(acc) => Bn254Curve::g1_add(env, &acc, &weighted),
                });
            }
        }

        // r_i * C_i
        let c = Bn254Curve::g1_from_bytes(env, &Bytes::from(&proof.c));
        let weighted_c = Bn254Curve::g1_mul(env, &c, &r_fr);
        combined_c = Some(match combined_c {
            None => weighted_c,
            Some(acc) => Bn254Curve::g1_add(env, &acc, &weighted_c),
        });
    }

    let sum_fr = Bn254Curve::fr_from_u256(&randomizer_sum);

    // e((SUM r_i) alpha, beta)
    let alpha = Bn254Curve::g1_from_bytes(env, &Bytes::from(&vk.alpha));
    g1.push_back(Bn254Curve::g1_mul(env, &alpha, &sum_fr));
    g2.push_back(Bn254Curve::g2_from_bytes(env, &Bytes::from(&vk.beta)));

    // e(SUM r_i vk_x_i, gamma) = e((SUM r_i) S + SUM r_i P_i, gamma)
    let mut combined_vk_x = Bn254Curve::g1_mul(env, &shared, &sum_fr);
    if let Some(varying_part) = combined_varying {
        combined_vk_x = Bn254Curve::g1_add(env, &combined_vk_x, &varying_part);
    }
    g1.push_back(combined_vk_x);
    g2.push_back(Bn254Curve::g2_from_bytes(env, &Bytes::from(&vk.gamma)));

    // e(SUM r_i C_i, delta)
    g1.push_back(combined_c.expect("non-empty batch"));
    g2.push_back(Bn254Curve::g2_from_bytes(env, &Bytes::from(&vk.delta)));

    Bn254Curve::pairing_check(env, g1, g2)
}

/// Verifies `N` Groth16 proofs against one verification key in a single
/// pairing check.
///
/// Returns `true` only if every proof in the batch is valid for its own public
/// signals. A `false` result identifies the batch, not a proof: see the
/// all-or-nothing note in the module documentation.
///
/// Rejects the batch outright when it is empty, larger than [`MAX_BATCH_SIZE`],
/// has a public-signal count that does not match the verification key, or
/// carries a signal outside the BN254 scalar field.
pub fn verify_groth16_batch(
    env: &Env,
    vk: &VerificationKey,
    proofs: &Vec<Proof>,
    pub_signals: &Vec<Vec<U256>>,
) -> bool {
    if !batch_shape_is_valid(env, vk, proofs, pub_signals) {
        return false;
    }

    // A single proof gains nothing from batching and would pay three extra
    // scalar multiplications for the randomisation, so use the plain path.
    if proofs.len() == 1 {
        return crate::verify_groth16(
            env,
            vk,
            &proofs.get(0).expect("proof missing"),
            &pub_signals.get(0).expect("signals missing"),
        );
    }

    // Test-mode bypass, matching `verify_groth16`: returns true without doing
    // curve arithmetic so contract tests can run without real proofs.
    // WARNING: does not exercise the production verification path.
    #[cfg(any(test, feature = "testutils"))]
    {
        true
    }

    #[cfg(not(any(test, feature = "testutils")))]
    verify_groth16_batch_impl(env, vk, proofs, pub_signals)
}

/// Number of pairings a batch of `n` proofs costs, versus verifying them one
/// at a time. Exposed so callers and benchmarks can size a batch against the
/// transaction resource budget without duplicating the arithmetic.
pub fn pairing_count(n: u32) -> u32 {
    if n == 0 {
        0
    } else if n == 1 {
        4
    } else {
        n + 3
    }
}

/// Pairings saved by batching `n` proofs instead of verifying them singly.
pub fn pairings_saved(n: u32) -> u32 {
    4 * n - pairing_count(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{vec, BytesN};

    fn dummy_vk(env: &Env, ic_len: u32) -> VerificationKey {
        let mut ic = Vec::new(env);
        for i in 0..ic_len {
            let mut bytes = [0u8; 64];
            bytes[0] = i as u8;
            ic.push_back(BytesN::from_array(env, &bytes));
        }
        VerificationKey {
            alpha: BytesN::from_array(env, &[1u8; 64]),
            beta: BytesN::from_array(env, &[2u8; 128]),
            gamma: BytesN::from_array(env, &[3u8; 128]),
            delta: BytesN::from_array(env, &[4u8; 128]),
            ic,
        }
    }

    fn dummy_proof(env: &Env, seed: u8) -> Proof {
        Proof {
            a: BytesN::from_array(env, &[seed; 64]),
            b: BytesN::from_array(env, &[seed.wrapping_add(1); 128]),
            c: BytesN::from_array(env, &[seed.wrapping_add(2); 64]),
        }
    }

    fn signals(env: &Env, values: &[u32]) -> Vec<U256> {
        let mut out = Vec::new(env);
        for v in values {
            out.push_back(U256::from_u32(env, *v));
        }
        out
    }

    #[test]
    fn pairing_count_beats_individual_verification() {
        assert_eq!(pairing_count(0), 0);
        // One proof is not batched, so it costs the usual four pairings.
        assert_eq!(pairing_count(1), 4);
        assert_eq!(pairing_count(2), 5);
        assert_eq!(pairing_count(10), 13);
        assert_eq!(pairing_count(64), 67);

        assert_eq!(pairings_saved(1), 0);
        assert_eq!(pairings_saved(10), 27);
        assert_eq!(pairings_saved(64), 189);

        // The ratio approaches 4x as the batch grows.
        assert!(4 * 64 / pairing_count(64) >= 3);
    }

    #[test]
    fn transcript_commits_to_every_proof() {
        let env = Env::default();
        let vk = dummy_vk(&env, 3);
        let signal_set = vec![&env, signals(&env, &[1, 2]), signals(&env, &[3, 4])];

        let proofs = vec![&env, dummy_proof(&env, 10), dummy_proof(&env, 20)];
        let base = batch_transcript(&env, &vk, &proofs, &signal_set);

        let changed = vec![&env, dummy_proof(&env, 10), dummy_proof(&env, 21)];
        assert_ne!(base, batch_transcript(&env, &vk, &changed, &signal_set));
    }

    #[test]
    fn transcript_commits_to_every_public_signal() {
        let env = Env::default();
        let vk = dummy_vk(&env, 3);
        let proofs = vec![&env, dummy_proof(&env, 10), dummy_proof(&env, 20)];

        let base = batch_transcript(
            &env,
            &vk,
            &proofs,
            &vec![&env, signals(&env, &[1, 2]), signals(&env, &[3, 4])],
        );
        let changed = batch_transcript(
            &env,
            &vk,
            &proofs,
            &vec![&env, signals(&env, &[1, 2]), signals(&env, &[3, 5])],
        );
        assert_ne!(base, changed);
    }

    #[test]
    fn transcript_commits_to_the_verification_key() {
        let env = Env::default();
        let proofs = vec![&env, dummy_proof(&env, 10), dummy_proof(&env, 20)];
        let signal_set = vec![&env, signals(&env, &[1, 2]), signals(&env, &[3, 4])];

        let base = batch_transcript(&env, &dummy_vk(&env, 3), &proofs, &signal_set);
        let mut other = dummy_vk(&env, 3);
        other.delta = BytesN::from_array(&env, &[9u8; 128]);
        assert_ne!(base, batch_transcript(&env, &other, &proofs, &signal_set));
    }

    #[test]
    fn transcript_separates_batches_of_different_sizes() {
        // Without the length prefixes, a two-proof batch and a differently
        // grouped one could hash identically.
        let env = Env::default();
        let vk = dummy_vk(&env, 3);
        let two = batch_transcript(
            &env,
            &vk,
            &vec![&env, dummy_proof(&env, 10), dummy_proof(&env, 20)],
            &vec![&env, signals(&env, &[1, 2]), signals(&env, &[3, 4])],
        );
        let one = batch_transcript(
            &env,
            &vk,
            &vec![&env, dummy_proof(&env, 10)],
            &vec![&env, signals(&env, &[1, 2])],
        );
        assert_ne!(two, one);
    }

    #[test]
    fn randomizers_are_distinct_nonzero_and_deterministic() {
        let env = Env::default();
        let transcript = BytesN::from_array(&env, &[7u8; 32]);
        let first = batch_randomizers(&env, &transcript, 8);
        let again = batch_randomizers(&env, &transcript, 8);

        assert_eq!(first.len(), 8);
        assert_eq!(first, again);

        let zero = U256::from_u32(&env, 0);
        let mut bound_bytes = [0u8; 32];
        for byte in bound_bytes.iter_mut().skip(16) {
            *byte = 0xff;
        }
        let bound = U256::from_be_bytes(&env, &Bytes::from_array(&env, &bound_bytes));
        for i in 0..first.len() {
            let r = first.get(i).unwrap();
            assert_ne!(r, zero, "randomiser must never be zero");
            assert!(r <= bound, "randomiser must fit in 128 bits");
            for j in 0..i {
                assert_ne!(r, first.get(j).unwrap(), "randomisers must be distinct");
            }
        }
    }

    #[test]
    fn randomizers_change_with_the_transcript() {
        let env = Env::default();
        let a = batch_randomizers(&env, &BytesN::from_array(&env, &[1u8; 32]), 4);
        let b = batch_randomizers(&env, &BytesN::from_array(&env, &[2u8; 32]), 4);
        assert_ne!(a, b);
    }

    #[test]
    fn varying_columns_finds_only_the_columns_that_differ() {
        let env = Env::default();
        // Columns 0 and 2 are constant; column 1 differs.
        let signal_set = vec![
            &env,
            signals(&env, &[5, 1, 9]),
            signals(&env, &[5, 2, 9]),
            signals(&env, &[5, 3, 9]),
        ];
        assert_eq!(varying_columns(&signal_set, &env), vec![&env, 1u32]);
    }

    #[test]
    fn varying_columns_is_empty_when_every_proof_shares_its_signals() {
        let env = Env::default();
        let signal_set = vec![&env, signals(&env, &[5, 1]), signals(&env, &[5, 1])];
        assert_eq!(varying_columns(&signal_set, &env), Vec::<u32>::new(&env));
    }

    #[test]
    fn shape_validation_rejects_malformed_batches() {
        let env = Env::default();
        let vk = dummy_vk(&env, 3); // expects 2 public signals

        // Empty batch.
        assert!(!batch_shape_is_valid(
            &env,
            &vk,
            &Vec::new(&env),
            &Vec::new(&env)
        ));

        // Proof count and signal-set count disagree.
        assert!(!batch_shape_is_valid(
            &env,
            &vk,
            &vec![&env, dummy_proof(&env, 1), dummy_proof(&env, 2)],
            &vec![&env, signals(&env, &[1, 2])],
        ));

        // Wrong number of public signals for this verification key.
        assert!(!batch_shape_is_valid(
            &env,
            &vk,
            &vec![&env, dummy_proof(&env, 1)],
            &vec![&env, signals(&env, &[1, 2, 3])],
        ));

        // A well-formed batch passes.
        assert!(batch_shape_is_valid(
            &env,
            &vk,
            &vec![&env, dummy_proof(&env, 1), dummy_proof(&env, 2)],
            &vec![&env, signals(&env, &[1, 2]), signals(&env, &[3, 4])],
        ));
    }

    #[test]
    fn shape_validation_rejects_signals_outside_the_scalar_field() {
        let env = Env::default();
        let vk = dummy_vk(&env, 2); // expects 1 public signal
        let modulus = U256::from_be_bytes(&env, &Bytes::from_array(&env, &crate::BN254_FR_MODULUS));
        let mut out_of_field = Vec::new(&env);
        out_of_field.push_back(modulus);

        assert!(!batch_shape_is_valid(
            &env,
            &vk,
            &vec![&env, dummy_proof(&env, 1)],
            &vec![&env, out_of_field],
        ));
    }

    #[test]
    fn shape_validation_rejects_oversized_batches() {
        let env = Env::default();
        let vk = dummy_vk(&env, 2);
        let mut proofs = Vec::new(&env);
        let mut signal_sets = Vec::new(&env);
        for i in 0..(MAX_BATCH_SIZE + 1) {
            proofs.push_back(dummy_proof(&env, i as u8));
            signal_sets.push_back(signals(&env, &[i]));
        }
        assert!(!batch_shape_is_valid(&env, &vk, &proofs, &signal_sets));

        proofs.pop_back();
        signal_sets.pop_back();
        assert!(batch_shape_is_valid(&env, &vk, &proofs, &signal_sets));
    }

    #[test]
    fn malformed_batches_are_rejected_even_in_test_mode() {
        // The stubbed verifier still enforces shape, so contract tests cannot
        // accidentally pass a batch the production path would reject.
        let env = Env::default();
        let vk = dummy_vk(&env, 3);
        assert!(!verify_groth16_batch(
            &env,
            &vk,
            &Vec::new(&env),
            &Vec::new(&env)
        ));
        assert!(!verify_groth16_batch(
            &env,
            &vk,
            &vec![&env, dummy_proof(&env, 1)],
            &vec![&env, signals(&env, &[1, 2, 3])],
        ));
    }
}
