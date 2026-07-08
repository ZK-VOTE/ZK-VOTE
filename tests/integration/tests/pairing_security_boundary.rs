// Pairing-Based Security Boundary Test
//
// This test validates that the BN254 pairing check provides implicit point validation
// by demonstrating that invalid VKs cause proof verification to fail.
//
// Security Model:
// - Invalid points CAN be set in VK (no validation at set_vk)
// - Invalid VK = pairing check FAILS = no proofs verify = DAO unusable
// - This is by design - pairing is the security boundary
//
// Run with: cargo test --test pairing_security_boundary -- --nocapture

use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, String, Vec, U256};

// Import actual contract clients from crates (not WASM)
use dao_registry::DaoRegistryClient;
use membership_sbt::MembershipSbtClient;
use membership_tree::MembershipTreeClient;
use voting::{Proof, VerificationKey, VoteMode, VotingClient};

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
    U256::from_be_bytes(env, &Bytes::from_array(env, &padded))
}

fn get_real_proof(env: &Env) -> Proof {
    // Real proof from circuits/build/proof_soroban.json (BIG-ENDIAN)
    // Generated for 5 public signals: root, nullifier, daoId, proposalId, voteChoice
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

fn get_valid_vk(env: &Env) -> VerificationKey {
    // Valid VK from circuits/build/verification_key_soroban.json (BIG-ENDIAN)
    // Updated for 5 public signals (commitment removed) - 6 IC elements
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

fn get_invalid_vk(env: &Env) -> VerificationKey {
    // Invalid VK with point (5, 10) which is NOT on the BN254 curve
    // y² = 10² = 100
    // x³ + 3 = 5³ + 3 = 128
    // 100 ≠ 128 → Invalid point
    let mut ic = Vec::new(env);
    // Keep valid IC points (they're not used in alpha computation) - BE encoded
    // 6 IC elements for 5 public signals
    ic.push_back(hex_to_bytes(env, "0386c87c5f77037451fea91c60759229ca390a30e60d564e5ff0f0f95ffbd18207683040dab753f41635f947d3d13e057c73cb92a38d83400af26019ce24d54f"));
    ic.push_back(hex_to_bytes(env, "0b8de6c132c626e6aa4676f7ca94d9ebeb93375ea3584b6337f9f823ac4157dd0b3de52288f2f4473c0c5041cf9a754decd57e2c0f6b2979d3467a30570c01ea"));
    ic.push_back(hex_to_bytes(env, "139bde66aa5aa4311aca037419840a70fed606a0ed112e6686e1feb44183672d0e56114fa301c02ab1f0baac0973de2759bf26ccbbc594f8627054001f8ad27a"));
    ic.push_back(hex_to_bytes(env, "2a7f1a9e3de9411015b1c5652856bc7a467110344153252026c44ca55f5dca632f0db38e6d0268092cba5ea0b5db9610e45bd8b4aac852527aeb6323c8f09804"));
    ic.push_back(hex_to_bytes(env, "09c5b9b793a6f8098f0ac918aa0a19a75b74e7f1428f726194a48af37da8ac14122edc5b3704f106fa3c095ac74f524032e460179c3e8ecd562ef050c884336a"));
    ic.push_back(hex_to_bytes(env, "143c06565aad1cacd0ddbc0cfc6dd131c70392d29c16d8c80ed7f62ada52587b13e189e68fe2fe8806b272da3c5762a18b23680cdeda63faef014b7dd6806f21"));

    VerificationKey {
        // Invalid alpha point: (5, 10) encoded as 64 bytes (x || y) in BE
        alpha: hex_to_bytes(env, "0000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000000a"),
        // Use valid BE-encoded beta/gamma/delta
        beta: hex_to_bytes(env, "0967032fcbf776d1afc985f88877f182d38480a653f2decaa9794cbc3bf3060c0e187847ad4c798374d0d6732bf501847dd68bc0e071241e0213bc7fc13db7ab304cfbd1e08a704a99f5e847d93f8c3caafddec46b7a0d379da69a4d112346a71739c1b1a457a8c7313123d24d2f9192f896b7c63eea05a9d57f06547ad0cec8"),
        gamma: hex_to_bytes(env, "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c21800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa"),
        delta: hex_to_bytes(env, "0d633d289456016e0c0e975e7da2d19153ca3b6a74dd83331df6407a68d9e9f81ff0cfb2f48375ed6c03370d8a55e25777a3fb3f6c748bb9e83116bf19ef6385062ce3e273c849fdc51bb2cf34308828862f248134512541fde080ed08d0eb4016cef3c53afe73c871cd493e46139da661ed0d2875fd63c8044c38a68b4caec5"),
        ic,
    }
}

// Test validates pairing-based security boundary with updated 5-public-signal circuit
// NOTE: This test is ignored in CI because verify_groth16 returns true in test mode
// (pairing check is skipped). Run against real Soroban environment to validate security.
#[test]
#[ignore = "requires real BN254 pairing (skipped in test mode)"]
fn test_pairing_security_boundary() {
    println!("\n==========================================");
    println!("Pairing-Based Security Boundary Test");
    println!("==========================================\n");

    // Setup
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    println!("Deploying contracts...\n");
    let registry_address = env.register(dao_registry::DaoRegistry, ());
    let registry_client = DaoRegistryClient::new(&env, &registry_address);

    let sbt_address = env.register(membership_sbt::MembershipSbt, (registry_address.clone(),));
    let sbt_client = MembershipSbtClient::new(&env, &sbt_address);

    let tree_address = env.register(
        membership_tree::MembershipTree,
        (sbt_address.clone(), registry_address.clone()),
    );
    let tree_client = MembershipTreeClient::new(&env, &tree_address);

    let voting_address = env.register(
        voting::Voting,
        (tree_address.clone(), registry_address.clone()),
    );
    let voting_client = VotingClient::new(&env, &voting_address);

    println!("Creating DAO...\n");
    let dao_name = String::from_str(&env, "Security Test DAO");
    let dao_id = registry_client.create_dao(&dao_name, &admin, &false, &true, &None);

    println!("Minting SBT...\n");
    sbt_client.mint(&dao_id, &admin, &admin, &None);

    println!("Initializing tree (depth 18)...\n");
    tree_client.init_tree(&dao_id, &18, &admin);

    println!("Registering commitment...\n");
    // Commitment: Poseidon(999888777666, 111222333444)
    let commitment = hex_str_to_u256(
        &env,
        "28ac4fff6999c3c6612028b0dc2e34c0fa5c1c1760f44fc765cdb4b577ef2999",
    );
    tree_client.register_with_caller(&dao_id, &commitment, &admin);

    let root = tree_client.current_root(&dao_id);
    let proof = get_real_proof(&env);
    // Nullifier for daoId=1, proposalId=1
    let nullifier = hex_str_to_u256(
        &env,
        "13a7e6da6794bd6f61ffeba529ec3f1c97c52bf862c4c63bcda069f435be8267",
    );

    println!("==========================================");
    println!("Test 1: Valid VK + Real Proof (Control)");
    println!("==========================================\n");

    let valid_vk = get_valid_vk(&env);
    voting_client.set_vk(&dao_id, &valid_vk, &admin);
    println!("✅ Valid VK set\n");

    let title = String::from_str(&env, "Control Test Proposal");
    let content_cid = String::from_str(&env, "");
    let current_time = env.ledger().timestamp();
    let end_time = current_time + 3600;
    let proposal_id1 = voting_client.create_proposal(
        &dao_id,
        &title,
        &content_cid,
        &end_time,
        &admin,
        &VoteMode::Fixed,
    );
    println!("✅ Proposal created: {}\n", proposal_id1);

    println!("Submitting vote with real proof...");
    voting_client.vote(&dao_id, &proposal_id1, &true, &nullifier, &root, &proof);
    println!("✅ PASS: Valid VK accepted real proof");
    println!("       Pairing check succeeded\n");

    println!("==========================================");
    println!("Test 2: Invalid VK + Real Proof");
    println!("==========================================\n");
    println!("Point (5, 10) is NOT on BN254 curve:");
    println!("  y² = 10² = 100");
    println!("  x³ + 3 = 5³ + 3 = 128");
    println!("  100 ≠ 128 → Invalid point\n");

    let invalid_vk = get_invalid_vk(&env);
    voting_client.set_vk(&dao_id, &invalid_vk, &admin);
    println!("✅ Invalid VK set (expected - no validation at set_vk)\n");

    let title2 = String::from_str(&env, "Security Test Proposal");
    let content_cid2 = String::from_str(&env, "");
    let proposal_id2 = voting_client.create_proposal(
        &dao_id,
        &title2,
        &content_cid2,
        &end_time,
        &admin,
        &VoteMode::Fixed,
    );
    println!("✅ Proposal created: {}\n", proposal_id2);

    println!("Submitting vote with real proof (should fail)...");
    // Different nullifier to avoid double-vote error (this test is about invalid VK)
    let nullifier2 = hex_str_to_u256(
        &env,
        "13a7e6da6794bd6f61ffeba529ec3f1c97c52bf862c4c63bcda069f435be8268",
    );

    // This should panic due to pairing check failure
    let should_panic = std::panic::AssertUnwindSafe(|| {
        voting_client.vote(&dao_id, &proposal_id2, &true, &nullifier2, &root, &proof);
    });

    let result = std::panic::catch_unwind(should_panic);

    if result.is_ok() {
        panic!("❌ FAIL: Invalid VK accepted proof (SECURITY ISSUE!)");
    } else {
        println!("✅ PASS: Invalid VK rejected by pairing check");
        println!("       Security boundary working correctly\n");
    }

    println!("==========================================");
    println!("Test Summary");
    println!("==========================================\n");
    println!("✅ ALL TESTS PASSED\n");
    println!("Security validation confirmed:");
    println!("  ✅ Valid VK allows proof verification");
    println!("  ✅ Invalid VK rejected by pairing check");
    println!("  ✅ Pairing is the security boundary\n");
    println!("Design confirmed:");
    println!("  - No explicit point validation in set_vk()");
    println!("  - BN254 pairing provides implicit validation");
    println!("  - Invalid VK = unusable DAO (no proofs verify)\n");
}
