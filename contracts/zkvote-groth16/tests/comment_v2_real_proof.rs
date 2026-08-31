//! Real end-to-end Groth16 verification of a `comment_v2.circom` proof (#349).
//!
//! Unlike `bn254_edge_case_corpus.rs`'s hand-crafted curve points, every value
//! here comes from a genuine toolchain run against the *fixed* circuit
//! (comment_v2.circom's `template CommentV2(levels) {` line had been deleted
//! by a botched find/replace, and did not compile until this PR):
//!
//!   circom comment_v2.circom --r1cs --wasm
//!   snarkjs groth16 setup comment_v2.r1cs powersOfTau15_final.ptau comment_v2_0000.zkey
//!   snarkjs zkey contribute comment_v2_0000.zkey comment_v2_final.zkey
//!   snarkjs zkey export verificationkey comment_v2_final.zkey verification_key.json
//!   node generate_witness.js comment_v2.wasm input.json witness.wtns
//!   snarkjs groth16 prove comment_v2_final.zkey witness.wtns proof.json public.json
//!   snarkjs groth16 verify verification_key.json public.json proof.json   # => OK!
//!
//! `circuits/convert_vkey_to_soroban_be.js` / `convert_proof_to_soroban_be.js`
//! (this repo's existing snarkjs->Soroban conversion scripts, used unmodified)
//! turned the resulting JSON into the big-endian byte layout below.
//!
//! This test calls the *public* `verify_groth16`, not `verify_groth16_impl`
//! directly, and this file is compiled as a separate integration-test crate
//! (no `--features testutils`), so `#[cfg(any(test, feature = "testutils"))]`
//! in `verify_groth16` does NOT apply here — it exercises the real
//! `verify_groth16_impl::<Bn254Curve>` BN254 pairing check, the same one
//! `contracts/comments/` and `contracts/voting/` call in production. A CI
//! step already runs this file's sibling (`bn254_edge_case_corpus.rs`)
//! without `--features testutils` for exactly this reason ("Groth16
//! production edge corpus"); this test should run the same way.

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use soroban_sdk::{Bytes, BytesN, Env, Vec, U256};
use std::str::FromStr;
use zkvote_groth16::{verify_groth16, Proof, VerificationKey};

fn hex_to_bytes<const N: usize>(env: &Env, hex: &str) -> BytesN<N> {
    let bytes = hex::decode(hex).expect("invalid hex");
    assert_eq!(bytes.len(), N, "hex string wrong length");
    BytesN::from_array(env, &bytes.try_into().unwrap())
}

/// Public signals are BN254 scalar-field elements; snarkjs prints them as
/// plain decimal strings. Route through `ark_bn254::Fr` (already a
/// dev-dependency here, same as `bn254_edge_case_corpus.rs`'s Fq/Fr usage)
/// rather than adding a bignum crate just for decimal parsing.
fn dec_str_to_u256(env: &Env, dec: &str) -> U256 {
    let fr = Fr::from_str(dec).expect("invalid decimal field element");
    let bytes = fr.into_bigint().to_bytes_be();
    let mut padded = [0u8; 32];
    padded[32 - bytes.len()..].copy_from_slice(&bytes);
    U256::from_be_bytes(env, &Bytes::from_array(env, &padded))
}

/// The verification key snarkjs produced for the fixed comment_v2.circom,
/// converted to Soroban's big-endian byte layout by
/// `circuits/convert_vkey_to_soroban_be.js` (unmodified, existing tooling).
fn comment_v2_vk(env: &Env) -> VerificationKey {
    let mut ic = Vec::new(env);
    ic.push_back(hex_to_bytes(env, "04a4bcd10d1057fa8bd023492c3616ace2fa66adb5e13db8eacd4c549197e20417bf1028cf21368821385bfa5542eff606ba8ed6e8993c77e317c1d376777d0e"));
    ic.push_back(hex_to_bytes(env, "2f49c366de752904758f5c0f805d3a8a95024d08709d2185f85ace44a1efdb480e79a947b8328263acfcd0e935574cbdf19b30c21de971f04e089c25177c20e9"));
    ic.push_back(hex_to_bytes(env, "1a7b8d39c400f806c26773d17a325d0059b79ba7d448b8c6233f05a944b13e792ee07630ee92158b8cef5e14e61cc8c6a6581d8e8a26fa8ca994bb0431491f3e"));
    ic.push_back(hex_to_bytes(env, "27e155f4d936d840d3a5689117c38d102205fa53f561043b5b398c69a7c27fff0ab0d94ad33b1d1a000a30f42696b426a19e325b58e0e991a0873c21fd665fca"));
    ic.push_back(hex_to_bytes(env, "2299a882fa4bc600d9703f8dfabb743de19f1e86b0c57addf437ccde5e341f660b9f47af9516eda886ac7e01dbd28352cd8a05769b4b05a884ddf279f27ba795"));
    ic.push_back(hex_to_bytes(env, "0660284e8a995a6e71f789b2e5759680280b97681d60c274b103d0d8beec22b81a34f31e419ffec1c9f941de124285690be4f15de3b9c2dd0928647dbdb51335"));
    ic.push_back(hex_to_bytes(env, "2028288dddf009c64c5baf22f7a20727545b26cf0e0b112d9dbb81677159cabf0635f157002aa0ff9d35f4a36ad9c7f0de62828b4f56bf33af7dba274f358308"));
    ic.push_back(hex_to_bytes(env, "2da99a65bc47d39f197984f48edadc6c501992e6b3d66f18e5acaaca613fb8ef10bc013910d8196ed69583916e3e625e65092d0aaf17d5a72b1891016f35b136"));

    VerificationKey {
        alpha: hex_to_bytes(env, "0dce85ea741d0742bc05b7aea215a61a5271058a733f31be5dea090b7f17a42614a961f0572933c659371f7ce1d15717d543e6ed656a6cce30e227fc5cef908d"),
        beta: hex_to_bytes(env, "063b17221a88a617899008f46c5c5ed331f1e7513602abc1643820e78aa1464405821c78deadeb64de97b295c5a7719966c6591be6309b5a043e61465f675f100b1ebf2b82a67b4f5312f1fca2756fdab7dfdab67c2d15459740fcba33133cff05329f99775260b559bd563e4fcc5572fb6d68b42041103e8fc9539e14658086"),
        gamma: hex_to_bytes(env, "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c21800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa"),
        delta: hex_to_bytes(env, "0a590e94f03085db8e777eb3f41e287fddcdfd50b033b68aad35e3e4c12f1add1c09aeaef2f2f4068bb9444ba9026fffa7c0d4a3f8a84ee31ce90ca940b4e4fb1d077785456d89938b20b73aef152b73938de260a49b1f76c0b2385cf12c8e6309ef6b3b9326876d8817aec75a19f295c42f3dd628a67b44a0d4c46c367d0153"),
        ic,
    }
}

fn comment_v2_proof(env: &Env) -> Proof {
    Proof {
        a: hex_to_bytes(env, "06bc7ac89991d283d1aba5aecead26465ef57afefb8b1ecb8883a23386226d0d10c45024948d4763981da581b2a57a9dc970e8d7e5f41ea739f5489c09d672fd"),
        b: hex_to_bytes(env, "0c6737c3025af7d1714f1c9d30ec07c0398fa04e502a1eebc6abe9dbfcde242c17901e13619411fa405f205a5b6911271a829dd9ffbb82cc3cbad2b723763e360eb7e82f98b35377a04b4ff9024e679e6a5d48031332ce95345ceee0a8319f29303ea18c4b1e69bbc7c8b9ac2b8bc54c09f8da64069bf27a9948ca4e2ea14b87"),
        c: hex_to_bytes(env, "0c8329caf463c89bd286539013511db465b51f51b3a8681451e43db44adb7b431d05df37088acc0d3d81686b0ba540bc0484d46568393b2bce1b951e4708be34"),
    }
}

/// Matches comment_v2.circom's public signal order exactly:
/// [root, nullifier, daoId, proposalId, commentNonce, commitment, parentCommentId]
fn comment_v2_public_signals(env: &Env) -> Vec<U256> {
    let mut signals = Vec::new(env);
    signals.push_back(dec_str_to_u256(
        env,
        "19063480543795569527505138411558310026629493034983856872392401708979397511231",
    )); // root
    signals.push_back(dec_str_to_u256(
        env,
        "2641947707251819469292908877104203068915413249083212250229775202645667013128",
    )); // nullifier
    signals.push_back(dec_str_to_u256(env, "1")); // daoId
    signals.push_back(dec_str_to_u256(env, "7")); // proposalId
    signals.push_back(dec_str_to_u256(env, "0")); // commentNonce
    signals.push_back(dec_str_to_u256(
        env,
        "12397843381798721067942805681421301491944795159742201171500746705812274464951",
    )); // commitment
    signals.push_back(dec_str_to_u256(env, "0")); // parentCommentId
    signals
}

#[test]
fn comment_v2_real_proof_verifies() {
    let env = Env::default();
    let vk = comment_v2_vk(&env);
    let proof = comment_v2_proof(&env);
    let public_signals = comment_v2_public_signals(&env);

    assert_eq!(
        public_signals.len() as usize + 1,
        vk.ic.len() as usize,
        "IC length must be public_signals.len() + 1, matching comment_v2.circom's \
         7 public signals",
    );

    assert!(
        verify_groth16(&env, &vk, &proof, &public_signals),
        "a real comment_v2.circom Groth16 proof must verify against its own \
         verification key through the exact production BN254 pairing path"
    );
}

// Under `cargo test --workspace`, feature unification pulls in the `testutils`
// stub verifier (the sibling contracts dev-depend on it), which accepts any
// proof. Guarding the negative test the same way `bn254_edge_case_corpus.rs`
// does keeps it meaningful instead of silently inverted.
#[test]
#[cfg(not(feature = "testutils"))]
fn comment_v2_real_proof_rejects_a_tampered_public_signal() {
    let env = Env::default();
    let vk = comment_v2_vk(&env);
    let proof = comment_v2_proof(&env);
    let mut public_signals = comment_v2_public_signals(&env);

    // Flip the nullifier: the proof was generated for a different nullifier,
    // so it must not verify against this modified statement.
    let tampered_nullifier = public_signals.get(1).unwrap().add(&U256::from_u32(&env, 1));
    public_signals.set(1, tampered_nullifier);

    assert!(
        !verify_groth16(&env, &vk, &proof, &public_signals),
        "a proof must not verify against a public-signal set it wasn't generated for"
    );
}

#[test]
fn comment_v2_real_proof_rejects_a_mismatched_signal_count() {
    // Simulates the exact structural check contracts/comments/lib.rs and
    // contracts/voting/lib.rs rely on before ever reaching curve arithmetic:
    // a caller that assembles a comment_v2-shaped pub_signals vector against
    // a VK from a *different* circuit (e.g. vote.circom's 6-signal VK,
    // matching the [root, nullifier, daoId, proposalId, voteChoice] shape
    // contracts/comments/lib.rs's add_anonymous_comment() currently builds)
    // must be rejected outright, not silently coerced.
    let env = Env::default();
    let vk = comment_v2_vk(&env); // expects 7 signals (ic.len() == 8)
    let proof = comment_v2_proof(&env);
    let mut public_signals = comment_v2_public_signals(&env);
    public_signals.pop_back(); // now only 6 signals, like add_anonymous_comment builds today

    assert!(
        !verify_groth16(&env, &vk, &proof, &public_signals),
        "a signal-count mismatch must fail the IC-length check before any pairing work"
    );
}
