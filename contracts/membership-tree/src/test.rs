use super::*;
use soroban_sdk::{testutils::Address as _, Env};

// Mock Registry contract for testing
mod mock_registry {
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

    #[contracttype]
    pub enum DataKey {
        Admin(u64),
    }

    #[contract]
    pub struct MockRegistry;

    #[contractimpl]
    impl MockRegistry {
        pub fn set_admin(env: Env, dao_id: u64, admin: Address) {
            env.storage()
                .persistent()
                .set(&DataKey::Admin(dao_id), &admin);
        }

        pub fn get_admin(env: Env, dao_id: u64) -> Address {
            env.storage()
                .persistent()
                .get(&DataKey::Admin(dao_id))
                .unwrap()
        }
    }
}

// Mock SBT contract for testing
mod mock_sbt {
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

    #[contracttype]
    pub enum DataKey {
        Member(u64, Address),
        Registry,
    }

    #[contract]
    pub struct MockSbt;

    #[contractimpl]
    impl MockSbt {
        pub fn set_registry(env: Env, registry: Address) {
            env.storage().instance().set(&DataKey::Registry, &registry);
        }

        pub fn registry(env: Env) -> Address {
            env.storage().instance().get(&DataKey::Registry).unwrap()
        }

        pub fn set_member(env: Env, dao_id: u64, member: Address, has: bool) {
            let key = DataKey::Member(dao_id, member);
            env.storage().persistent().set(&key, &has);
        }

        pub fn has(env: Env, dao_id: u64, of: Address) -> bool {
            let key = DataKey::Member(dao_id, of);
            env.storage().persistent().get(&key).unwrap_or(false)
        }
    }
}

fn setup_env() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let registry_id = env.register(mock_registry::MockRegistry, ());
    let sbt_id = env.register(mock_sbt::MockSbt, ());
    let tree_id = env.register(MembershipTree, (sbt_id.clone(), registry_id.clone()));

    // Wire up the SBT to point to the registry
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    sbt_client.set_registry(&registry_id);

    let admin = Address::generate(&env);

    (env, tree_id, sbt_id, registry_id, admin)
}

#[test]
fn test_constructor() {
    let env = Env::default();
    env.mock_all_auths();

    let registry_id = env.register(mock_registry::MockRegistry, ());
    let sbt_id = env.register(mock_sbt::MockSbt, ());
    let tree_id = env.register(MembershipTree, (sbt_id.clone(), registry_id.clone()));
    let client = MembershipTreeClient::new(&env, &tree_id);

    assert_eq!(client.sbt_contr(), sbt_id);
}

#[test]
fn test_init_tree() {
    let (env, tree_id, _, registry_id, admin) = setup_env();
    let client = MembershipTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    // Set admin for DAO 1
    registry_client.set_admin(&1u64, &admin);

    client.init_tree(&1u64, &18u32, &admin);

    let (depth, next_index, _root) = client.get_tree_info(&1u64);
    assert_eq!(depth, 18);
    assert_eq!(next_index, 0);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_init_tree_twice_fails() {
    let (env, tree_id, _, registry_id, admin) = setup_env();
    let client = MembershipTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    registry_client.set_admin(&1u64, &admin);
    client.init_tree(&1u64, &18u32, &admin);
    client.init_tree(&1u64, &18u32, &admin);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_init_tree_invalid_depth() {
    let (env, tree_id, _, registry_id, admin) = setup_env();
    let client = MembershipTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    registry_client.set_admin(&1u64, &admin);
    client.init_tree(&1u64, &0u32, &admin);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_init_tree_depth_exceeds_max_fails() {
    let (env, tree_id, _, registry_id, admin) = setup_env();
    let client = MembershipTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    registry_client.set_admin(&1u64, &admin);
    // Depth 19 exceeds MAX_TREE_DEPTH of 18
    client.init_tree(&1u64, &19u32, &admin);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_init_tree_depth_extremely_large_fails() {
    let (env, tree_id, _, registry_id, admin) = setup_env();
    let client = MembershipTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    registry_client.set_admin(&1u64, &admin);
    // Depth 32 far exceeds MAX_TREE_DEPTH
    client.init_tree(&1u64, &32u32, &admin);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_init_tree_non_admin_fails() {
    let (env, tree_id, _, registry_id, admin) = setup_env();
    let client = MembershipTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    // Set admin for DAO 1
    registry_client.set_admin(&1u64, &admin);

    // Try to init with non-admin
    let non_admin = Address::generate(&env);
    client.init_tree(&1u64, &20u32, &non_admin);
}

#[test]
fn test_register_commitment() {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let member = Address::generate(&env);

    // Setup: set admin, init tree and give member SBT (use small depth for tests)
    registry_client.set_admin(&1u64, &admin);
    tree_client.init_tree(&1u64, &5u32, &admin);
    sbt_client.set_member(&1u64, &member, &true);

    let commitment = U256::from_u32(&env, 12345);
    tree_client.register_with_caller(&1u64, &commitment, &member);

    let (_, next_index, _) = tree_client.get_tree_info(&1u64);
    assert_eq!(next_index, 1);

    let leaf_index = tree_client.get_leaf_index(&1u64, &commitment);
    assert_eq!(leaf_index, 0);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_register_without_sbt_fails() {
    let (env, tree_id, _, registry_id, admin) = setup_env();
    let client = MembershipTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let member = Address::generate(&env);

    registry_client.set_admin(&1u64, &admin);
    client.init_tree(&1u64, &5u32, &admin);

    let commitment = U256::from_u32(&env, 12345);
    client.register_with_caller(&1u64, &commitment, &member);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_register_duplicate_commitment_fails() {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let member = Address::generate(&env);

    registry_client.set_admin(&1u64, &admin);
    tree_client.init_tree(&1u64, &5u32, &admin);
    sbt_client.set_member(&1u64, &member, &true);

    let commitment = U256::from_u32(&env, 12345);
    tree_client.register_with_caller(&1u64, &commitment, &member);
    tree_client.register_with_caller(&1u64, &commitment, &member);
}

#[test]
fn test_root_changes_after_registration() {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let member = Address::generate(&env);

    registry_client.set_admin(&1u64, &admin);
    tree_client.init_tree(&1u64, &5u32, &admin);
    sbt_client.set_member(&1u64, &member, &true);

    let root_before = tree_client.current_root(&1u64);

    let commitment = U256::from_u32(&env, 12345);
    tree_client.register_with_caller(&1u64, &commitment, &member);

    let root_after = tree_client.current_root(&1u64);
    assert_ne!(root_before, root_after);
}

#[test]
fn test_old_root_still_valid() {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let member = Address::generate(&env);

    registry_client.set_admin(&1u64, &admin);
    tree_client.init_tree(&1u64, &5u32, &admin);
    sbt_client.set_member(&1u64, &member, &true);

    let root_before = tree_client.current_root(&1u64);

    let commitment = U256::from_u32(&env, 12345);
    tree_client.register_with_caller(&1u64, &commitment, &member);

    // Old root should still be valid
    assert!(tree_client.root_ok(&1u64, &root_before));

    let root_after = tree_client.current_root(&1u64);
    assert!(tree_client.root_ok(&1u64, &root_after));
}

#[test]
fn test_invalid_root_rejected() {
    let (env, tree_id, _, registry_id, admin) = setup_env();
    let client = MembershipTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    registry_client.set_admin(&1u64, &admin);
    client.init_tree(&1u64, &5u32, &admin);

    let fake_root = U256::from_u32(&env, 999999);
    assert!(!client.root_ok(&1u64, &fake_root));
}

#[test]
fn test_different_daos_have_separate_trees() {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let member = Address::generate(&env);

    // Init two DAOs with different depths
    registry_client.set_admin(&1u64, &admin);
    registry_client.set_admin(&2u64, &admin);
    tree_client.init_tree(&1u64, &4u32, &admin);
    tree_client.init_tree(&2u64, &6u32, &admin);

    sbt_client.set_member(&1u64, &member, &true);
    sbt_client.set_member(&2u64, &member, &true);

    // Register in DAO 1
    let commitment1 = U256::from_u32(&env, 11111);
    tree_client.register_with_caller(&1u64, &commitment1, &member);

    // DAO 1 should have 1 commitment
    let (depth1, next1, _) = tree_client.get_tree_info(&1u64);
    assert_eq!(depth1, 4);
    assert_eq!(next1, 1);

    // DAO 2 should still have 0 commitments
    let (depth2, next2, _) = tree_client.get_tree_info(&2u64);
    assert_eq!(depth2, 6);
    assert_eq!(next2, 0);
}

#[test]
fn test_multiple_registrations() {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let member1 = Address::generate(&env);
    let member2 = Address::generate(&env);
    let member3 = Address::generate(&env);

    registry_client.set_admin(&1u64, &admin);
    tree_client.init_tree(&1u64, &5u32, &admin);
    sbt_client.set_member(&1u64, &member1, &true);
    sbt_client.set_member(&1u64, &member2, &true);
    sbt_client.set_member(&1u64, &member3, &true);

    let c1 = U256::from_u32(&env, 111);
    let c2 = U256::from_u32(&env, 222);
    let c3 = U256::from_u32(&env, 333);

    tree_client.register_with_caller(&1u64, &c1, &member1);
    tree_client.register_with_caller(&1u64, &c2, &member2);
    tree_client.register_with_caller(&1u64, &c3, &member3);

    let (_, next_index, _) = tree_client.get_tree_info(&1u64);
    assert_eq!(next_index, 3);

    assert_eq!(tree_client.get_leaf_index(&1u64, &c1), 0);
    assert_eq!(tree_client.get_leaf_index(&1u64, &c2), 1);
    assert_eq!(tree_client.get_leaf_index(&1u64, &c3), 2);
}

#[test]
fn test_root_history_eviction_after_30_updates() {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    registry_client.set_admin(&1u64, &admin);
    tree_client.init_tree(&1u64, &5u32, &admin);

    // Register 31 members to trigger root eviction (MAX_ROOTS = 30)
    let mut first_root = tree_client.current_root(&1u64);
    let mut members = soroban_sdk::vec![&env];

    for i in 0u32..31 {
        let member = Address::generate(&env);
        members.push_back(member.clone());
        sbt_client.set_member(&1u64, &member, &true);

        let commitment = U256::from_u128(&env, (i as u128) * 1000 + 12345);
        tree_client.register_with_caller(&1u64, &commitment, &member);

        if i == 0 {
            // Save first root after first registration
            first_root = tree_client.current_root(&1u64);
        }
    }

    // First root should now be evicted (only last 30 roots kept)
    // After 31 registrations: we have initial root + 31 new roots = 32 total
    // But only last 30 are kept
    assert!(!tree_client.root_ok(&1u64, &first_root));

    // Current root should still be valid
    let current = tree_client.current_root(&1u64);
    assert!(tree_client.root_ok(&1u64, &current));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_tree_full_small_depth() {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    // Depth 2 = max 4 leaves (2^2)
    registry_client.set_admin(&1u64, &admin);
    tree_client.init_tree(&1u64, &2u32, &admin);

    // Fill tree with 4 commitments
    for i in 0u32..4 {
        let member = Address::generate(&env);
        sbt_client.set_member(&1u64, &member, &true);
        let commitment = U256::from_u32(&env, i * 100);
        tree_client.register_with_caller(&1u64, &commitment, &member);
    }

    // 5th commitment should panic due to full tree
    let member5 = Address::generate(&env);
    sbt_client.set_member(&1u64, &member5, &true);
    let commitment5 = U256::from_u32(&env, 500);
    tree_client.register_with_caller(&1u64, &commitment5, &member5);
}
