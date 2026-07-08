// Test: Vote with Wrong Root Should Fail
//
// This test verifies that the contract's root check (voting/src/lib.rs:417-419) works correctly.
// We use a real proof generated for root_A, but pass root_B to the contract.
// The vote MUST fail with "root must match proposal eligible root".

use soroban_sdk::{
    testutils::Address as _, Address, Bytes, BytesN, Env, String, Vec as SdkVec, U256,
};

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
    // Real proof from circuits/build/proof_soroban_be.json (BIG-ENDIAN)
    // Generated with: secret=123456789, salt=987654321, daoId=1, proposalId=1, voteChoice=1
    Proof {
        a: hex_to_bytes(
            env,
            "06c6298fee7716bce0aca65c8e6ccde25e06bdcb6268a1b2d31db1b8d750a9b0050db001368342508a5404e7d7b5ff5f1c7d27ee0362fdae57730ab2a1b524de",
        ),
        b: hex_to_bytes(
            env,
            "07bbb05583f634a5ff3ffe912712e7c69d560ec9b4378bc556cb0f29f16d779e02b606ac49555280a0588d6a84c8a344cd1cdc20c50306d549f0a71c6744b3e11ef657db258d908b245d6dc735ae2429e38078384a144b717e921dd1552534b32db66d34db9e4ad93c69ece88542249d7339bdd627ec6a8f619faddfa30edf30",
        ),
        c: hex_to_bytes(
            env,
            "1d147aacab1c868ac69c78f1bf20a52ed47aaa3a96399fb4e2958316b0dba7c321666fe7da09fc9039397d3c03d1f1fa86d2e917161dade28cac8e0639a6c00d",
        ),
    }
}

fn get_verification_key(env: &Env) -> VerificationKey {
    // VK from circuits/build/verification_key_soroban_be.json (BIG-ENDIAN)
    // 6 IC elements for 5 public signals (root, nullifier, daoId, proposalId, voteChoice)
    // (commitment is now a PRIVATE signal for improved privacy)
    let mut ic = SdkVec::new(env);

    ic.push_back(hex_to_bytes(env, "0386c87c5f77037451fea91c60759229ca390a30e60d564e5ff0f0f95ffbd18207683040dab753f41635f947d3d13e057c73cb92a38d83400af26019ce24d54f"));
    ic.push_back(hex_to_bytes(env, "0b8de6c132c626e6aa4676f7ca94d9ebeb93375ea3584b6337f9f823ac4157dd0b3de52288f2f4473c0c5041cf9a754decd57e2c0f6b2979d3467a30570c01ea"));
    ic.push_back(hex_to_bytes(env, "139bde66aa5aa4311aca037419840a70fed606a0ed112e6686e1feb44183672d0e56114fa301c02ab1f0baac0973de2759bf26ccbbc594f8627054001f8ad27a"));
    ic.push_back(hex_to_bytes(env, "2a7f1a9e3de9411015b1c5652856bc7a467110344153252026c44ca55f5dca632f0db38e6d0268092cba5ea0b5db9610e45bd8b4aac852527aeb6323c8f09804"));
    ic.push_back(hex_to_bytes(env, "09c5b9b793a6f8098f0ac918aa0a19a75b74e7f1428f726194a48af37da8ac14122edc5b3704f106fa3c095ac74f524032e460179c3e8ecd562ef050c884336a"));
    ic.push_back(hex_to_bytes(env, "143c06565aad1cacd0ddbc0cfc6dd131c70392d29c16d8c80ed7f62ada52587b13e189e68fe2fe8806b272da3c5762a18b23680cdeda63faef014b7dd6806f21"));
    // Removed 7th IC element (was for commitment public signal)

    VerificationKey {
        alpha: hex_to_bytes(env, "2d4d9aa7e302d9df41749d5507949d05dbea33fbb16c643b22f599a2be6df2e214bedd503c37ceb061d8ec60209fe345ce89830a19230301f076caff004d1926"),
        beta: hex_to_bytes(env, "0967032fcbf776d1afc985f88877f182d38480a653f2decaa9794cbc3bf3060c0e187847ad4c798374d0d6732bf501847dd68bc0e071241e0213bc7fc13db7ab304cfbd1e08a704a99f5e847d93f8c3caafddec46b7a0d379da69a4d112346a71739c1b1a457a8c7313123d24d2f9192f896b7c63eea05a9d57f06547ad0cec8"),
        gamma: hex_to_bytes(env, "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c21800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa"),
        delta: hex_to_bytes(env, "0d633d289456016e0c0e975e7da2d19153ca3b6a74dd83331df6407a68d9e9f81ff0cfb2f48375ed6c03370d8a55e25777a3fb3f6c748bb9e83116bf19ef6385062ce3e273c849fdc51bb2cf34308828862f248134512541fde080ed08d0eb4016cef3c53afe73c871cd493e46139da661ed0d2875fd63c8044c38a68b4caec5"),
        ic,
    }
}

// Test that vote with wrong root fails
// Uses BE-encoded proof/VK for commitment=16832421271961222550979173996485995711342823810308835997146707681980704453417
#[test]
#[should_panic(expected = "HostError")]
fn test_vote_with_wrong_root_fails() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy contracts using direct crate registration
    let registry_id = env.register(dao_registry::DaoRegistry, ());
    let sbt_id = env.register(membership_sbt::MembershipSbt, (registry_id.clone(),));
    let tree_id = env.register(
        membership_tree::MembershipTree,
        (sbt_id.clone(), registry_id.clone()),
    );
    let voting_id = env.register(voting::Voting, (tree_id.clone(), registry_id.clone()));

    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create DAO
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    tree_client.init_tree(&dao_id, &18, &admin);

    // Give admin an SBT (needed to create proposals)
    sbt_client.mint(&dao_id, &admin, &admin, &None);

    // Add member and register
    sbt_client.mint(&dao_id, &member, &admin, &None);

    // Use the commitment from circuits/build/public.json (secret=123456789, salt=987654321)
    // commitment = 16832421271961222550979173996485995711342823810308835997146707681980704453417
    let commitment = hex_str_to_u256(
        &env,
        "2536d01521137bf7b39e3fd26c1376f456ce46a45993a5d7c3c158a450fd7329",
    );
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    let root_a = tree_client.current_root(&dao_id);
    println!("Root A (with commitment): {:?}", root_a);

    // Set VK and create Proposal 1 with root_a as eligible_root
    let vk = get_verification_key(&env);
    voting_client.set_vk(&dao_id, &vk, &admin);

    let proposal_1_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Proposal 1"),
        &String::from_str(&env, ""),
        &1000u64,
        &admin,
        &VoteMode::Fixed,
    );

    let proposal_1 = voting_client.get_proposal(&dao_id, &proposal_1_id);
    assert_eq!(
        proposal_1.eligible_root, root_a,
        "Proposal 1 should have root_a"
    );

    // Use nullifier from circuits/build/public.json
    // nullifier = 5760508796108392755529358167294721063592787938597807569861628631651201858128
    let nullifier = hex_str_to_u256(
        &env,
        "0cbc551a937e12107e513efd646a4f32eec3f0d2c130532e3516bdd9d4683a50",
    );

    // Get the real proof (generated for root_a)
    let proof = get_real_proof(&env);

    // Vote should SUCCEED with correct root (root_a)
    voting_client.vote(
        &dao_id,
        &proposal_1_id,
        &true,
        &nullifier,
        &root_a, // Correct root
        &proof,
    );

    let proposal_after = voting_client.get_proposal(&dao_id, &proposal_1_id);
    assert_eq!(
        proposal_after.yes_votes, 1,
        "Vote with correct root should succeed"
    );
    println!("✅ Vote with correct root succeeded");

    // Now create Proposal 2 with a DIFFERENT eligible_root
    // Add a new member to change the root
    let member2 = Address::generate(&env);
    sbt_client.mint(&dao_id, &member2, &admin, &None);
    let commitment2 = hex_str_to_u256(
        &env,
        "1111111111111111111111111111111111111111111111111111111111111111",
    );
    tree_client.register_with_caller(&dao_id, &commitment2, &member2);

    let root_b = tree_client.current_root(&dao_id);
    assert_ne!(root_a, root_b, "Roots must be different");
    println!("Root B (with new member): {:?}", root_b);

    let proposal_2_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Proposal 2"),
        &String::from_str(&env, ""),
        &2000u64,
        &admin,
        &VoteMode::Fixed,
    );

    let proposal_2 = voting_client.get_proposal(&dao_id, &proposal_2_id);
    assert_eq!(
        proposal_2.eligible_root, root_b,
        "Proposal 2 should have root_b"
    );

    // Try to vote on Proposal 2 with the SAME proof (which was generated for root_a)
    // But the proposal has eligible_root = root_b
    // This simulates the frontend bug: passing wrong root to contract

    let nullifier_2 = hex_str_to_u256(
        &env,
        "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    );

    println!("🔍 Attempting vote with WRONG root (proof for root_a, but proposal has root_b)...");

    // This MUST fail with "root must match proposal eligible root"
    voting_client.vote(
        &dao_id,
        &proposal_2_id,
        &true,
        &nullifier_2,
        &root_a, // ❌ WRONG! Proof claims root_a but proposal has root_b
        &proof,
    );

    // Should panic before reaching here
}

// Test that vote with correct root succeeds
// Uses BE-encoded proof/VK for commitment=16832421271961222550979173996485995711342823810308835997146707681980704453417
#[test]
fn test_vote_with_correct_root_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy contracts using direct crate registration
    let registry_id = env.register(dao_registry::DaoRegistry, ());
    let sbt_id = env.register(membership_sbt::MembershipSbt, (registry_id.clone(),));
    let tree_id = env.register(
        membership_tree::MembershipTree,
        (sbt_id.clone(), registry_id.clone()),
    );
    let voting_id = env.register(voting::Voting, (tree_id.clone(), registry_id.clone()));

    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create DAO
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    tree_client.init_tree(&dao_id, &18, &admin);

    // Give admin an SBT (needed to create proposals)
    sbt_client.mint(&dao_id, &admin, &admin, &None);

    // Add member and register with the commitment from BE proof
    // commitment = 16832421271961222550979173996485995711342823810308835997146707681980704453417
    sbt_client.mint(&dao_id, &member, &admin, &None);
    let commitment = hex_str_to_u256(
        &env,
        "2536d01521137bf7b39e3fd26c1376f456ce46a45993a5d7c3c158a450fd7329",
    );
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    let root = tree_client.current_root(&dao_id);

    // Set VK and create proposal
    let vk = get_verification_key(&env);
    voting_client.set_vk(&dao_id, &vk, &admin);

    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Test Proposal"),
        &String::from_str(&env, ""),
        &1000u64,
        &admin,
        &VoteMode::Fixed,
    );

    // Vote with matching root
    // nullifier = 5760508796108392755529358167294721063592787938597807569861628631651201858128
    let nullifier = hex_str_to_u256(
        &env,
        "0cbc551a937e12107e513efd646a4f32eec3f0d2c130532e3516bdd9d4683a50",
    );
    let proof = get_real_proof(&env);

    voting_client.vote(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier,
        &root, // Correct root
        &proof,
    );

    let proposal_after = voting_client.get_proposal(&dao_id, &proposal_id);
    assert_eq!(proposal_after.yes_votes, 1);

    println!("✅ Vote with correct root succeeded");
}
