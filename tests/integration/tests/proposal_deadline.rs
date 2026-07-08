// Proposal Deadline Tests
//
// Tests for proposal end_time/deadline functionality:
// 1. Voting before deadline succeeds
// 2. Voting after deadline fails with "voting period closed" error
// 3. end_time = 0 means no deadline (voting never closes)
// 4. Creating proposal with past end_time fails

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env, String, U256,
};

// Import actual contract clients from crates (not WASM)
use dao_registry::DaoRegistryClient;
use membership_sbt::MembershipSbtClient;
use membership_tree::MembershipTreeClient;
use voting::{VerificationKey, VoteMode, VotingClient};

fn setup_contracts(env: &Env) -> (Address, Address, Address, Address, Address) {
    // Deploy contracts using direct crate registration
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

#[test]
fn test_create_proposal_with_future_deadline() {
    let env = Env::default();
    env.mock_all_auths();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry = DaoRegistryClient::new(&env, &registry_id);
    let sbt = MembershipSbtClient::new(&env, &sbt_id);
    let tree = MembershipTreeClient::new(&env, &tree_id);
    let voting = VotingClient::new(&env, &voting_id);

    // Create DAO with admin
    let dao_id = registry.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Mint SBT for admin (required for init_tree)
    sbt.mint(&dao_id, &admin, &admin, &None);

    // Initialize tree with proper admin verification
    tree.init_tree(&dao_id, &18, &admin);

    // Register admin's commitment so tree has a valid root
    let admin_commitment = U256::from_u32(&env, 12345);
    tree.register_with_caller(&dao_id, &admin_commitment, &admin);

    // Set VK with proper admin verification (using mock VK - IC must have exactly 6 elements for vote circuit)
    // 6 IC elements for 5 public signals: root, nullifier, daoId, proposalId, voteChoice
    let mock_alpha = soroban_sdk::BytesN::from_array(&env, &[0u8; 64]);
    let mock_beta = soroban_sdk::BytesN::from_array(&env, &[0u8; 128]);
    let mock_gamma = soroban_sdk::BytesN::from_array(&env, &[0u8; 128]);
    let mock_delta = soroban_sdk::BytesN::from_array(&env, &[0u8; 128]);
    let mock_ic = soroban_sdk::vec![
        &env,
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
    ];

    let mock_vk = VerificationKey {
        alpha: mock_alpha,
        beta: mock_beta,
        gamma: mock_gamma,
        delta: mock_delta,
        ic: mock_ic,
    };

    voting.set_vk(&dao_id, &mock_vk, &admin);

    // Get current timestamp
    let now = env.ledger().timestamp();
    let future_time = now + 1000; // 1000 seconds in the future

    // Create proposal with future deadline - should succeed
    let proposal_id = voting.create_proposal(
        &dao_id,
        &String::from_str(&env, "Test proposal with deadline"),
        &String::from_str(&env, ""),
        &future_time,
        &admin,
        &VoteMode::Fixed,
    );

    assert_eq!(proposal_id, 1);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_create_proposal_with_past_deadline_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry = DaoRegistryClient::new(&env, &registry_id);
    let sbt = MembershipSbtClient::new(&env, &sbt_id);
    let tree = MembershipTreeClient::new(&env, &tree_id);
    let voting = VotingClient::new(&env, &voting_id);

    // Create DAO with admin
    let dao_id = registry.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Mint SBT for admin (required for init_tree)
    sbt.mint(&dao_id, &admin, &admin, &None);

    // Initialize tree with proper admin verification
    tree.init_tree(&dao_id, &18, &admin);

    // Register admin's commitment so tree has a valid root
    let admin_commitment = U256::from_u32(&env, 12345);
    tree.register_with_caller(&dao_id, &admin_commitment, &admin);

    // Set VK with proper admin verification (using mock VK - IC must have exactly 6 elements for vote circuit)
    // 6 IC elements for 5 public signals: root, nullifier, daoId, proposalId, voteChoice
    let mock_alpha = soroban_sdk::BytesN::from_array(&env, &[0u8; 64]);
    let mock_beta = soroban_sdk::BytesN::from_array(&env, &[0u8; 128]);
    let mock_gamma = soroban_sdk::BytesN::from_array(&env, &[0u8; 128]);
    let mock_delta = soroban_sdk::BytesN::from_array(&env, &[0u8; 128]);
    let mock_ic = soroban_sdk::vec![
        &env,
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
    ];

    let mock_vk = VerificationKey {
        alpha: mock_alpha,
        beta: mock_beta,
        gamma: mock_gamma,
        delta: mock_delta,
        ic: mock_ic,
    };

    voting.set_vk(&dao_id, &mock_vk, &admin);

    // Set ledger timestamp to 1000 to ensure we can test past deadlines
    env.ledger().with_mut(|ledger| {
        ledger.timestamp = 1000;
    });

    // Get current timestamp and create a past deadline
    let now = env.ledger().timestamp();
    let past_time = now - 100; // 100 seconds in the past

    // Create proposal with past deadline - should fail
    voting.create_proposal(
        &dao_id,
        &String::from_str(&env, "Test proposal with past deadline"),
        &String::from_str(&env, ""),
        &past_time,
        &admin,
        &VoteMode::Fixed,
    );
}

#[test]
fn test_create_proposal_with_no_deadline() {
    let env = Env::default();
    env.mock_all_auths();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);

    let registry = DaoRegistryClient::new(&env, &registry_id);
    let sbt = MembershipSbtClient::new(&env, &sbt_id);
    let tree = MembershipTreeClient::new(&env, &tree_id);
    let voting = VotingClient::new(&env, &voting_id);

    // Create DAO with admin
    let dao_id = registry.create_dao(
        &String::from_str(&env, "Test DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Mint SBT for admin (required for init_tree)
    sbt.mint(&dao_id, &admin, &admin, &None);

    // Initialize tree with proper admin verification
    tree.init_tree(&dao_id, &18, &admin);

    // Register admin's commitment so tree has a valid root
    let admin_commitment = U256::from_u32(&env, 12345);
    tree.register_with_caller(&dao_id, &admin_commitment, &admin);

    // Set VK with proper admin verification (using mock VK - IC must have exactly 6 elements for vote circuit)
    // 6 IC elements for 5 public signals: root, nullifier, daoId, proposalId, voteChoice
    let mock_alpha = soroban_sdk::BytesN::from_array(&env, &[0u8; 64]);
    let mock_beta = soroban_sdk::BytesN::from_array(&env, &[0u8; 128]);
    let mock_gamma = soroban_sdk::BytesN::from_array(&env, &[0u8; 128]);
    let mock_delta = soroban_sdk::BytesN::from_array(&env, &[0u8; 128]);
    let mock_ic = soroban_sdk::vec![
        &env,
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
        soroban_sdk::BytesN::from_array(&env, &[0u8; 64]),
    ];

    let mock_vk = VerificationKey {
        alpha: mock_alpha,
        beta: mock_beta,
        gamma: mock_gamma,
        delta: mock_delta,
        ic: mock_ic,
    };

    voting.set_vk(&dao_id, &mock_vk, &admin);

    // Create proposal with end_time = 0 (no deadline) - should succeed
    let proposal_id = voting.create_proposal(
        &dao_id,
        &String::from_str(&env, "Test proposal with no deadline"),
        &String::from_str(&env, ""),
        &0, // 0 = no deadline
        &admin,
        &VoteMode::Fixed,
    );

    assert_eq!(proposal_id, 1);

    // Get proposal and verify end_time is 0
    let proposal = voting.get_proposal(&dao_id, &proposal_id);
    assert_eq!(proposal.end_time, 0);
}

// Note: Testing voting after deadline would require:
// 1. Registering members with identity commitments
// 2. Generating valid ZK proofs
// 3. Manipulating ledger timestamp
// This is covered in the full_voting_flow integration test with time manipulation
// The core logic is tested above by verifying proposals can be created with proper deadlines
