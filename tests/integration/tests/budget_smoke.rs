#![allow(deprecated)]

use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String};

// Import actual contract clients from crates (not WASM)
use dao_registry::DaoRegistryClient;
use membership_sbt::MembershipSbtClient;
use membership_tree::MembershipTreeClient;
use voting::{VerificationKey, VoteMode, VotingClient};
// Real verification key (big-endian) from circuits/build/verification_key_soroban_be.json
fn get_real_vk(env: &Env) -> VerificationKey {
    // Helper to parse BE hex into BytesN of length 64 or 128
    fn hex_to_bytes<const N: usize>(env: &Env, hex: &str) -> BytesN<N> {
        let bytes = hex::decode(hex).expect("invalid hex");
        let mut padded = [0u8; N];
        let start = N - bytes.len();
        padded[start..].copy_from_slice(&bytes);
        BytesN::from_array(env, &padded)
    }

    // IC needs 6 elements for 5 public signals (commitment is now private)
    // These are dummy values since we're just testing budget, not actual proof verification
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

fn setup(
    env: &Env,
) -> (
    DaoRegistryClient<'_>,
    MembershipSbtClient<'_>,
    MembershipTreeClient<'_>,
    VotingClient<'_>,
    Address,
    u64,
) {
    env.mock_all_auths();

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
        &String::from_str(env, "Budget DAO"),
        &admin,
        &false,
        &true,
        &None,
    );
    tree.init_tree(&dao_id, &18, &admin);

    // Ensure admin has SBT so proposal creation passes membership check
    sbt.mint(&dao_id, &admin, &admin, &None);

    // Use a real valid VK from shared helpers to avoid VM traps
    let vk = get_real_vk(env);
    voting.set_vk(&dao_id, &vk, &admin);

    (registry, sbt, tree, voting, admin, dao_id)
}

/// Smoke test to ensure key calls stay within a loose budget threshold.
#[test]
fn budget_vote_path_within_limit() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let (_registry, _sbt, _tree, voting, admin, dao_id) = setup(&env);

    // Capture budget before proposal creation
    let budget_before = env.cost_estimate().budget().cpu_instruction_cost();

    let _proposal_id = voting.create_proposal(
        &dao_id,
        &String::from_str(&env, "Budget Check"),
        &String::from_str(&env, ""),
        &0u64,
        &admin,
        &VoteMode::Fixed,
    );

    let budget_after = env.cost_estimate().budget().cpu_instruction_cost();
    let delta = budget_after.saturating_sub(budget_before);

    // Loose upper bound for smoke test; adjust if real budget rises significantly
    let max_allowed: u64 = 5_000_000;
    assert!(
        delta <= max_allowed,
        "budget exceeded for create_proposal: used {} > allowed {}",
        delta,
        max_allowed
    );
}

/// Smoke test for set_vk cost (covers admin check + storage writes).
#[test]
fn budget_set_vk_within_limit() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    env.mock_all_auths();

    let registry_id = env.register(dao_registry::DaoRegistry, ());
    let sbt_id = env.register(membership_sbt::MembershipSbt, (registry_id.clone(),));
    let tree_id = env.register(
        membership_tree::MembershipTree,
        (sbt_id.clone(), registry_id.clone()),
    );
    let voting_id = env.register(voting::Voting, (tree_id.clone(), registry_id.clone()));

    let registry = DaoRegistryClient::new(&env, &registry_id);
    let tree = MembershipTreeClient::new(&env, &tree_id);
    let voting = VotingClient::new(&env, &voting_id);

    let admin = Address::generate(&env);

    // Minimal setup: create DAO and init tree so admin check resolves
    let dao_id = registry.create_dao(
        &String::from_str(&env, "Budget DAO"),
        &admin,
        &false,
        &true,
        &None,
    );
    tree.init_tree(&dao_id, &18, &admin);

    let vk = get_real_vk(&env);

    let before = env.cost_estimate().budget().cpu_instruction_cost();
    voting.set_vk(&dao_id, &vk, &admin);
    let after = env.cost_estimate().budget().cpu_instruction_cost();
    let delta = after.saturating_sub(before);

    // Loose upper bound; tighten after measuring on P25 if needed.
    let max_allowed: u64 = 8_000_000;
    assert!(
        delta <= max_allowed,
        "budget exceeded for set_vk: used {} > allowed {}",
        delta,
        max_allowed
    );
}
