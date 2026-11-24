//! The verifier stub must not be reachable from any build that could deploy.
//!
//! This is a guard against a specific class of silent regression: a change that
//! makes `verify_groth16` return `true` without doing a pairing check, where the
//! whole test suite still passes because the same stub is compiled into the
//! tests. `bn254_edge_case_corpus::testutils_feature_uses_stubbed_verifier`
//! asserts the stub *does* work when the `testutils` feature is on; this file
//! asserts the complementary fact — that with default features the verifier is
//! real, demonstrated behaviourally rather than by reading a constant.
//!
//! It runs with NO features enabled, which is how a deployable build is
//! compiled. If the gate ever widens, `default_build_verifies_for_real` fails.
//!
//! The other half of the guarantee is structural and lives in CI: a
//! `--all-features` wasm build must not compile at all. See
//! `.github/workflows/ci.yml` ("Verifier stub cannot reach a wasm build").

use soroban_sdk::{BytesN, Env, Vec, U256};
use zkvote_groth16::{verifier_is_stubbed, verify_groth16, Proof, VerificationKey};

fn hex_to_bytes<const N: usize>(env: &Env, hex: &str) -> BytesN<N> {
    let bytes = hex::decode(hex).expect("invalid hex");
    assert_eq!(bytes.len(), N, "hex string wrong length");
    BytesN::from_array(env, &bytes.try_into().unwrap())
}

fn hex_str_to_u256(env: &Env, hex: &str) -> U256 {
    let bytes = hex::decode(hex).expect("invalid hex");
    let mut padded = [0u8; 32];
    let start = 32 - bytes.len();
    padded[start..].copy_from_slice(&bytes);
    U256::from_be_bytes(env, &soroban_sdk::Bytes::from_array(env, &padded))
}

fn real_proof(env: &Env) -> Proof {
    Proof {
        a: hex_to_bytes(
            env,
            "02de5951501fe4408ea8bf4960106738d190525a270fe0b035139aac2fa762302bbb2f3f1d001d99b919a34b93a9aed831e7bd1f960d5981ae328dfd1845b8a8",
        ),
        b: hex_to_bytes(
            env,
            "2a47ed5deedaad3fe569ea39131c2800f9eead79402a3fc02a6a03e8871d0ae5186d064bc81ecb41f386eb427b70f18fb42e088eb477042681fc926ce75dc4de1cb57584e640e98d0cc2a33cdfd2403bd97cd17b6018549a6c2fd34941b19f1219e3d80a0f9f99c5f74a36d2903ef10d3ba6bbb2f61e6be2072c606510f71e4d",
        ),
        c: hex_to_bytes(
            env,
            "04dac3300843dbeef12b08362d2a98110fa9080346cff63cc8698fb97d48adcb2faeacd5f1e4b5c37664f6fcb7c67ead0cd789e2db580867dcca345799517ca2",
        ),
    }
}

fn real_vk(env: &Env) -> VerificationKey {
    let mut ic = Vec::new(env);
    ic.push_back(hex_to_bytes(env, "0386c87c5f77037451fea91c60759229ca390a30e60d564e5ff0f0f95ffbd18207683040dab753f41635f947d3d13e057c73cb92a38d83400af26019ce24d54f"));
    ic.push_back(hex_to_bytes(env, "0b8de6c132c626e6aa4676f7ca94d9ebeb93375ea3584b6337f9f823ac4157dd0b3de52288f2f4473c0c5041cf9a754decd57e2c0f6b2979d3467a30570c01ea"));
    ic.push_back(hex_to_bytes(env, "139bde66aa5aa4311aca037419840a70fed606a0ed112e6686e1feb44183672d0e56114fa301c02ab1f0baac0973de2759bf26ccbbc594f8627054001f8ad27a"));
    ic.push_back(hex_to_bytes(env, "2a7f1a9e3de9411015b1c5652856bc7a467110344153252026c44ca55f5dca632f0db38e6d0268092cba5ea0b5db9610e45bd8b4aac852527aeb6323c8f09804"));
    ic.push_back(hex_to_bytes(env, "09c5b9b793a6f8098f0ac918aa0a19a75b74e7f1428f726194a48af37da8ac14122edc5b3704f106fa3c095ac74f524032e460179c3e8ecd562ef050c884336a"));
    ic.push_back(hex_to_bytes(env, "143c06565aad1cacd0ddbc0cfc6dd131c70392d29c16d8c80ed7f62ada52587b13e189e68fe2fe8806b272da3c5762a18b23680cdeda63faef014b7dd6806f21"));

    VerificationKey {
        alpha: hex_to_bytes(env, "2d4d9aa7e302d9df41749d5507949d05dbea33fbb16c643b22f599a2be6df2e214bedd503c37ceb061d8ec60209fe345ce89830a19230301f076caff004d1926"),
        beta: hex_to_bytes(env, "0967032fcbf776d1afc985f88877f182d38480a653f2decaa9794cbc3bf3060c0e187847ad4c798374d0d6732bf501847dd68bc0e071241e0213bc7fc13db7ab304cfbd1e08a704a99f5e847d93f8c3caafddec46b7a0d379da69a4d112346a71739c1b1a457a8c7313123d24d2f9192f896b7c63eea05a9d57f06547ad0cec8"),
        gamma: hex_to_bytes(env, "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c21800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa"),
        delta: hex_to_bytes(env, "0d633d289456016e0c0e975e7da2d19153ca3b6a74dd83331df6407a68d9e9f81ff0cfb2f48375ed6c03370d8a55e25777a3fb3f6c748bb9e83116bf19ef6385062ce3e273c849fdc51bb2cf34308828862f248134512541fde080ed08d0eb4016cef3c53afe73c871cd493e46139da661ed0d2875fd63c8044c38a68b4caec5"),
        ic,
    }
}

fn real_public_signals(env: &Env) -> Vec<U256> {
    let mut signals = Vec::new(env);
    signals.push_back(hex_str_to_u256(
        env,
        "1351d0946e3542884587d25ba93bdc24ad5586b76440e1c0cd7b0a04ead3b0c5",
    ));
    signals.push_back(hex_str_to_u256(
        env,
        "13a7e6da6794bd6f61ffeba529ec3f1c97c52bf862c4c63bcda069f435be8267",
    ));
    signals.push_back(U256::from_u32(env, 1));
    signals.push_back(U256::from_u32(env, 1));
    signals.push_back(U256::from_u32(env, 1));
    signals
}

/// `true` only if the verifier *accepted* the proof.
///
/// A malformed curve point makes the host's BN254 routine error out, which
/// surfaces as a panic rather than a `false` return. On chain both outcomes are
/// equivalent — the transaction fails and the vote is refused — so the
/// assertions below only distinguish "accepted" from "not accepted". The stub
/// returns `true` for every input, so it is the only way to produce a failure
/// here.
fn accepted(env: &Env, vk: &VerificationKey, proof: &Proof, signals: &Vec<U256>) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        verify_groth16(env, vk, proof, signals)
    }))
    .unwrap_or(false)
}

/// The honest case must still verify. If this fails, the verifier is not just
/// stubbed-away-badly — it is broken for real proofs.
#[test]
fn default_build_accepts_a_genuine_proof() {
    assert!(
        !verifier_is_stubbed(),
        "the verifier stub is active in a default build; a contract compiled this \
         way would accept every proof"
    );

    let env = Env::default();
    assert!(
        accepted(
            &env,
            &real_vk(&env),
            &real_proof(&env),
            &real_public_signals(&env)
        ),
        "a genuine proof must verify in a real build"
    );
}

/// The behavioural counterpart of the stub corpus test.
///
/// `testutils_feature_uses_stubbed_verifier` asserts a proof with A = 0 is
/// *Accepted* when the stub is on. Without the stub the very same proof must be
/// *Rejected* — so this cannot be satisfied by a verifier that accepts
/// everything, and cannot be satisfied by one that rejects everything (the test
/// above pins the accept side).
#[test]
fn default_build_rejects_a_forged_proof_the_stub_would_accept() {
    let env = Env::default();
    let forged = Proof {
        a: BytesN::from_array(&env, &[0u8; 64]),
        b: real_proof(&env).b,
        c: real_proof(&env).c,
    };

    assert!(
        !accepted(&env, &real_vk(&env), &forged, &real_public_signals(&env)),
        "a proof with A = 0 was accepted without the stub — the verifier is not \
         actually checking the proof"
    );
}

/// A public-signal set that does not match the VK's IC length must be rejected
/// before any pairing work.
#[test]
fn default_build_rejects_an_ic_length_mismatch() {
    let env = Env::default();
    let mut signals = real_public_signals(&env);
    signals.push_back(U256::from_u32(&env, 7));

    assert!(
        !accepted(&env, &real_vk(&env), &real_proof(&env), &signals),
        "IC length mismatch must be rejected"
    );
}

/// A tampered public signal must fail the pairing check.
#[test]
fn default_build_rejects_a_tampered_public_signal() {
    let env = Env::default();
    let mut signals = real_public_signals(&env);
    signals.set(4, U256::from_u32(&env, 2));

    assert!(
        !accepted(&env, &real_vk(&env), &real_proof(&env), &signals),
        "a tampered public signal must be rejected"
    );
}

/// A tampered proof point (single bit flip in C) must fail.
#[test]
fn default_build_rejects_a_tampered_proof() {
    let env = Env::default();
    let mut c = real_proof(&env).c.to_array();
    c[0] ^= 0x01;

    let tampered = Proof {
        a: real_proof(&env).a,
        b: real_proof(&env).b,
        c: BytesN::from_array(&env, &c),
    };

    assert!(
        !accepted(&env, &real_vk(&env), &tampered, &real_public_signals(&env)),
        "a tampered proof must be rejected"
    );
}
