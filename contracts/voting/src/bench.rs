#![cfg(test)]

//! Lightweight stress harness for large-tree/proposal scenarios.
//! Not part of the main test run; mark ignored to avoid CI time unless profiling.

use soroban_sdk::{testutils::Address as _, Address, Env, String};

// Import actual contract clients from crates (not WASM)
use dao_registry::DaoRegistryClient;
use membership_sbt::MembershipSbtClient;
use membership_tree::MembershipTreeClient;
use voting::{VoteMode, VotingClient};

#[test]
#[ignore]
fn stress_many_proposals_and_members() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let registry_id = env.register(dao_registry::DaoRegistry, ());
    let sbt_id = env.register(membership_sbt::MembershipSbt, (registry_id.clone(),));
    let tree_id = env.register(membership_tree::MembershipTree, (sbt_id.clone(),));
    let voting_id = env.register(voting::Voting, (tree_id.clone(), registry_id.clone()));

    let registry = DaoRegistryClient::new(&env, &registry_id);
    let sbt = MembershipSbtClient::new(&env, &sbt_id);
    let tree = MembershipTreeClient::new(&env, &tree_id);
    let voting = VotingClient::new(&env, &voting_id);

    let admin = Address::generate(&env);
    let dao_id = registry.create_dao(&String::from_str(&env, "Stress DAO"), &admin, &false, &true, &None);
    tree.init_tree(&dao_id, &20, &admin);
    voting.set_vk(&dao_id, &crate::test::create_dummy_vk(&env), &admin);

    // Populate 100 members
    for i in 0..100u32 {
        let member = Address::generate(&env);
        sbt.mint(&dao_id, &member, &admin, &None);
        // Commitments are not used further in this smoke; tree depth handles capacity check
    }

    // Create 100 proposals
    for i in 0..100u32 {
        let desc = String::from_str(&env, &format!("Prop {}", i));
        let _pid = voting.create_proposal(&dao_id, &desc, &String::from_str(&env, ""), &0u64, &admin, &VoteMode::Fixed);
    }
}
