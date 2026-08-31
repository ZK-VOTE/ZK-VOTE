//! Batch Groth16 verification against real proofs (#90).
//!
//! `verify_groth16_batch` is stubbed out under `cfg(test)` and the `testutils`
//! feature, exactly like `verify_groth16`, so a unit test can never reach the
//! BN254 arithmetic. This integration test builds without `testutils` and
//! therefore exercises the production pairing path end to end.
//!
//! The fixture is four genuine votes by different members of one DAO on one
//! proposal, so they share a verification key, a Merkle root, a dao id, a
//! proposal id and a candidate count while differing in nullifier and vote
//! choice — the exact shape the shared-column hoisting in `batch.rs` targets.

mod batch_fixture;

use batch_fixture::{PROOFS, VK_ALPHA, VK_BETA, VK_DELTA, VK_GAMMA, VK_IC};
use soroban_sdk::{BytesN, Env, Vec, U256};
use zkvote_groth16::{
    batch::{
        batch_randomizers, batch_transcript, pairing_count, pairings_saved, verify_groth16_batch,
        MAX_BATCH_SIZE,
    },
    verify_groth16, Proof, VerificationKey,
};

fn vk(env: &Env) -> VerificationKey {
    let mut ic = Vec::new(env);
    for point in VK_IC.iter() {
        ic.push_back(BytesN::from_array(env, point));
    }
    VerificationKey {
        alpha: BytesN::from_array(env, &VK_ALPHA),
        beta: BytesN::from_array(env, &VK_BETA),
        gamma: BytesN::from_array(env, &VK_GAMMA),
        delta: BytesN::from_array(env, &VK_DELTA),
        ic,
    }
}

fn u256_from_decimal(env: &Env, decimal: &str) -> U256 {
    // The fixture stores signals as decimal strings, the way snarkjs emits
    // them. Build the value with repeated multiply-add so the test does not
    // depend on any decimal parser in the SDK.
    let mut value = U256::from_u32(env, 0);
    let ten = U256::from_u32(env, 10);
    for byte in decimal.as_bytes() {
        assert!(byte.is_ascii_digit(), "signal must be decimal");
        value = value
            .mul(&ten)
            .add(&U256::from_u32(env, u32::from(byte - b'0')));
    }
    value
}

fn proof_at(env: &Env, index: usize) -> Proof {
    let fixture = &PROOFS[index];
    Proof {
        a: BytesN::from_array(env, &fixture.a),
        b: BytesN::from_array(env, &fixture.b),
        c: BytesN::from_array(env, &fixture.c),
    }
}

fn signals_at(env: &Env, index: usize) -> Vec<U256> {
    let mut out = Vec::new(env);
    for signal in PROOFS[index].signals.iter() {
        out.push_back(u256_from_decimal(env, signal));
    }
    out
}

fn full_batch(env: &Env) -> (Vec<Proof>, Vec<Vec<U256>>) {
    let mut proofs = Vec::new(env);
    let mut signals = Vec::new(env);
    for i in 0..PROOFS.len() {
        proofs.push_back(proof_at(env, i));
        signals.push_back(signals_at(env, i));
    }
    (proofs, signals)
}

#[test]
fn each_fixture_proof_verifies_individually() {
    // Establishes the baseline: without this, a passing batch test could mean
    // the fixture is broken in a way the batch happens to tolerate.
    let env = Env::default();
    // Four individual verifications do not fit in one transaction's budget.
    // That is the problem #90 exists to solve; see the budget test below.
    env.cost_estimate().budget().reset_unlimited();
    let vk = vk(&env);
    for i in 0..PROOFS.len() {
        assert!(
            verify_groth16(&env, &vk, &proof_at(&env, i), &signals_at(&env, i)),
            "fixture proof {i} must verify on its own"
        );
    }
}

#[test]
fn a_batch_of_valid_proofs_verifies() {
    let env = Env::default();
    let (proofs, signals) = full_batch(&env);
    assert!(
        verify_groth16_batch(&env, &vk(&env), &proofs, &signals),
        "a batch of individually valid proofs must verify"
    );
}

#[test]
fn every_sub_batch_of_valid_proofs_verifies() {
    // Batch sizes 2..n, and each contiguous window, so the combination is not
    // accidentally correct only for the full set.
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let vk = vk(&env);
    for size in 2..=PROOFS.len() {
        for start in 0..=(PROOFS.len() - size) {
            let mut proofs = Vec::new(&env);
            let mut signals = Vec::new(&env);
            for i in start..(start + size) {
                proofs.push_back(proof_at(&env, i));
                signals.push_back(signals_at(&env, i));
            }
            assert!(
                verify_groth16_batch(&env, &vk, &proofs, &signals),
                "sub-batch [{start}, {}) must verify",
                start + size
            );
        }
    }
}

// Under `cargo test --workspace`, feature unification pulls in the `testutils`
// stub verifier (the sibling contracts dev-depend on it), which accepts every
// proof and would invert this test. CI runs this file standalone as well, where
// the real verifier is compiled in and the test does its job.
#[cfg(not(feature = "testutils"))]
#[test]
fn a_single_proof_batch_matches_individual_verification() {
    let env = Env::default();
    let vk = vk(&env);

    let mut proofs = Vec::new(&env);
    let mut signals = Vec::new(&env);
    proofs.push_back(proof_at(&env, 0));
    signals.push_back(signals_at(&env, 0));
    assert!(verify_groth16_batch(&env, &vk, &proofs, &signals));

    // ... and a bad single-proof batch must still fail.
    let mut bad_signals = Vec::new(&env);
    let mut tampered = signals_at(&env, 0);
    tampered.set(1, tampered.get(1).unwrap().add(&U256::from_u32(&env, 1)));
    bad_signals.push_back(tampered);
    assert!(!verify_groth16_batch(&env, &vk, &proofs, &bad_signals));
}

// Under `cargo test --workspace`, feature unification pulls in the `testutils`
// stub verifier (the sibling contracts dev-depend on it), which accepts every
// proof and would invert this test. CI runs this file standalone as well, where
// the real verifier is compiled in and the test does its job.
#[cfg(not(feature = "testutils"))]
#[test]
fn one_tampered_public_signal_fails_the_whole_batch() {
    let env = Env::default();
    let (proofs, signals) = full_batch(&env);

    // Flip the nullifier of the third vote only. The other three proofs are
    // untouched and individually valid, so this is the case batching must not
    // let through.
    let mut tampered = signals.clone();
    let mut third = tampered.get(2).unwrap();
    third.set(1, third.get(1).unwrap().add(&U256::from_u32(&env, 1)));
    tampered.set(2, third);

    assert!(
        !verify_groth16_batch(&env, &vk(&env), &proofs, &tampered),
        "a batch containing one bad statement must not verify"
    );
}

// Under `cargo test --workspace`, feature unification pulls in the `testutils`
// stub verifier (the sibling contracts dev-depend on it), which accepts every
// proof and would invert this test. CI runs this file standalone as well, where
// the real verifier is compiled in and the test does its job.
#[cfg(not(feature = "testutils"))]
#[test]
fn a_forged_proof_point_fails_the_whole_batch() {
    let env = Env::default();
    let (proofs, signals) = full_batch(&env);

    // Swap proof 1's C point for proof 0's: still a valid curve point, still a
    // real proof element, but not the one that proves this statement.
    let mut tampered = proofs.clone();
    let mut swapped = tampered.get(1).unwrap();
    swapped.c = tampered.get(0).unwrap().c;
    tampered.set(1, swapped);

    assert!(
        !verify_groth16_batch(&env, &vk(&env), &tampered, &signals),
        "a batch containing a substituted proof element must not verify"
    );
}

// Under `cargo test --workspace`, feature unification pulls in the `testutils`
// stub verifier (the sibling contracts dev-depend on it), which accepts every
// proof and would invert this test. CI runs this file standalone as well, where
// the real verifier is compiled in and the test does its job.
#[cfg(not(feature = "testutils"))]
#[test]
fn proofs_paired_with_the_wrong_signals_fail() {
    // Every proof and every signal set is individually genuine; only the
    // pairing between them is wrong. A batch verifier that forgot to bind
    // proof i to signals i would pass this.
    let env = Env::default();
    let (proofs, signals) = full_batch(&env);

    let mut rotated = Vec::new(&env);
    for i in 0..signals.len() {
        rotated.push_back(signals.get((i + 1) % signals.len()).unwrap());
    }

    assert!(
        !verify_groth16_batch(&env, &vk(&env), &proofs, &rotated),
        "mismatched proof/signal pairing must not verify"
    );
}

// Under `cargo test --workspace`, feature unification pulls in the `testutils`
// stub verifier (the sibling contracts dev-depend on it), which accepts every
// proof and would invert this test. CI runs this file standalone as well, where
// the real verifier is compiled in and the test does its job.
#[cfg(not(feature = "testutils"))]
#[test]
fn a_batch_under_the_wrong_verification_key_fails() {
    let env = Env::default();
    let (proofs, signals) = full_batch(&env);

    let mut wrong = vk(&env);
    // Replace delta with gamma: a well-formed G2 point from the same key, so
    // the failure has to come from the pairing, not from deserialization.
    wrong.delta = wrong.gamma.clone();

    assert!(!verify_groth16_batch(&env, &wrong, &proofs, &signals));
}

// Under `cargo test --workspace`, feature unification pulls in the `testutils`
// stub verifier (the sibling contracts dev-depend on it), which accepts every
// proof and would invert this test. CI runs this file standalone as well, where
// the real verifier is compiled in and the test does its job.
#[cfg(not(feature = "testutils"))]
#[test]
fn duplicated_proofs_still_verify_but_do_not_hide_a_bad_one() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let vk = vk(&env);

    // The same valid vote twice is cryptographically fine — double-voting is
    // stopped by nullifier bookkeeping, not by the verifier.
    let mut proofs = Vec::new(&env);
    let mut signals = Vec::new(&env);
    for _ in 0..2 {
        proofs.push_back(proof_at(&env, 0));
        signals.push_back(signals_at(&env, 0));
    }
    assert!(verify_groth16_batch(&env, &vk, &proofs, &signals));

    // Adding a bad copy alongside good ones must still fail.
    proofs.push_back(proof_at(&env, 1));
    let mut bad = signals_at(&env, 1);
    bad.set(4, bad.get(4).unwrap().add(&U256::from_u32(&env, 1)));
    signals.push_back(bad);
    assert!(!verify_groth16_batch(&env, &vk, &proofs, &signals));
}

#[test]
fn malformed_batches_are_rejected_before_any_curve_work() {
    let env = Env::default();
    let vk = vk(&env);
    let (proofs, signals) = full_batch(&env);

    // Empty.
    assert!(!verify_groth16_batch(
        &env,
        &vk,
        &Vec::new(&env),
        &Vec::new(&env)
    ));

    // Proof count and signal-set count disagree.
    let mut short = signals.clone();
    short.pop_back();
    assert!(!verify_groth16_batch(&env, &vk, &proofs, &short));

    // Wrong number of public signals for this key.
    let mut wrong_arity = Vec::new(&env);
    for i in 0..proofs.len() {
        let mut s = signals.get(i).unwrap();
        s.pop_back();
        wrong_arity.push_back(s);
    }
    assert!(!verify_groth16_batch(&env, &vk, &proofs, &wrong_arity));
}

#[test]
fn a_signal_outside_the_scalar_field_is_rejected() {
    // Fr reduces on construction, so an unreduced signal would otherwise let
    // two different U256 values denote the same statement.
    let env = Env::default();
    let (proofs, signals) = full_batch(&env);

    let modulus = U256::from_be_bytes(
        &env,
        &soroban_sdk::Bytes::from_array(&env, &zkvote_groth16::BN254_FR_MODULUS),
    );
    let mut tampered = signals.clone();
    let mut first = tampered.get(0).unwrap();
    first.set(1, first.get(1).unwrap().add(&modulus));
    tampered.set(0, first);

    assert!(!verify_groth16_batch(&env, &vk(&env), &proofs, &tampered));
}

#[test]
fn the_transcript_and_randomizers_bind_the_whole_batch() {
    let env = Env::default();
    let vk = vk(&env);
    let (proofs, signals) = full_batch(&env);

    let transcript = batch_transcript(&env, &vk, &proofs, &signals);

    // Reordering the proofs must change the randomisers: they are derived from
    // the ordered transcript, which is what stops a prover from shuffling a bad
    // proof into a position with a convenient scalar.
    let mut reversed_proofs = Vec::new(&env);
    let mut reversed_signals = Vec::new(&env);
    for i in (0..proofs.len()).rev() {
        reversed_proofs.push_back(proofs.get(i).unwrap());
        reversed_signals.push_back(signals.get(i).unwrap());
    }
    let reversed = batch_transcript(&env, &vk, &reversed_proofs, &reversed_signals);
    assert_ne!(transcript, reversed);

    // A reordered batch of valid proofs is still valid, though.
    assert!(verify_groth16_batch(
        &env,
        &vk,
        &reversed_proofs,
        &reversed_signals
    ));

    let randomizers = batch_randomizers(&env, &transcript, proofs.len());
    assert_eq!(randomizers.len(), proofs.len());
    assert_ne!(
        randomizers,
        batch_randomizers(&env, &reversed, proofs.len()),
        "randomisers must follow the transcript"
    );
}

#[test]
fn batching_reduces_the_pairing_count_as_advertised() {
    assert_eq!(pairing_count(1), 4);
    for n in 2..=MAX_BATCH_SIZE {
        assert_eq!(pairing_count(n), n + 3);
        assert_eq!(pairings_saved(n), 3 * n - 3);
        assert!(pairing_count(n) < 4 * n);
    }
    // At the maximum batch size the pairing work is under a third of what
    // individual verification would cost.
    assert!(pairing_count(MAX_BATCH_SIZE) * 3 < 4 * MAX_BATCH_SIZE);
}

// Under `cargo test --workspace`, feature unification pulls in the `testutils`
// stub verifier (the sibling contracts dev-depend on it), which accepts every
// proof and would invert this test. CI runs this file standalone as well, where
// the real verifier is compiled in and the test does its job.
#[cfg(not(feature = "testutils"))]
#[test]
fn batching_cuts_the_metered_cpu_cost() {
    // #90 asks for a real cost reduction, so measure it with the host's own
    // meter rather than inferring it from the pairing count.
    //
    // Measured floor for a batch of four (see `batch_cost_scaling` for the
    // curve): batching must be at least 1.5x cheaper than verifying the same
    // proofs one at a time. The real figure is ~1.9x at n=4 and approaches ~2.9x
    // at n=64; the assertion is deliberately looser than the measurement so
    // host cost-model tuning does not turn this into a flaky test.
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let vk = vk(&env);
    let (proofs, signals) = full_batch(&env);
    let n = proofs.len();

    let before_batch = env.cost_estimate().budget().cpu_instruction_cost();
    assert!(verify_groth16_batch(&env, &vk, &proofs, &signals));
    let batched = env.cost_estimate().budget().cpu_instruction_cost() - before_batch;

    let before_individual = env.cost_estimate().budget().cpu_instruction_cost();
    for i in 0..n {
        assert!(verify_groth16(
            &env,
            &vk,
            &proofs.get(i).unwrap(),
            &signals.get(i).unwrap()
        ));
    }
    let individual = env.cost_estimate().budget().cpu_instruction_cost() - before_individual;

    std::println!(
        "batch of {n}: individual = {individual} cpu insns, batched = {batched}, ratio = {:.2}x",
        individual as f64 / batched as f64
    );

    assert!(
        batched * 3 < individual * 2,
        "batching {n} proofs must be at least 1.5x cheaper than verifying them \
         one by one (batched {batched} vs individual {individual})"
    );
}

/// Prints the measured cost curve across batch sizes.
///
/// Ignored by default because it runs 126 real verifications and takes several
/// seconds. Run it with:
///
/// ```text
/// cargo test -p zkvote-groth16 --test batch_verification batch_cost_scaling \
///     -- --ignored --nocapture
/// ```
#[test]
#[ignore]
fn batch_cost_scaling() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let vk = vk(&env);

    std::println!("  n | individual (cpu) |     batched (cpu) | ratio | per-proof batched");
    for n in [2usize, 4, 8, 16, 32, MAX_BATCH_SIZE as usize] {
        let mut proofs = Vec::new(&env);
        let mut signals = Vec::new(&env);
        for i in 0..n {
            // Repeating fixture proofs is a valid batch: the verifier has no
            // notion of double voting, which nullifier bookkeeping enforces.
            proofs.push_back(proof_at(&env, i % PROOFS.len()));
            signals.push_back(signals_at(&env, i % PROOFS.len()));
        }

        let before_batch = env.cost_estimate().budget().cpu_instruction_cost();
        assert!(verify_groth16_batch(&env, &vk, &proofs, &signals));
        let batched = env.cost_estimate().budget().cpu_instruction_cost() - before_batch;

        let before_individual = env.cost_estimate().budget().cpu_instruction_cost();
        for i in 0..proofs.len() {
            assert!(verify_groth16(
                &env,
                &vk,
                &proofs.get(i).unwrap(),
                &signals.get(i).unwrap()
            ));
        }
        let individual = env.cost_estimate().budget().cpu_instruction_cost() - before_individual;

        std::println!(
            "{n:3} | {individual:16} | {batched:17} | {:.2}x | {:17}",
            individual as f64 / batched as f64,
            batched / n as u64
        );
    }
}
