// Public DAO Tests
//
// Tests for public DAO functionality where:
// - Anyone can join (self_join)
// - Anyone can register commitment (self_register)
// - Anyone can create proposals
// - All registered members can vote

use soroban_sdk::{testutils::Address as _, Address, Env, String, U256};

// Import actual contract clients from crates (not WASM)
use dao_registry::DaoRegistryClient;
use membership_sbt::MembershipSbtClient;
use membership_tree::MembershipTreeClient;
use voting::{VoteMode, VotingClient};

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

// Helper function to create BN254 G1 generator point (1, 2)
fn bn254_g1_generator(env: &Env) -> soroban_sdk::BytesN<64> {
    let mut bytes = [0u8; 64];
    // x = 1 (big-endian, 32 bytes)
    bytes[31] = 1;
    // y = 2 (big-endian, 32 bytes)
    bytes[63] = 2;
    soroban_sdk::BytesN::from_array(env, &bytes)
}

// Helper function to create BN254 G2 generator point
fn bn254_g2_generator(env: &Env) -> soroban_sdk::BytesN<128> {
    let bytes: [u8; 128] = [
        // x1 (32 bytes)
        0x18, 0x00, 0x50, 0x6a, 0x06, 0x12, 0x86, 0xeb, 0x6a, 0x84, 0xa5, 0x73, 0x0b, 0x8f, 0x10,
        0x29, 0x3e, 0x29, 0x81, 0x6c, 0xd1, 0x91, 0x3d, 0x53, 0x38, 0xf7, 0x15, 0xde, 0x3e, 0x98,
        0xf9, 0xad, // x2 (32 bytes)
        0x19, 0x83, 0x90, 0x42, 0x11, 0xa5, 0x3f, 0x6e, 0x0b, 0x08, 0x53, 0xa9, 0x0a, 0x00, 0xef,
        0xbf, 0xf1, 0x70, 0x0c, 0x7b, 0x1d, 0xc0, 0x06, 0x32, 0x4d, 0x85, 0x9d, 0x75, 0xe3, 0xca,
        0xa5, 0xa2, // y1 (32 bytes)
        0x12, 0xc8, 0x5e, 0xa5, 0xdb, 0x8c, 0x6d, 0xeb, 0x4a, 0xab, 0x71, 0x8e, 0x80, 0x6a, 0x51,
        0xa5, 0x66, 0x08, 0x21, 0x4c, 0x3f, 0x62, 0x8b, 0x96, 0x2c, 0xf1, 0x91, 0xea, 0xcd, 0xc8,
        0x0e, 0x7a, // y2 (32 bytes)
        0x09, 0x0d, 0x97, 0xc0, 0x9c, 0xe1, 0x48, 0x60, 0x63, 0xb3, 0x59, 0xf3, 0xdd, 0x89, 0xb7,
        0xc4, 0x3c, 0x5f, 0x18, 0x95, 0x8f, 0xb3, 0xe6, 0xb9, 0x6d, 0xb5, 0x5e, 0x19, 0xa3, 0xb7,
        0xc0, 0xfb,
    ];
    soroban_sdk::BytesN::from_array(env, &bytes)
}

// Helper function to create test verification key (6 IC elements for vote circuit)
fn create_test_vk(env: &Env) -> voting::VerificationKey {
    let g1_gen = bn254_g1_generator(env);
    let g2_gen = bn254_g2_generator(env);

    voting::VerificationKey {
        alpha: g1_gen.clone(),
        beta: g2_gen.clone(),
        gamma: g2_gen.clone(),
        delta: g2_gen,
        ic: soroban_sdk::vec![
            env,
            g1_gen.clone(),
            g1_gen.clone(),
            g1_gen.clone(),
            g1_gen.clone(),
            g1_gen.clone(),
            g1_gen, // 6 elements for 5 public signals + 1
        ],
    }
}

#[test]
fn test_public_dao_creation() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, _, _, _, admin) = setup_contracts(&env);
    let registry_client = DaoRegistryClient::new(&env, &registry_id);

    // Create public DAO with membership_open=true
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Public DAO"),
        &admin,
        &true,
        &true,
        &None,
    );

    // Verify DAO exists and has open membership
    assert!(registry_client.dao_exists(&dao_id));
    assert!(registry_client.is_membership_open(&dao_id));

    let dao_info = registry_client.get_dao(&dao_id);
    assert!(dao_info.membership_open);
}

#[test]
fn test_self_join_public_dao() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, _, admin) = setup_contracts(&env);
    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);

    // Create public DAO
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Public DAO"),
        &admin,
        &true,
        &true,
        &None,
    );

    // Initialize tree
    tree_client.init_tree(&dao_id, &18, &admin);

    // Random user self-joins
    let user = Address::generate(&env);
    sbt_client.self_join(&dao_id, &user, &None);

    // Verify user has SBT
    assert!(sbt_client.has(&dao_id, &user));
}

#[test]
#[should_panic]
fn test_self_join_private_dao_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, _, _, admin) = setup_contracts(&env);
    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);

    // Create private DAO (membership_open=false)
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Private DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Random user tries to self-join - should fail
    let user = Address::generate(&env);
    sbt_client.self_join(&dao_id, &user, &None);
}

#[test]
fn test_self_register_public_dao() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, _, admin) = setup_contracts(&env);
    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);

    // Create public DAO
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Public DAO"),
        &admin,
        &true,
        &true,
        &None,
    );

    // Initialize tree
    tree_client.init_tree(&dao_id, &18, &admin);

    // User self-joins
    let user = Address::generate(&env);
    sbt_client.self_join(&dao_id, &user, &None);

    // User self-registers commitment
    let commitment = U256::from_u32(&env, 12345);
    tree_client.self_register(&dao_id, &commitment, &user);

    // Verify commitment registered
    let leaf_index = tree_client.get_leaf_index(&dao_id, &commitment);
    assert_eq!(leaf_index, 0);
}

#[test]
#[should_panic]
fn test_self_register_private_dao_fails() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, _, admin) = setup_contracts(&env);
    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);

    // Create private DAO
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Private DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Initialize tree
    tree_client.init_tree(&dao_id, &18, &admin);

    // Admin mints SBT to user
    let user = Address::generate(&env);
    sbt_client.mint(&dao_id, &user, &admin, &None);

    // User tries to self-register - should fail
    let commitment = U256::from_u32(&env, 12345);
    tree_client.self_register(&dao_id, &commitment, &user);
}

/// Test: In a public DAO with members_can_propose=true, any member can create proposals
#[test]
fn test_member_creates_proposal_in_public_dao() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);
    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);

    // Create public DAO with members_can_propose=true (any member can create proposals)
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Public DAO"),
        &admin,
        &true,
        &true,
        &None,
    );

    // Initialize tree
    tree_client.init_tree(&dao_id, &18, &admin);

    // Set VK
    let vk = create_test_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &admin);

    // User self-joins the public DAO (gets SBT)
    let user = Address::generate(&env);
    sbt_client.self_join(&dao_id, &user, &None);

    // Verify user now has SBT
    assert!(sbt_client.has(&dao_id, &user));

    let current_time = env.ledger().timestamp();
    let end_time = current_time + 3600;

    // User creates proposal successfully
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Public Proposal"),
        &String::from_str(&env, ""),
        &end_time,
        &user,
        &VoteMode::Trailing,
    );

    assert_eq!(proposal_id, 1);
}

#[test]
#[should_panic]
fn test_non_member_cannot_create_proposal_in_private_dao() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, _, tree_id, voting_id, admin) = setup_contracts(&env);
    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create private DAO
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Private DAO"),
        &admin,
        &false,
        &true,
        &None,
    );

    // Initialize tree
    tree_client.init_tree(&dao_id, &18, &admin);

    // Set VK
    let vk = create_test_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &admin);

    // Random user (no SBT) tries to create proposal - should fail
    let user = Address::generate(&env);

    let current_time = env.ledger().timestamp();
    let end_time = current_time + 3600;

    voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Private Proposal"),
        &String::from_str(&env, ""),
        &end_time,
        &user,
        &VoteMode::Fixed,
    );
}

/// Test: When members_can_propose=false, only admin can create proposals (even if member has SBT)
#[test]
#[should_panic]
fn test_member_cannot_propose_when_admin_only_mode() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);
    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create public DAO with members_can_propose=FALSE (admin-only proposal mode)
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Admin Only DAO"),
        &admin,
        &true,
        &false,
        &None,
    );

    // Initialize tree
    tree_client.init_tree(&dao_id, &18, &admin);

    // Set VK
    let vk = create_test_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &admin);

    // User self-joins (since membership is open) and gets SBT
    let user = Address::generate(&env);
    sbt_client.self_join(&dao_id, &user, &None);

    // Verify user has SBT
    assert!(sbt_client.has(&dao_id, &user));

    let current_time = env.ledger().timestamp();
    let end_time = current_time + 3600;

    // User tries to create proposal - should fail with AdminOnlyPropose error
    // because members_can_propose=false
    voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "User Proposal"),
        &String::from_str(&env, ""),
        &end_time,
        &user,
        &VoteMode::Trailing,
    );
}

/// Test: When members_can_propose=false, admin CAN still create proposals
#[test]
fn test_admin_can_propose_in_admin_only_mode() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);
    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create DAO with members_can_propose=FALSE (admin-only proposal mode)
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Admin Only DAO"),
        &admin,
        &false,
        &false,
        &None,
    );

    // Initialize tree
    tree_client.init_tree(&dao_id, &18, &admin);

    // Admin needs SBT to create proposals (still required)
    sbt_client.mint(&dao_id, &admin, &admin, &None);

    // Set VK
    let vk = create_test_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &admin);

    let current_time = env.ledger().timestamp();
    let end_time = current_time + 3600;

    // Admin creates proposal successfully
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Admin Proposal"),
        &String::from_str(&env, ""),
        &end_time,
        &admin,
        &VoteMode::Fixed,
    );

    assert_eq!(proposal_id, 1);
}

#[test]
fn test_full_public_dao_flow() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let (registry_id, sbt_id, tree_id, voting_id, admin) = setup_contracts(&env);
    let registry_client = DaoRegistryClient::new(&env, &registry_id);
    let sbt_client = MembershipSbtClient::new(&env, &sbt_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let voting_client = VotingClient::new(&env, &voting_id);

    // Create public DAO with members_can_propose=true (any member can create proposals)
    let dao_id = registry_client.create_dao(
        &String::from_str(&env, "Public DAO"),
        &admin,
        &true,
        &true,
        &None,
    );

    // Initialize tree
    tree_client.init_tree(&dao_id, &18, &admin);

    // Set VK
    let vk = create_test_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &admin);

    // User 1: Self-join and register
    let user1 = Address::generate(&env);
    sbt_client.self_join(&dao_id, &user1, &None);
    let commitment1 = U256::from_u32(&env, 111);
    tree_client.self_register(&dao_id, &commitment1, &user1);

    // User 2: Self-join and register
    let user2 = Address::generate(&env);
    sbt_client.self_join(&dao_id, &user2, &None);
    let commitment2 = U256::from_u32(&env, 222);
    tree_client.self_register(&dao_id, &commitment2, &user2);

    // User 3: Self-joins and creates proposal (any member can propose in this DAO)
    let user3 = Address::generate(&env);
    sbt_client.self_join(&dao_id, &user3, &None);

    let current_time = env.ledger().timestamp();
    let end_time = current_time + 3600;

    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Public Proposal"),
        &String::from_str(&env, ""),
        &end_time,
        &user3,
        &VoteMode::Trailing,
    );

    // Verify proposal created
    assert_eq!(proposal_id, 1);

    // Verify tree has 2 members
    let (_, next_index, _) = tree_client.get_tree_info(&dao_id);
    assert_eq!(next_index, 2);

    // Verify DAO has open membership
    assert!(registry_client.is_membership_open(&dao_id));
}
