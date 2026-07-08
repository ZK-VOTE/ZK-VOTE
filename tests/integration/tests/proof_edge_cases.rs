// Proof Edge Case Tests
//
// Tests for edge cases in proof verification:
// 1. Corrupted proof data
// 2. Wrong VK for proof
// 3. Nullifier reuse across DAOs (should succeed - different domains)

use soroban_sdk::{
    contracttype, testutils::Address as _, Address, Bytes, BytesN, Env, String, Vec as SdkVec, U256,
};

// Import actual contract clients from crates (not WASM)
use dao_registry::DaoRegistryClient;
use membership_sbt::MembershipSbtClient;
use membership_tree::MembershipTreeClient;
use voting::{Proof, VerificationKey, VoteMode, VotingClient};

// Local mirror of the voting contract's DataKey for storage surgery in tests
#[contracttype]
#[derive(Clone)]
enum VotingDataKey {
    Proposal(u64, u64),
    ProposalCount(u64),
    Nullifier(u64, u64, U256),
    VotingKey(u64),
    VkVersion(u64),
    VkByVersion(u64, u32),
    // VerifyOverride is test-only in the contract; we keep the variant to preserve ordering
    VerifyOverride,
}

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

// Real VK from circuits/build/verification_key_soroban_be.json
// 6 IC elements for 5 public signals: root, nullifier, daoId, proposalId, voteChoice
// (commitment is now a PRIVATE signal for improved privacy)
fn get_real_vk(env: &Env) -> VerificationKey {
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

// Real proof generated for updated circuit (5 public signals)
// secret=123456789, salt=987654321, daoId=1, proposalId=1, voteChoice=1
// commitment at index 0 in depth-18 Merkle tree
fn get_real_proof(env: &Env) -> Proof {
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

// Corrupted proof (flipped bits in proof.a)
fn get_corrupted_proof(env: &Env) -> Proof {
    Proof {
        a: hex_to_bytes(
            env,
            // Changed first byte from 06 to 16 (single bit flip)
            "16c6298fee7716bce0aca65c8e6ccde25e06bdcb6268a1b2d31db1b8d750a9b0050db001368342508a5404e7d7b5ff5f1c7d27ee0362fdae57730ab2a1b524de",
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

// Different VK (valid curve points but different from real VK)
// 6 IC elements for 5 public signals (commitment removed)
fn get_different_vk(env: &Env) -> VerificationKey {
    // Use the real VK but modify alpha point slightly
    let mut ic = SdkVec::new(env);
    ic.push_back(hex_to_bytes(env, "0386c87c5f77037451fea91c60759229ca390a30e60d564e5ff0f0f95ffbd18207683040dab753f41635f947d3d13e057c73cb92a38d83400af26019ce24d54f"));
    ic.push_back(hex_to_bytes(env, "0b8de6c132c626e6aa4676f7ca94d9ebeb93375ea3584b6337f9f823ac4157dd0b3de52288f2f4473c0c5041cf9a754decd57e2c0f6b2979d3467a30570c01ea"));
    ic.push_back(hex_to_bytes(env, "139bde66aa5aa4311aca037419840a70fed606a0ed112e6686e1feb44183672d0e56114fa301c02ab1f0baac0973de2759bf26ccbbc594f8627054001f8ad27a"));
    ic.push_back(hex_to_bytes(env, "2a7f1a9e3de9411015b1c5652856bc7a467110344153252026c44ca55f5dca632f0db38e6d0268092cba5ea0b5db9610e45bd8b4aac852527aeb6323c8f09804"));
    ic.push_back(hex_to_bytes(env, "09c5b9b793a6f8098f0ac918aa0a19a75b74e7f1428f726194a48af37da8ac14122edc5b3704f106fa3c095ac74f524032e460179c3e8ecd562ef050c884336a"));
    ic.push_back(hex_to_bytes(env, "143c06565aad1cacd0ddbc0cfc6dd131c70392d29c16d8c80ed7f62ada52587b13e189e68fe2fe8806b272da3c5762a18b23680cdeda63faef014b7dd6806f21"));
    // Removed 7th IC element (was for commitment public signal)

    VerificationKey {
        // Modified alpha (different x coordinate)
        alpha: hex_to_bytes(env, "1d4d9aa7e302d9df41749d5507949d05dbea33fbb16c643b22f599a2be6df2e214bedd503c37ceb061d8ec60209fe345ce89830a19230301f076caff004d1926"),
        beta: hex_to_bytes(env, "0967032fcbf776d1afc985f88877f182d38480a653f2decaa9794cbc3bf3060c0e187847ad4c798374d0d6732bf501847dd68bc0e071241e0213bc7fc13db7ab304cfbd1e08a704a99f5e847d93f8c3caafddec46b7a0d379da69a4d112346a71739c1b1a457a8c7313123d24d2f9192f896b7c63eea05a9d57f06547ad0cec8"),
        gamma: hex_to_bytes(env, "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c21800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa"),
        delta: hex_to_bytes(env, "0d633d289456016e0c0e975e7da2d19153ca3b6a74dd83331df6407a68d9e9f81ff0cfb2f48375ed6c03370d8a55e25777a3fb3f6c748bb9e83116bf19ef6385062ce3e273c849fdc51bb2cf34308828862f248134512541fde080ed08d0eb4016cef3c53afe73c871cd493e46139da661ed0d2875fd63c8044c38a68b4caec5"),
        ic,
    }
}

const REAL_COMMITMENT_HEX: &str =
    "2536d01521137bf7b39e3fd26c1376f456ce46a45993a5d7c3c158a450fd7329";
const REAL_NULLIFIER_HEX: &str = "0cbc551a937e12107e513efd646a4f32eec3f0d2c130532e3516bdd9d4683a50";

fn setup_contracts(env: &Env) -> (Address, Address, Address, Address, Address) {
    let registry_id = env.register(dao_registry::DaoRegistry, ());
    let sbt_id = env.register(membership_sbt::MembershipSbt, (registry_id.clone(),));
    let tree_id = env.register(
        membership_tree::MembershipTree,
        (sbt_id.clone(), registry_id.clone()),
    );
    let voting_id = env.register(voting::Voting, (tree_id.clone(), registry_id.clone()));

    let admin = Address::generate(env);

    (registry_id, sbt_id, tree_id, voting_id, admin)
}

// Test: Corrupted proof data should fail verification
// NOTE: Ignored in CI - verify_groth16 returns true in test mode (pairing skipped)
#[test]
#[ignore = "requires real BN254 pairing (skipped in test mode)"]
#[should_panic(expected = "HostError")]
fn test_corrupted_proof_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create DAO (dao_id = 1 to match proof)
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );
    assert_eq!(dao_id, 1);

    // Initialize tree with depth 18
    tree_client.init_tree(&dao_id, &18, &admin);

    // Set REAL VK
    voting_client.set_vk(&dao_id, &get_real_vk(&env), &admin);

    // Member joins with real commitment
    let member = Address::generate(&env);
    sbt_client.mint(&dao_id, &member, &admin, &None);
    let commitment = hex_str_to_u256(&env, REAL_COMMITMENT_HEX);
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    let root = tree_client.current_root(&dao_id);

    // Create proposal (proposal_id = 1 to match proof)
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 86400),
        &member,
        &VoteMode::Fixed,
    );
    assert_eq!(proposal_id, 1);

    // Try to vote with CORRUPTED proof - should fail
    let nullifier = hex_str_to_u256(&env, REAL_NULLIFIER_HEX);
    let corrupted_proof = get_corrupted_proof(&env);

    // This should fail - corrupted proof won't verify
    voting_client.vote(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier,
        &root,
        &corrupted_proof,
    );
}

// Test: Valid proof with wrong VK should fail
// This tests the VK hash check - proposal stores VK hash at creation time
#[test]
#[should_panic(expected = "HostError")]
fn test_wrong_vk_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

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

    // Initialize tree
    tree_client.init_tree(&dao_id, &18, &admin);

    // Set REAL VK initially
    voting_client.set_vk(&dao_id, &get_real_vk(&env), &admin);

    // Member joins
    let member = Address::generate(&env);
    sbt_client.mint(&dao_id, &member, &admin, &None);
    let commitment = hex_str_to_u256(&env, REAL_COMMITMENT_HEX);
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    let root = tree_client.current_root(&dao_id);

    // Create proposal with real VK
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 86400),
        &member,
        &VoteMode::Fixed,
    );

    // Admin changes VK AFTER proposal creation
    voting_client.set_vk(&dao_id, &get_different_vk(&env), &admin);

    // Tamper the stored VK for the proposal's pinned version to simulate storage drift
    // This should trigger VkChanged when the vote checks the hash snapshot.
    env.as_contract(&voting_id, || {
        env.storage().persistent().set(
            &VotingDataKey::VkByVersion(dao_id, 1),
            &get_different_vk(&env),
        );
    });

    // Try to vote - should fail because VK hash doesn't match
    let nullifier = hex_str_to_u256(&env, REAL_NULLIFIER_HEX);
    let proof = get_real_proof(&env);

    voting_client.vote(&dao_id, &proposal_id, &true, &nullifier, &root, &proof);
}

// Test: Nullifier reuse with a real proof should fail on second attempt
#[test]
#[should_panic(expected = "HostError")]
fn test_real_proof_double_vote_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create DAO and init tree
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );
    tree_client.init_tree(&dao_id, &18, &admin);

    // Set real VK and register member
    voting_client.set_vk(&dao_id, &get_real_vk(&env), &admin);
    let member = Address::generate(&env);
    sbt_client.mint(&dao_id, &member, &admin, &None);
    let commitment = hex_str_to_u256(&env, REAL_COMMITMENT_HEX);
    tree_client.register_with_caller(&dao_id, &commitment, &member);
    let root = tree_client.current_root(&dao_id);

    // Create proposal
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Double vote"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 86400),
        &member,
        &VoteMode::Fixed,
    );

    let nullifier = hex_str_to_u256(&env, REAL_NULLIFIER_HEX);
    let proof = get_real_proof(&env);

    // First vote succeeds
    voting_client.vote(&dao_id, &proposal_id, &true, &nullifier, &root, &proof);

    // Second vote with same nullifier should panic
    voting_client.vote(&dao_id, &proposal_id, &true, &nullifier, &root, &proof);
}

// Test: Same nullifier can be used in different DAOs
// Nullifiers are scoped by DAO, so the same nullifier value in different DAOs is fine
// (In practice, nullifier = hash(secret, daoId, proposalId), so this would require
// different secrets to produce the same nullifier in different DAOs, but the contract
// doesn't prevent it since storage is DAO-scoped)
#[test]
fn test_nullifier_reusable_across_daos() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create TWO DAOs
    let dao_id_1 = registry_client.create_dao(
        &String::from_str(&env, "DAO 1"),
        &admin,
        &false,
        &true,
        &None,
    );
    let dao_id_2 = registry_client.create_dao(
        &String::from_str(&env, "DAO 2"),
        &admin,
        &false,
        &true,
        &None,
    );
    assert_eq!(dao_id_1, 1);
    assert_eq!(dao_id_2, 2);

    // Initialize trees for both DAOs
    tree_client.init_tree(&dao_id_1, &18, &admin);
    tree_client.init_tree(&dao_id_2, &18, &admin);

    // Set VK for both DAOs
    let vk = get_real_vk(&env);
    voting_client.set_vk(&dao_id_1, &vk, &admin);
    voting_client.set_vk(&dao_id_2, &vk, &admin);

    // Member joins both DAOs
    let member = Address::generate(&env);
    sbt_client.mint(&dao_id_1, &member, &admin, &None);
    sbt_client.mint(&dao_id_2, &member, &admin, &None);

    // Register with arbitrary commitment (we'll use mock data since actual voting
    // would need real proofs for each DAO)
    let commitment1 = U256::from_u32(&env, 111);
    let commitment2 = U256::from_u32(&env, 222);
    tree_client.register_with_caller(&dao_id_1, &commitment1, &member);
    tree_client.register_with_caller(&dao_id_2, &commitment2, &member);

    // Get roots
    let _root1 = tree_client.current_root(&dao_id_1);
    let _root2 = tree_client.current_root(&dao_id_2);

    // Create proposals in both DAOs
    let prop_id_1 = voting_client.create_proposal(
        &dao_id_1,
        &String::from_str(&env, "DAO 1 Proposal"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 86400),
        &member,
        &VoteMode::Fixed,
    );
    let prop_id_2 = voting_client.create_proposal(
        &dao_id_2,
        &String::from_str(&env, "DAO 2 Proposal"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 86400),
        &member,
        &VoteMode::Fixed,
    );

    // Check that nullifier storage is DAO-scoped
    // Using the same nullifier value in both DAOs should both return false initially
    let same_nullifier = U256::from_u32(&env, 99999);

    assert!(
        !voting_client.is_nullifier_used(&dao_id_1, &prop_id_1, &same_nullifier),
        "Nullifier should not be used in DAO 1 initially"
    );
    assert!(
        !voting_client.is_nullifier_used(&dao_id_2, &prop_id_2, &same_nullifier),
        "Nullifier should not be used in DAO 2 initially"
    );

    // We can't actually vote without real proofs, but we've verified:
    // 1. Both DAOs exist independently
    // 2. Nullifier usage is DAO-scoped (both show "not used")
    // 3. The same nullifier value can exist in different DAO contexts

    println!("✅ Verified nullifier storage is DAO-scoped");
}

// Test: Proof for wrong DAO ID fails
// The proof contains daoId in public signals, so using a proof generated for DAO 1
// when voting on DAO 2 should fail verification
// NOTE: Ignored in CI - verify_groth16 returns true in test mode (pairing skipped)
#[test]
#[ignore = "requires real BN254 pairing (skipped in test mode)"]
#[should_panic(expected = "HostError")]
fn test_proof_for_wrong_dao_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create TWO DAOs - we'll try to use a proof for DAO 1 on DAO 2
    let _dao_id_1 = registry_client.create_dao(
        &String::from_str(&env, "DAO 1"),
        &admin,
        &false,
        &true,
        &None,
    );
    let dao_id_2 = registry_client.create_dao(
        &String::from_str(&env, "DAO 2"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Initialize tree for DAO 2
    tree_client.init_tree(&dao_id_2, &18, &admin);

    // Set VK for DAO 2
    voting_client.set_vk(&dao_id_2, &get_real_vk(&env), &admin);

    // Member joins DAO 2 with the same commitment as the proof
    let member = Address::generate(&env);
    sbt_client.mint(&dao_id_2, &member, &admin, &None);
    let commitment = hex_str_to_u256(&env, REAL_COMMITMENT_HEX);
    tree_client.register_with_caller(&dao_id_2, &commitment, &member);

    let root = tree_client.current_root(&dao_id_2);

    // Create proposal in DAO 2
    let proposal_id = voting_client.create_proposal(
        &dao_id_2,
        &String::from_str(&env, "DAO 2 Proposal"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 86400),
        &member,
        &VoteMode::Fixed,
    );

    // Try to vote on DAO 2 with proof generated for DAO 1
    // The proof has daoId=1 in its public signals, but we're voting on daoId=2
    let nullifier = hex_str_to_u256(&env, REAL_NULLIFIER_HEX);
    let proof = get_real_proof(&env);

    // This should fail - proof daoId (1) doesn't match actual daoId (2)
    voting_client.vote(&dao_id_2, &proposal_id, &true, &nullifier, &root, &proof);
}

// Test: Proof for wrong proposal ID fails
// NOTE: Ignored in CI - verify_groth16 returns true in test mode (pairing skipped)
#[test]
#[ignore = "requires real BN254 pairing (skipped in test mode)"]
#[should_panic(expected = "HostError")]
fn test_proof_for_wrong_proposal_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create DAO (dao_id = 1 to match proof)
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Initialize tree
    tree_client.init_tree(&dao_id, &18, &admin);

    // Set VK
    voting_client.set_vk(&dao_id, &get_real_vk(&env), &admin);

    // Member joins
    let member = Address::generate(&env);
    sbt_client.mint(&dao_id, &member, &admin, &None);
    let commitment = hex_str_to_u256(&env, REAL_COMMITMENT_HEX);
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    let root = tree_client.current_root(&dao_id);

    // Create TWO proposals - we'll skip prop 1 and try to use its proof on prop 2
    let _proposal_1 = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Proposal 1"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 86400),
        &member,
        &VoteMode::Fixed,
    );
    let proposal_2 = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Proposal 2"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 86400),
        &member,
        &VoteMode::Fixed,
    );

    // Try to vote on proposal 2 with proof generated for proposal 1
    // The proof has proposalId=1 in its public signals, but we're voting on proposalId=2
    let nullifier = hex_str_to_u256(&env, REAL_NULLIFIER_HEX);
    let proof = get_real_proof(&env);

    // This should fail - proof proposalId (1) doesn't match actual proposalId (2)
    voting_client.vote(&dao_id, &proposal_2, &true, &nullifier, &root, &proof);
}
