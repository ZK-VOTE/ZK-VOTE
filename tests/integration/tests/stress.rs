#![allow(deprecated)]

//! Stress tests for ZKVote contracts
//!
//! These tests gauge capacity and performance under load.
//! Run manually with `cargo test --test stress -- --ignored` when profiling.
//!
//! Test categories:
//! - Member capacity: Tests maximum members in a DAO
//! - Proposal capacity: Tests maximum proposals per DAO
//! - Multi-DAO: Tests registry with many DAOs
//! - Concurrent operations: Tests parallel member/proposal operations
//! - Tree operations: Tests Merkle tree under load

use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String, U256};

// Import actual contract clients from crates (not WASM)
use dao_registry::DaoRegistryClient;
use membership_sbt::MembershipSbtClient;
use membership_tree::MembershipTreeClient;
use voting::{VerificationKey, VoteMode, VotingClient};

fn zero_g1(env: &Env) -> BytesN<64> {
    BytesN::from_array(env, &[0u8; 64])
}

fn zero_g2(env: &Env) -> BytesN<128> {
    BytesN::from_array(env, &[0u8; 128])
}

fn dummy_vk(env: &Env) -> VerificationKey {
    let mut ic = soroban_sdk::Vec::new(env);
    // IC needs 6 elements for 5 public signals (commitment is now private)
    for _ in 0..6 {
        ic.push_back(zero_g1(env));
    }
    VerificationKey {
        alpha: zero_g1(env),
        beta: zero_g2(env),
        gamma: zero_g2(env),
        delta: zero_g2(env),
        ic,
    }
}

/// Helper to set up a basic DAO with contracts initialized
/// open_membership: true allows self_register without admin
fn setup_dao(
    env: &Env,
) -> (
    DaoRegistryClient<'_>,
    MembershipSbtClient<'_>,
    MembershipTreeClient<'_>,
    VotingClient<'_>,
    Address,
    u64,
) {
    setup_dao_with_options(env, true) // Default to open membership
}

/// Helper to set up a DAO with configurable options
fn setup_dao_with_options(
    env: &Env,
    open_membership: bool,
) -> (
    DaoRegistryClient<'_>,
    MembershipSbtClient<'_>,
    MembershipTreeClient<'_>,
    VotingClient<'_>,
    Address,
    u64,
) {
    let registry_id = env.register(dao_registry::DaoRegistry, ());
    let sbt_id = env.register(membership_sbt::MembershipSbt, (registry_id.clone(),));
    let tree_id = env.register(
        membership_tree::MembershipTree,
        (sbt_id.clone(), registry_id.clone()),
    );
    let voting_id = env.register(voting::Voting, (tree_id.clone(), registry_id.clone()));

    let registry = DaoRegistryClient::new(env, &registry_id);
    let sbt = MembershipSbtClient::new(env, &sbt_id);
    let tree = MembershipTreeClient::new(env, &tree_id);
    let voting = VotingClient::new(env, &voting_id);

    let admin = Address::generate(env);
    let dao_id = registry.create_dao(
        &String::from_str(env, "Stress DAO"),
        &admin,
        &open_membership,
        &true,
        &None,
    );
    tree.init_tree(&dao_id, &18, &admin);
    sbt.mint(&dao_id, &admin, &admin, &None);
    voting.set_vk(&dao_id, &dummy_vk(env), &admin);

    (registry, sbt, tree, voting, admin, dao_id)
}

/// Generate a deterministic commitment from an index
fn commitment_from_index(env: &Env, index: u32) -> U256 {
    // Simple deterministic commitment: just use the index padded to 256 bits
    // In real usage, this would be Poseidon(secret, salt)
    U256::from_u128(env, index as u128 * 12345678901234567890u128)
}

// ============================================================================
// Stress Test: Many Members
// ============================================================================

#[test]
#[ignore]
fn stress_many_members_and_proposals() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (_, sbt, _, voting, admin, dao_id) = setup_dao(&env);

    // Add a few hundred members
    println!("Adding 300 members...");
    for i in 0..300u32 {
        let member = Address::generate(&env);
        sbt.mint(&dao_id, &member, &admin, &None);
        if i % 50 == 0 {
            println!("  Added {} members", i);
        }
    }

    // Create many proposals
    println!("Creating 200 proposals...");
    for i in 0..200u32 {
        let title = String::from_str(&env, &format!("Prop {}", i));
        let content_cid = String::from_str(&env, "QmTest");
        let _ = voting.create_proposal(
            &dao_id,
            &title,
            &content_cid,
            &0u64,
            &admin,
            &VoteMode::Fixed,
        );
        if i % 50 == 0 {
            println!("  Created {} proposals", i);
        }
    }
    println!("Stress test complete!");
}

// ============================================================================
// Stress Test: Many DAOs
// ============================================================================

#[test]
#[ignore]
fn stress_many_daos() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let registry_id = env.register(dao_registry::DaoRegistry, ());
    let sbt_id = env.register(membership_sbt::MembershipSbt, (registry_id.clone(),));
    let tree_id = env.register(
        membership_tree::MembershipTree,
        (sbt_id.clone(), registry_id.clone()),
    );
    let voting_id = env.register(voting::Voting, (tree_id.clone(), registry_id.clone()));

    let registry = DaoRegistryClient::new(&env, &registry_id);
    let sbt = MembershipSbtClient::new(&env, &sbt_id);
    let tree = MembershipTreeClient::new(&env, &tree_id);
    let voting = VotingClient::new(&env, &voting_id);

    println!("Creating 100 DAOs...");
    for i in 0..100u32 {
        let admin = Address::generate(&env);
        let name = String::from_str(&env, &format!("DAO {}", i));
        let dao_id = registry.create_dao(&name, &admin, &false, &true, &None);

        // Initialize each DAO
        tree.init_tree(&dao_id, &18, &admin);
        sbt.mint(&dao_id, &admin, &admin, &None);
        voting.set_vk(&dao_id, &dummy_vk(&env), &admin);

        // Add 5 members per DAO
        for _ in 0..5u32 {
            let member = Address::generate(&env);
            sbt.mint(&dao_id, &member, &admin, &None);
        }

        if i % 20 == 0 {
            println!("  Created {} DAOs", i);
        }
    }

    // Verify DAO count
    let count = registry.dao_count();
    assert_eq!(count, 100, "Expected 100 DAOs");
    println!("Created {} DAOs successfully!", count);
}

// ============================================================================
// Stress Test: Merkle Tree Operations
// ============================================================================

#[test]
#[ignore]
fn stress_merkle_tree_registrations() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (_, sbt, tree, _, admin, dao_id) = setup_dao(&env);

    println!("Registering 100 commitments to Merkle tree...");
    for i in 0..100u32 {
        let member = Address::generate(&env);
        sbt.mint(&dao_id, &member, &admin, &None);

        let commitment = commitment_from_index(&env, i);
        tree.self_register(&dao_id, &commitment, &member);

        if i % 25 == 0 {
            println!("  Registered {} commitments", i);
            // Check tree info
            let (depth, leaf_count, _root) = tree.get_tree_info(&dao_id);
            println!("    Tree depth: {}, leaves: {}", depth, leaf_count);
        }
    }

    // Verify final tree state
    let (depth, leaf_count, root) = tree.get_tree_info(&dao_id);
    assert_eq!(depth, 18, "Tree depth should be 18");
    assert_eq!(leaf_count, 100, "Should have 100 leaves");
    assert!(root > U256::from_u128(&env, 0), "Root should be non-zero");
    println!("Merkle tree stress test complete!");
    println!("  Final depth: {}, leaves: {}", depth, leaf_count);
}

// ============================================================================
// Stress Test: Proposal Votes (without ZK proofs)
// ============================================================================

#[test]
#[ignore]
fn stress_many_proposals_per_dao() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (_, _, _, voting, admin, dao_id) = setup_dao(&env);

    println!("Creating 500 proposals...");
    for i in 0..500u32 {
        let title = String::from_str(&env, &format!("Proposal #{}", i));
        let content_cid = String::from_str(&env, &format!("QmContent{}", i));
        let end_time = if i % 2 == 0 { 0u64 } else { 86400u64 }; // Mix of no deadline and 1 day

        let mode = if i % 3 == 0 {
            VoteMode::Trailing
        } else {
            VoteMode::Fixed
        };

        let _ = voting.create_proposal(&dao_id, &title, &content_cid, &end_time, &admin, &mode);

        if i % 100 == 0 {
            println!("  Created {} proposals", i);
        }
    }

    // Verify proposal count
    let count = voting.proposal_count(&dao_id);
    assert_eq!(count, 500, "Should have 500 proposals");
    println!("Created {} proposals successfully!", count);
}

// ============================================================================
// Stress Test: Member Aliases
// ============================================================================

#[test]
#[ignore]
fn stress_member_aliases() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (_, sbt, _, _, admin, dao_id) = setup_dao(&env);

    println!("Adding 200 members with aliases...");
    for i in 0..200u32 {
        let member = Address::generate(&env);
        let alias = String::from_str(&env, &format!("Member{:04}", i));
        sbt.mint(&dao_id, &member, &admin, &Some(alias.clone()));

        if i % 50 == 0 {
            println!("  Added {} members with aliases", i);
        }
    }

    // Verify member count
    let count = sbt.get_member_count(&dao_id);
    assert_eq!(count, 201, "Should have 201 members (admin + 200)");
    println!("Added {} members with aliases!", count);
}

// ============================================================================
// Stress Test: Mixed Operations
// ============================================================================

#[test]
#[ignore]
fn stress_mixed_operations() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let registry_id = env.register(dao_registry::DaoRegistry, ());
    let sbt_id = env.register(membership_sbt::MembershipSbt, (registry_id.clone(),));
    let tree_id = env.register(
        membership_tree::MembershipTree,
        (sbt_id.clone(), registry_id.clone()),
    );
    let voting_id = env.register(voting::Voting, (tree_id.clone(), registry_id.clone()));

    let registry = DaoRegistryClient::new(&env, &registry_id);
    let sbt = MembershipSbtClient::new(&env, &sbt_id);
    let tree = MembershipTreeClient::new(&env, &tree_id);
    let voting = VotingClient::new(&env, &voting_id);

    println!("Running mixed stress test...");
    println!("  Creating 20 DAOs with varied operations...");

    for i in 0..20u32 {
        let admin = Address::generate(&env);
        let name = String::from_str(&env, &format!("Mixed DAO {}", i));
        let dao_id = registry.create_dao(&name, &admin, &true, &true, &None); // open_membership=true for self_register

        tree.init_tree(&dao_id, &18, &admin);
        sbt.mint(&dao_id, &admin, &admin, &None);
        voting.set_vk(&dao_id, &dummy_vk(&env), &admin);

        // Add varying number of members per DAO
        let num_members = (i % 10 + 1) * 5; // 5 to 50 members
        for j in 0..num_members {
            let member = Address::generate(&env);
            let alias = if j % 2 == 0 {
                Some(String::from_str(&env, &format!("M{}", j)))
            } else {
                None
            };
            sbt.mint(&dao_id, &member, &admin, &alias);

            // Register some to the tree
            if j % 3 == 0 {
                let commitment = commitment_from_index(&env, i * 100 + j);
                tree.self_register(&dao_id, &commitment, &member);
            }
        }

        // Create varying number of proposals
        let num_proposals = (i % 5 + 1) * 3; // 3 to 15 proposals
        for p in 0..num_proposals {
            let title = String::from_str(&env, &format!("P{}", p));
            let mode = if p % 2 == 0 {
                VoteMode::Fixed
            } else {
                VoteMode::Trailing
            };
            let _ = voting.create_proposal(
                &dao_id,
                &title,
                &String::from_str(&env, ""),
                &0u64,
                &admin,
                &mode,
            );
        }

        if i % 5 == 0 {
            println!("    Processed {} DAOs", i);
        }
    }

    // Verify final state
    let dao_count = registry.dao_count();
    assert_eq!(dao_count, 20, "Should have 20 DAOs");
    println!("Mixed stress test complete!");
    println!("  Total DAOs: {}", dao_count);
}
