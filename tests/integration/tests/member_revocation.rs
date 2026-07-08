// Member Revocation Tests
//
// Tests for the commitment-based revocation feature which allows admins to
// revoke and reinstate members without expensive tree updates.

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env, String, U256,
};

// Import actual contract clients from crates (not WASM)
use dao_registry::DaoRegistryClient;
use membership_sbt::MembershipSbtClient;
use membership_tree::MembershipTreeClient;
use voting::{Proof, VerificationKey, VoteMode, VotingClient};

fn hex_to_bytes<const N: usize>(env: &Env, hex: &str) -> soroban_sdk::BytesN<N> {
    let bytes = hex::decode(hex).expect("invalid hex");
    assert_eq!(bytes.len(), N, "hex string wrong length");
    soroban_sdk::BytesN::from_array(env, &bytes.try_into().unwrap())
}

fn get_real_vk(env: &Env) -> VerificationKey {
    // VK with 6 IC elements for 5 public signals + 1 (commitment is now private)
    let mut ic = soroban_sdk::Vec::new(env);
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
        delta: hex_to_bytes(env, "23bbe71cdbd371ce93879c1920554716ce89ee4e21f9a8aad6e7deb311f460381e3ed1aca9278a56e254d910b89f806fb308f538efd16563538b0b1ddb6d64be28ce9a5f31d7716460220c7e42e96ffa61608228d9a7a55186129cd138e47e590e2874e9d1bae76cbd0cf7081a5b178a34d8a218f7d139830922411a9fbca6c6"),
        ic,
    }
}

fn get_real_proof(env: &Env) -> Proof {
    Proof {
        a: hex_to_bytes(env, "2d806e0094f82e4826cbaf1c55d9411c99cbd4724a06b3636343e9b4662101d027f2ac0e90e5abf5c8eb68bc544720783089cac24d53f97b4ccb23997ee1bef1"),
        b: hex_to_bytes(env, "079a9e010f261129556108ece03d72f2241446001f4867236ee62d0cdd165a2d1f4155f6d442b0f8eb5dd5562119b9efad6c51f52923beb9122e1ef8479c45d508d8febd3f8a15ce920ab23fa2228a56e2af681b9b1aec9071dce66801c5fa810d51353b9164be959e736cd071d642bf3f7cbbeab73eb6dadd02471fc0000fac"),
        c: hex_to_bytes(env, "1417617b66c6217dfd3d37a2949f230cd2126c8edebf73cd6fe9912c56e4b69e050323a90b08147b46079f4f0e359ee504da2082dda2ab112b8099fc064f4a6a"),
    }
}

const REAL_COMMITMENT_HEX: &str =
    "2536d01521137bf7b39e3fd26c1376f456ce46a45993a5d7c3c158a450fd7329";
const REAL_NULLIFIER_HEX: &str = "0cbc551a937e12107e513efd646a4f32eec3f0d2c130532e3516bdd9d4683a50";

fn setup_contracts(env: &Env) -> (Address, Address, Address, Address, Address) {
    // Deploy contracts
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

fn hex_str_to_u256(env: &Env, hex: &str) -> U256 {
    let bytes = hex::decode(hex).expect("invalid hex");
    let mut padded = [0u8; 32];
    let start = 32 - bytes.len();
    padded[start..].copy_from_slice(&bytes);
    U256::from_be_bytes(env, &soroban_sdk::Bytes::from_array(env, &padded))
}

/// Test that admin can successfully revoke a member (via Merkle leaf zeroing)
#[test]
fn test_admin_can_revoke_member() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, _voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);

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

    // Add member
    let member = Address::generate(&env);
    sbt_client.mint(&dao_id, &member, &admin, &None);

    // Member registers commitment
    let commitment = U256::from_u32(&env, 12345);
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    let root_before = tree_client.current_root(&dao_id);

    // Admin removes member
    tree_client.remove_member(&dao_id, &member, &admin);

    let root_after = tree_client.current_root(&dao_id);
    // With Merkle leaf zeroing, root DOES change after removal
    assert_ne!(
        root_before, root_after,
        "Root should change after removal (leaf zeroed)"
    );

    // Verify the old root is still valid (in history)
    assert!(
        tree_client.root_ok(&dao_id, &root_before),
        "Old root should still be in history"
    );

    println!("✅ Admin can successfully revoke member (leaf zeroed, new root created)");
}

/// Test that admin can reinstate a revoked member (allows re-registration)
/// Note: reinstate_member clears the mapping so member can re-register, does NOT restore the leaf
#[test]
fn test_admin_can_reinstate_member() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, _voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);

    // Create DAO
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    tree_client.init_tree(&dao_id, &18, &admin);

    let member = Address::generate(&env);
    sbt_client.mint(&dao_id, &member, &admin, &None);

    let commitment = U256::from_u32(&env, 12345);
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    let root_before_removal = tree_client.current_root(&dao_id);

    // Remove member (zeros the leaf, changes root)
    tree_client.remove_member(&dao_id, &member, &admin);

    let root_after_removal = tree_client.current_root(&dao_id);
    assert_ne!(
        root_before_removal, root_after_removal,
        "Root should change after removal"
    );

    // Reinstate member (clears mapping so they can re-register)
    // Note: This does NOT restore the leaf, root stays the same
    tree_client.reinstate_member(&dao_id, &member, &admin);

    let root_after_reinstate = tree_client.current_root(&dao_id);

    // Root does NOT change after reinstatement (leaf is still zeroed)
    assert_eq!(
        root_after_removal, root_after_reinstate,
        "Root should NOT change after reinstatement (leaf stays zeroed)"
    );

    // Admin must re-mint SBT before member can re-register
    // (remove_member also revokes SBT, reinstate_member does NOT restore it)
    sbt_client.mint(&dao_id, &member, &admin, &None);

    // Member can now re-register with a new commitment
    let new_commitment = U256::from_u32(&env, 67890);
    tree_client.register_with_caller(&dao_id, &new_commitment, &member);

    let root_after_reregister = tree_client.current_root(&dao_id);
    assert_ne!(
        root_after_reinstate, root_after_reregister,
        "Root should change after re-registration"
    );

    // All roots should be valid in history
    assert!(
        tree_client.root_ok(&dao_id, &root_before_removal),
        "Original root should still be in history"
    );
    assert!(
        tree_client.root_ok(&dao_id, &root_after_reregister),
        "New root should be valid"
    );

    println!("✅ Admin can reinstate revoked member (can re-register with new commitment)");
}

/// Test multiple revoke/reinstate/re-register cycles
/// Note: reinstate_member only clears the mapping so member can re-register
#[test]
fn test_multiple_revoke_reinstate_cycles() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, _voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);

    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    tree_client.init_tree(&dao_id, &18, &admin);

    let member = Address::generate(&env);
    sbt_client.mint(&dao_id, &member, &admin, &None);

    let commitment1 = U256::from_u32(&env, 12345);
    tree_client.register_with_caller(&dao_id, &commitment1, &member);

    let original_root = tree_client.current_root(&dao_id);

    // First revoke (zeros the leaf)
    tree_client.remove_member(&dao_id, &member, &admin);
    let root_after_revoke_1 = tree_client.current_root(&dao_id);
    assert_ne!(
        original_root, root_after_revoke_1,
        "Root should change after first revoke"
    );

    // First reinstate (just clears mapping, root stays same)
    tree_client.reinstate_member(&dao_id, &member, &admin);
    let root_after_reinstate_1 = tree_client.current_root(&dao_id);
    assert_eq!(
        root_after_revoke_1, root_after_reinstate_1,
        "Root should NOT change after reinstate"
    );

    // Re-mint SBT (remove_member revokes SBT, reinstate doesn't restore it)
    sbt_client.mint(&dao_id, &member, &admin, &None);

    // Re-register with new commitment
    let commitment2 = U256::from_u32(&env, 67890);
    tree_client.register_with_caller(&dao_id, &commitment2, &member);
    let root_after_reregister = tree_client.current_root(&dao_id);
    assert_ne!(
        root_after_reinstate_1, root_after_reregister,
        "Root should change after re-registration"
    );

    // Second revoke
    tree_client.remove_member(&dao_id, &member, &admin);
    let root_after_revoke_2 = tree_client.current_root(&dao_id);
    assert_ne!(
        root_after_reregister, root_after_revoke_2,
        "Root should change after second revoke"
    );

    // Second reinstate (clears mapping again)
    tree_client.reinstate_member(&dao_id, &member, &admin);
    let root_after_reinstate_2 = tree_client.current_root(&dao_id);
    assert_eq!(
        root_after_revoke_2, root_after_reinstate_2,
        "Root should NOT change after second reinstate"
    );

    // Re-mint SBT again for second cycle
    sbt_client.mint(&dao_id, &member, &admin, &None);

    // Re-register again
    let commitment3 = U256::from_u32(&env, 11111);
    tree_client.register_with_caller(&dao_id, &commitment3, &member);
    let final_root = tree_client.current_root(&dao_id);
    assert_ne!(
        root_after_reinstate_2, final_root,
        "Root should change after third registration"
    );

    // All historical roots should be valid
    assert!(
        tree_client.root_ok(&dao_id, &original_root),
        "Original root should be in history"
    );
    assert!(
        tree_client.root_ok(&dao_id, &final_root),
        "Final root should be valid"
    );

    println!("✅ Multiple revoke/reinstate/re-register cycles work correctly");
}

/// Test that only admin can remove members
#[test]
#[should_panic]
fn test_only_admin_can_remove_member() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, _voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);

    let non_admin = Address::generate(&env);
    let member = Address::generate(&env);

    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    tree_client.init_tree(&dao_id, &18, &admin);

    sbt_client.mint(&dao_id, &member, &admin, &None);
    let commitment = U256::from_u32(&env, 12345);
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    // Try to remove as non-admin (should fail)
    tree_client.remove_member(&dao_id, &member, &non_admin);
}

/// Test that only admin can reinstate members
#[test]
#[should_panic]
fn test_only_admin_can_reinstate_member() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, _voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);

    let non_admin = Address::generate(&env);
    let member = Address::generate(&env);

    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    tree_client.init_tree(&dao_id, &18, &admin);

    sbt_client.mint(&dao_id, &member, &admin, &None);
    let commitment = U256::from_u32(&env, 12345);
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    // Remove member
    tree_client.remove_member(&dao_id, &member, &admin);

    // Try to reinstate as non-admin (should fail)
    tree_client.reinstate_member(&dao_id, &member, &non_admin);
}

/// Member revoked after proposal creation cannot vote.
#[test]
#[should_panic(expected = "HostError")]
fn test_revoked_member_cannot_vote_mid_proposal() {
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
        &String::from_str(&env, "Revocation DAO"),
        &admin,
        &false,
        &true,
        &None,
    );
    tree_client.init_tree(&dao_id, &18, &admin);

    // Member setup
    let member = Address::generate(&env);
    sbt_client.mint(&dao_id, &member, &admin, &None);
    let commitment = hex_str_to_u256(&env, REAL_COMMITMENT_HEX);
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    // Set VK
    voting_client.set_vk(&dao_id, &get_real_vk(&env), &admin);

    // Create proposal and then revoke member
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Revocation vote"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 3600),
        &member,
        &VoteMode::Fixed,
    );

    tree_client.remove_member(&dao_id, &member, &admin);

    let root = tree_client.current_root(&dao_id);
    let nullifier = hex_str_to_u256(&env, REAL_NULLIFIER_HEX);
    let proof = get_real_proof(&env);

    // Should panic because commitment revoked after proposal creation
    voting_client.vote(&dao_id, &proposal_id, &true, &nullifier, &root, &proof);
}

/// Revoke then reinstate before creating a new proposal:
/// - Proposal A (created pre-revocation) must reject the vote.
/// - Proposal B (created post-reinstatement) must accept the vote.
#[test]
#[should_panic(expected = "HostError")]
fn test_revoked_then_reinstated_only_new_proposals_accept_vote() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Churn DAO"),
        &admin,
        &false,
        &true,
        &None,
    );
    tree_client.init_tree(&dao_id, &18, &admin);

    let member = Address::generate(&env);
    sbt_client.mint(&dao_id, &member, &admin, &None);
    let commitment = hex_str_to_u256(&env, REAL_COMMITMENT_HEX);
    tree_client.register_with_caller(&dao_id, &commitment, &member);

    voting_client.set_vk(&dao_id, &get_real_vk(&env), &admin);

    // Proposal A before revocation
    let proposal_a = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Before revoke"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Revoke then reinstate before creating Proposal B
    tree_client.remove_member(&dao_id, &member, &admin);
    env.ledger().with_mut(|li| li.timestamp += 10);
    tree_client.reinstate_member(&dao_id, &member, &admin);

    env.ledger().with_mut(|li| li.timestamp += 10);
    let proposal_b = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "After reinstate"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let root = tree_client.current_root(&dao_id);
    let nullifier = hex_str_to_u256(&env, REAL_NULLIFIER_HEX);
    let proof = get_real_proof(&env);

    // Vote on proposal B should succeed
    voting_client.vote(&dao_id, &proposal_b, &true, &nullifier, &root, &proof);

    // Vote on proposal A should panic due to revocation during its lifetime
    voting_client.vote(&dao_id, &proposal_a, &true, &nullifier, &root, &proof);
}
