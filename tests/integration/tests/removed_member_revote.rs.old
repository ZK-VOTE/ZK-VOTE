// Test: Removed and Re-added Member Cannot Vote on Proposal Created While Removed
//
// This test replicates the exact bug scenario:
// 1. Member added, registered, votes on proposal 1
// 2. Member removed (leaf zeroed)
// 3. Proposal 2 created (eligible_root captures zeroed leaf)
// 4. Member re-added
// 5. Member tries to vote on proposal 2 with old credentials
// 6. Vote SHOULD FAIL because old credentials prove membership in old root, not eligible_root

use soroban_sdk::{testutils::Address as _, Address, Env, String, U256};

mod dao_registry {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/dao_registry.wasm"
    );
}

mod membership_sbt {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/membership_sbt.wasm"
    );
}

mod membership_tree {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/membership_tree.wasm"
    );
}

mod voting {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/voting.wasm"
    );
}

use dao_registry::Client as RegistryClient;
use membership_sbt::Client as SbtClient;
use membership_tree::Client as TreeClient;
use voting::{Client as VotingClient, Proof, VerificationKey};
use soroban_sdk::Vec as SdkVec;

// Mock proof (all zeros - will be accepted in test mode)
fn mock_proof(env: &Env) -> Proof {
    Proof {
        a: soroban_sdk::BytesN::from_array(env, &[0u8; 64]),
        b: soroban_sdk::BytesN::from_array(env, &[0u8; 128]),
        c: soroban_sdk::BytesN::from_array(env, &[0u8; 64]),
    }
}

// Mock verification key
fn mock_vk(env: &Env) -> VerificationKey {
    let mut ic = SdkVec::new(env);
    ic.push_back(soroban_sdk::BytesN::from_array(env, &[0u8; 64]));

    VerificationKey {
        alpha: soroban_sdk::BytesN::from_array(env, &[0u8; 64]),
        beta: soroban_sdk::BytesN::from_array(env, &[0u8; 128]),
        gamma: soroban_sdk::BytesN::from_array(env, &[0u8; 128]),
        delta: soroban_sdk::BytesN::from_array(env, &[0u8; 128]),
        ic,
    }
}

#[test]
#[should_panic(expected = "root must match proposal eligible root")]
fn test_removed_then_readded_member_cannot_vote_on_proposal_created_while_removed() {
    let env = Env::default();
    env.mock_all_auths();
    env.budget().reset_unlimited();

    // Deploy contracts
    let registry_id = env.register(dao_registry::WASM, ());
    let sbt_id = env.register(membership_sbt::WASM, (registry_id.clone(),));
    let tree_id = env.register(membership_tree::WASM, (sbt_id.clone(),));
    let voting_id = env.register(voting::WASM, (tree_id.clone(),));

    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    let registry_client = RegistryClient::new(&env, &registry_id);
    let sbt_client = SbtClient::new(&env, &sbt_id);
    let tree_client = TreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // 1. Create DAO
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
    );

    // Initialize tree
    tree_client.init_tree(&dao_id, &20, &admin);

    // 2. Add member and register for voting
    sbt_client.mint(&dao_id, &member, &admin, &None);
    let commitment = U256::from_u32(&env, 12345);
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    let root_with_member = tree_client.current_root(&dao_id);
    println!("Root with member: {:?}", root_with_member);

    // 3. Create Proposal 1 (member is eligible)
    let vk = mock_vk(&env);
    voting_client.set_vk(
        &dao_id,
        &vk,
        &admin,
    );

    let proposal_1_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Proposal 1"),
        &1000u64,
        &admin,
        &voting::VoteMode::Fixed,
    );

    let proposal_1 = voting_client.get_proposal(&dao_id, &proposal_1_id);
    assert_eq!(proposal_1.eligible_root, root_with_member, "Proposal 1 should capture root with member");
    println!("Proposal 1 eligible_root: {:?}", proposal_1.eligible_root);

    // 4. Member votes on Proposal 1 successfully
    let nullifier_1 = U256::from_u32(&env, 11111);
    let proof = mock_proof(&env);
    voting_client.vote(
        &dao_id,
        &proposal_1_id,
        &true,
        &nullifier_1,
        &root_with_member, // This matches eligible_root
        &proof,
    );

    let proposal_1_after_vote = voting_client.get_proposal(&dao_id, &proposal_1_id);
    assert_eq!(proposal_1_after_vote.yes_votes, 1, "Vote should be counted");
    println!("✅ Member voted on Proposal 1 successfully");

    // 5. Remove member (leaf zeroed)
    tree_client.remove_member(&dao_id, &member, &admin);
    let root_with_zeroed_leaf = tree_client.current_root(&dao_id);
    println!("Root after removal (zeroed leaf): {:?}", root_with_zeroed_leaf);

    assert_ne!(root_with_member, root_with_zeroed_leaf, "Root should change after removal");

    // 6. Create Proposal 2 WHILE member is removed
    let proposal_2_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Proposal 2"),
        &2000u64,
        &admin,
        &voting::VoteMode::Fixed,
    );

    let proposal_2 = voting_client.get_proposal(&dao_id, &proposal_2_id);
    assert_eq!(proposal_2.eligible_root, root_with_zeroed_leaf, "Proposal 2 should capture root with zeroed leaf");
    println!("Proposal 2 eligible_root (zeroed): {:?}", proposal_2.eligible_root);

    // 7. Re-add member (but they can't re-register due to mapping bug)
    sbt_client.mint(&dao_id, &member, &admin, &None);
    println!("✅ Member re-added (has SBT again)");

    // Current root should still be root_with_zeroed_leaf because member can't re-register
    let current_root = tree_client.current_root(&dao_id);
    assert_eq!(current_root, root_with_zeroed_leaf, "Root should still be zeroed (can't re-register)");

    // 8. Member tries to vote on Proposal 2 using OLD credentials
    // This simulates what the frontend does with cached credentials
    let nullifier_2 = U256::from_u32(&env, 22222);

    // BUG SCENARIO: Frontend would pass root_with_zeroed_leaf (current root)
    // But the proof would be generated with old commitment, which produces root_with_member
    // The contract should reject this because root_with_member ≠ proposal_2.eligible_root

    // In reality, the proof would fail at generation because:
    // - Circuit computes: commitment = old_commitment
    // - Circuit uses siblings from current tree (which expects leaf=0)
    // - Circuit computes root = root_with_member (doesn't match siblings)
    // - Proof generation fails OR proof is invalid

    // For this test, we're testing the contract's root check
    // Pass root_with_member (what the proof would claim) vs eligible_root (root_with_zeroed_leaf)

    println!("🔍 Attempting vote with old root (should fail)...");
    let proof2 = mock_proof(&env);
    voting_client.vote(
        &dao_id,
        &proposal_2_id,
        &true,
        &nullifier_2,
        &root_with_member, // ❌ Proof claims this root (old commitment)
        &proof2,
    );

    // Should panic with: "root must match proposal eligible root"
    // Because root_with_member ≠ root_with_zeroed_leaf
}

#[test]
fn test_removed_member_can_still_vote_on_old_proposal() {
    let env = Env::default();
    env.mock_all_auths();
    env.budget().reset_unlimited();

    // Deploy contracts
    let registry_id = env.register(dao_registry::WASM, ());
    let sbt_id = env.register(membership_sbt::WASM, (registry_id.clone(),));
    let tree_id = env.register(membership_tree::WASM, (sbt_id.clone(),));
    let voting_id = env.register(voting::WASM, (tree_id.clone(),));

    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    let registry_client = RegistryClient::new(&env, &registry_id);
    let sbt_client = SbtClient::new(&env, &sbt_id);
    let tree_client = TreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create DAO
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
    );

    tree_client.init_tree(&dao_id, &20, &admin);

    // Add member and register
    sbt_client.mint(&dao_id, &member, &admin, &None);
    let commitment = U256::from_u32(&env, 12345);
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    let root_with_member = tree_client.current_root(&dao_id);

    // Set VK and create proposal 1
    let vk = mock_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &admin);

    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Old Proposal"),
        &1000u64,
        &admin,
        &voting::VoteMode::Fixed,
    );

    let proposal = voting_client.get_proposal(&dao_id, &proposal_id);
    assert_eq!(proposal.eligible_root, root_with_member);

    // Remove member
    tree_client.remove_member(&dao_id, &member, &admin);

    // Member can still vote on old proposal (eligible_root = root_with_member)
    let nullifier = U256::from_u32(&env, 99999);
    let proof = mock_proof(&env);
    voting_client.vote(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier,
        &root_with_member, // Matches eligible_root
        &proof,
    );

    let proposal_after = voting_client.get_proposal(&dao_id, &proposal_id);
    assert_eq!(proposal_after.yes_votes, 1);

    println!("✅ Removed member can still vote on proposal created before removal");
}
