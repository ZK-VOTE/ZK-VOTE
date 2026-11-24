use super::*;
use soroban_sdk::{testutils::Address as _, Env};

extern crate std;

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

    client.init_tree(&1u64, &18u32, &Symbol::new(&env, "BN254"), &admin);

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
    client.init_tree(&1u64, &18u32, &Symbol::new(&env, "BN254"), &admin);
    client.init_tree(&1u64, &18u32, &Symbol::new(&env, "BN254"), &admin);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_init_tree_invalid_depth() {
    let (env, tree_id, _, registry_id, admin) = setup_env();
    let client = MembershipTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    registry_client.set_admin(&1u64, &admin);
    client.init_tree(&1u64, &0u32, &Symbol::new(&env, "BN254"), &admin);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_init_tree_depth_exceeds_max_fails() {
    let (env, tree_id, _, registry_id, admin) = setup_env();
    let client = MembershipTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    registry_client.set_admin(&1u64, &admin);
    // Depth 19 exceeds MAX_TREE_DEPTH of 18
    client.init_tree(&1u64, &19u32, &Symbol::new(&env, "BN254"), &admin);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_init_tree_depth_extremely_large_fails() {
    let (env, tree_id, _, registry_id, admin) = setup_env();
    let client = MembershipTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    registry_client.set_admin(&1u64, &admin);
    // Depth 32 far exceeds MAX_TREE_DEPTH
    client.init_tree(&1u64, &32u32, &Symbol::new(&env, "BN254"), &admin);
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
    client.init_tree(&1u64, &20u32, &Symbol::new(&env, "BN254"), &non_admin);
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
    tree_client.init_tree(&1u64, &5u32, &Symbol::new(&env, "BN254"), &admin);
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
    client.init_tree(&1u64, &5u32, &Symbol::new(&env, "BN254"), &admin);

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
    tree_client.init_tree(&1u64, &5u32, &Symbol::new(&env, "BN254"), &admin);
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
    tree_client.init_tree(&1u64, &5u32, &Symbol::new(&env, "BN254"), &admin);
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
    tree_client.init_tree(&1u64, &5u32, &Symbol::new(&env, "BN254"), &admin);
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
    client.init_tree(&1u64, &5u32, &Symbol::new(&env, "BN254"), &admin);

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
    tree_client.init_tree(&1u64, &4u32, &Symbol::new(&env, "BN254"), &admin);
    tree_client.init_tree(&2u64, &6u32, &Symbol::new(&env, "BN254"), &admin);

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
    tree_client.init_tree(&1u64, &5u32, &Symbol::new(&env, "BN254"), &admin);
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
    tree_client.init_tree(&1u64, &5u32, &Symbol::new(&env, "BN254"), &admin);

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
    tree_client.init_tree(&1u64, &2u32, &Symbol::new(&env, "BN254"), &admin);

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

#[test]
#[should_panic(expected = "Error(Contract, #16)")]
fn test_duplicate_commitment_different_address_fails() {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    registry_client.set_admin(&1u64, &admin);
    tree_client.init_tree(&1u64, &5u32, &Symbol::new(&env, "BN254"), &admin);

    let member_a = Address::generate(&env);
    let member_b = Address::generate(&env);
    sbt_client.set_member(&1u64, &member_a, &true);
    sbt_client.set_member(&1u64, &member_b, &true);

    let commitment = U256::from_u32(&env, 42);
    tree_client.register_with_caller(&1u64, &commitment, &member_a);
    tree_client.register_with_caller(&1u64, &commitment, &member_b);
}

// #167: leaves must be domain-separated (Poseidon(LEAF_DOMAIN, leaf)) before
// entering the tree, not inserted as a raw commitment. Regression-tests that:
//   1. the leaf's domain-tagged hash differs from the raw commitment, and
//   2. independently reconstructing the root from get_merkle_path's siblings
//      using that same domain-tagged leaf hash reproduces get_root's value —
//      i.e. the on-chain tree and an off-chain verifier (frontend/circuit)
//      that domain-tags leaves the same way stay in agreement.
#[test]
fn test_leaf_is_domain_separated_before_tree_insertion() {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let member_a = Address::generate(&env);
    let member_b = Address::generate(&env);

    registry_client.set_admin(&1u64, &admin);
    tree_client.init_tree(&1u64, &3u32, &Symbol::new(&env, "BN254"), &admin);
    sbt_client.set_member(&1u64, &member_a, &true);
    sbt_client.set_member(&1u64, &member_b, &true);

    let commitment_a = U256::from_u32(&env, 111);
    let commitment_b = U256::from_u32(&env, 222);
    tree_client.register_with_caller(&1u64, &commitment_a, &member_a);
    tree_client.register_with_caller(&1u64, &commitment_b, &member_b);

    let field = Symbol::new(&env, "BN254");
    let leaf_domain = U256::from_u32(&env, 1);

    // 1. The domain-tagged leaf hash must differ from the raw commitment —
    // otherwise leaves would still be indistinguishable from arbitrary
    // internal-node hashes.
    let leaf_hash_a = tree_client.test_poseidon_hash(&leaf_domain, &commitment_a, &field);
    assert_ne!(leaf_hash_a, commitment_a);

    // 2. Rebuild the root off-chain using get_merkle_path's siblings and the
    // same domain-tagged leaf hash the circuit/frontend would compute, and
    // confirm it matches get_root.
    let (path_elements, path_indices) = tree_client.get_merkle_path(&1u64, &0u32);
    let mut current = leaf_hash_a;
    for i in 0..path_elements.len() {
        let sibling = path_elements.get(i).unwrap();
        let is_left = path_indices.get(i).unwrap() == 0;
        current = if is_left {
            tree_client.test_poseidon_hash(&current, &sibling, &field)
        } else {
            tree_client.test_poseidon_hash(&sibling, &current, &field)
        };
    }

    assert_eq!(current, tree_client.get_root(&1u64));
}

// #371: per-member commitment registration cooldown. A member cannot register
// another commitment until MIN_REGISTRATION_INTERVAL_SECS (3600s) have elapsed.
use soroban_sdk::testutils::Ledger as _;
use soroban_sdk::Address;

fn set_timestamp(env: &Env, timestamp: u64) {
    let mut info = env.ledger().get();
    info.timestamp = timestamp;
    env.ledger().set(info);
}

/// Register `commitment` for a fresh member in `dao_id` at the given timestamp.
/// Returns (env, tree_id, sbt_id, registry_id, admin, member).
fn register_member(
    dao_id: u64,
    commitment: u32,
    timestamp: u64,
) -> (Env, Address, Address, Address, Address, Address) {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    set_timestamp(&env, timestamp);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let member = Address::generate(&env);

    registry_client.set_admin(&dao_id, &admin);
    tree_client.init_tree(&dao_id, &5u32, &Symbol::new(&env, "BN254"), &admin);
    sbt_client.set_member(&dao_id, &member, &true);
    tree_client.register_with_caller(&dao_id, &U256::from_u32(&env, commitment), &member);

    (env, tree_id, sbt_id, registry_id, admin, member)
}

fn panic_message(
    client: &MembershipTreeClient,
    dao_id: u64,
    commitment: U256,
    member: &Address,
) -> Option<std::string::String> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        client.register_with_caller(&dao_id, &commitment, member);
    }));
    match result {
        Ok(_) => None,
        Err(payload) => {
            let msg = if let Some(s) = payload.downcast_ref::<std::string::String>() {
                s.clone()
            } else if let Some(s) = payload.downcast_ref::<&str>() {
                std::string::String::from(*s)
            } else {
                std::string::String::from("unknown panic payload")
            };
            Some(msg)
        }
    }
}

#[test]
fn test_register_within_cooldown_rate_limited() {
    let (env, tree_id, _sbt_id, _registry_id, _admin, member) =
        register_member(1u64, 12345, 1_000_000);

    // Advance inside the cooldown window and attempt a re-registration.
    set_timestamp(&env, 1_001_800);
    let client = MembershipTreeClient::new(&env, &tree_id);
    let msg = panic_message(&client, 1u64, U256::from_u32(&env, 54321), &member);
    let msg = msg.expect("re-registration within cooldown should panic");
    assert!(
        msg.contains("#17"),
        "expected RateLimited error #17, got: {msg}"
    );

    // The original registration is untouched.
    let client = MembershipTreeClient::new(&env, &tree_id);
    assert_eq!(client.get_tree_info(&1u64).1, 1);
}

#[test]
fn test_register_after_cooldown_allowed() {
    let (env, tree_id, _sbt_id, _registry_id, _admin, member) =
        register_member(1u64, 12345, 1_000_000);

    // Past the cooldown window: the cooldown no longer blocks; the member is
    // instead rejected by the existing member-exists rule (#6) — proving the
    // window expired without letting a duplicate registration through.
    set_timestamp(&env, 1_003_600);
    let client = MembershipTreeClient::new(&env, &tree_id);
    let msg = panic_message(&client, 1u64, U256::from_u32(&env, 54321), &member);
    let msg = msg.expect("re-registration after cooldown should be rejected downstream");
    assert!(
        msg.contains("#6"),
        "expected MemberExists error #6 after cooldown, got: {msg}"
    );
    assert!(
        !msg.contains("#17"),
        "cooldown should have expired, got RateLimited {msg}"
    );
}

#[test]
fn test_registration_cooldown_is_per_member_and_per_dao() {
    let (env, tree_id, sbt_id, registry_id, admin, member) = register_member(1u64, 111, 1_000_000);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    // Different member in the same DAO/window is unaffected.
    let other = Address::generate(&env);
    sbt_client.set_member(&1u64, &other, &true);
    tree_client.register_with_caller(&1u64, &U256::from_u32(&env, 222), &other);

    // Same member in a different DAO/window is unaffected (per-dao scoping).
    registry_client.set_admin(&2u64, &admin);
    tree_client.init_tree(&2u64, &5u32, &Symbol::new(&env, "BN254"), &admin);
    sbt_client.set_member(&2u64, &member, &true);
    tree_client.register_with_caller(&2u64, &U256::from_u32(&env, 333), &member);

    let (_, next_index, _) = tree_client.get_tree_info(&1u64);
    assert_eq!(next_index, 2);
}

// ── Commit-reveal registration (anti-front-running) ────────────────────────

fn setup_tree_with_member() -> (Env, Address, Address, Address, Address, Address) {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let member = Address::generate(&env);

    registry_client.set_admin(&1u64, &admin);
    tree_client.init_tree(&1u64, &5u32, &Symbol::new(&env, "BN254"), &admin);
    sbt_client.set_member(&1u64, &member, &true);
    (env, tree_id, sbt_id, registry_id, admin, member)
}

#[test]
fn test_commit_reveal_registration_hides_then_inserts() {
    use soroban_sdk::testutils::Ledger as _;
    let (env, tree_id, _sbt_id, _registry_id, _admin, member) = setup_tree_with_member();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);

    let commitment = U256::from_u32(&env, 424242);
    let salt = BytesN::from_array(&env, &[7u8; 32]);
    let commit_hash = tree_client.hash_registration(&commitment, &salt);

    tree_client.commit_registration(&1u64, &commit_hash, &member);
    let pending = tree_client.pending_registration(&1u64, &member).unwrap();
    assert_eq!(pending.commitment_hash, commit_hash);
    // The tree is untouched until reveal.
    let (_, next_index, _) = tree_client.get_tree_info(&1u64);
    assert_eq!(next_index, 0);

    env.ledger().with_mut(|li| li.sequence_number += 1);
    tree_client.reveal_registration(&1u64, &commitment, &salt, &member);

    let (_, next_index_after, _) = tree_client.get_tree_info(&1u64);
    assert_eq!(next_index_after, 1);
    assert_eq!(tree_client.get_leaf_index(&1u64, &commitment), 0);
    assert!(tree_client.pending_registration(&1u64, &member).is_none());
}

#[test]
#[should_panic(expected = "HostError")]
fn test_commit_reveal_same_ledger_fails() {
    let (env, tree_id, _sbt_id, _registry_id, _admin, member) = setup_tree_with_member();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let commitment = U256::from_u32(&env, 777);
    let salt = BytesN::from_array(&env, &[9u8; 32]);
    let commit_hash = tree_client.hash_registration(&commitment, &salt);
    tree_client.commit_registration(&1u64, &commit_hash, &member);
    tree_client.reveal_registration(&1u64, &commitment, &salt, &member);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_commit_reveal_wrong_salt_fails() {
    use soroban_sdk::testutils::Ledger as _;
    let (env, tree_id, _sbt_id, _registry_id, _admin, member) = setup_tree_with_member();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let commitment = U256::from_u32(&env, 888);
    let salt = BytesN::from_array(&env, &[1u8; 32]);
    let wrong_salt = BytesN::from_array(&env, &[2u8; 32]);
    let commit_hash = tree_client.hash_registration(&commitment, &salt);
    tree_client.commit_registration(&1u64, &commit_hash, &member);
    env.ledger().with_mut(|li| li.sequence_number += 1);
    tree_client.reveal_registration(&1u64, &commitment, &wrong_salt, &member);
}

// ── Epoch checkpointing (stale-revocation pinning) ─────────────────────────

#[test]
fn test_epoch_zero_is_the_initial_root() {
    let (env, tree_id, _sbt_id, _registry_id, _admin) = setup_env();
    let registry_client = mock_registry::MockRegistryClient::new(&env, &_registry_id);
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    registry_client.set_admin(&1u64, &_admin);
    tree_client.init_tree(&1u64, &5u32, &Symbol::new(&env, "BN254"), &_admin);

    assert_eq!(tree_client.current_epoch(&1u64), 0);
    assert_eq!(
        tree_client.epoch_root(&1u64, &0u32),
        tree_client.current_root(&1u64)
    );
    assert!(tree_client.epoch_root_ok(&1u64, &0u32, &tree_client.current_root(&1u64)));
}

#[test]
fn test_advance_epoch_checkpoints_each_root() {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let member = Address::generate(&env);

    registry_client.set_admin(&1u64, &admin);
    tree_client.init_tree(&1u64, &5u32, &Symbol::new(&env, "BN254"), &admin);
    sbt_client.set_member(&1u64, &member, &true);

    let epoch0_root = tree_client.current_root(&1u64);
    assert_eq!(tree_client.advance_epoch(&1u64, &admin), 1);
    assert_eq!(tree_client.epoch_root(&1u64, &1u32), epoch0_root);

    tree_client.register_with_caller(&1u64, &U256::from_u32(&env, 555), &member);
    let epoch1_root = tree_client.current_root(&1u64);
    assert_ne!(epoch1_root, epoch0_root);
    assert_eq!(tree_client.advance_epoch(&1u64, &admin), 2);
    assert_eq!(tree_client.epoch_root(&1u64, &2u32), epoch1_root);

    // Old epoch roots are immutable checkpoints.
    assert_eq!(tree_client.epoch_root(&1u64, &1u32), epoch0_root);
    assert!(!tree_client.epoch_root_ok(&1u64, &2u32, &epoch0_root));
    assert!(tree_client.epoch_root_ok(&1u64, &2u32, &epoch1_root));
}

// ---------------------------------------------------------------------------
// Regression: the update path must keep the cached left-sibling subtrees
// (`FilledSubtrees`) in sync with the recomputed path.
//
// `insert_leaf` composes the right child of a pair from the *cached* left
// subtree. `update_leaf` (revocation / reinstatement) previously recomputed
// `NodeHash` up to the root but never wrote `filled`, so the cache stayed
// pinned to the pre-removal subtree hash. The next insert that made a left
// child at some level L therefore spliced a stale hash into a brand-new root.
//
// That root is a lie in the most damaging way possible: `root_ok` is a linear
// scan of `Roots`, and the bogus root is pushed into `Roots` + `RootIndex`, so
// the tree *reports it as valid* while no `get_merkle_path` can reproduce it.
// Every honest member's next ZK proof then fails — irreversibly.
// ---------------------------------------------------------------------------

/// Drive the internal update path (`update_leaf`) directly, inside the
/// contract's storage context. `remove_member` needs an SBT `revoke` that the
/// mock does not implement; the storage effect under test is identical.
fn update_leaf_via(env: &Env, tree_id: &Address, dao_id: u64, leaf_index: u32, new_value: U256) {
    env.as_contract(tree_id, || {
        MembershipTree::update_leaf(env, dao_id, leaf_index, new_value)
    });
}

/// Recompute a root purely from the public `get_merkle_path` output, using the
/// same Poseidon/leaf-domain rules the contract and circuit use. This is the
/// honest prover's view, so it is the only trustworthy oracle for "is this
/// root real?".
fn root_from_merkle_path(
    env: &Env,
    tree_id: &Address,
    dao_id: u64,
    leaf_index: u32,
    leaf: U256,
) -> (U256, u32) {
    let field = Symbol::new(env, "BN254");
    let (path_elements, path_indices) = env.as_contract(tree_id, || {
        MembershipTree::get_merkle_path(env.clone(), dao_id, leaf_index)
    });

    let mut current = env.as_contract(tree_id, || {
        MembershipTree::hash_leaf(env, &leaf, &Symbol::new(env, "BN254"))
    });
    for i in 0..path_elements.len() {
        let sibling = path_elements.get(i).unwrap();
        let is_left = path_indices.get(i).unwrap() == 0;
        let (left, right) = if is_left {
            (current.clone(), sibling)
        } else {
            (sibling, current.clone())
        };
        current = env.as_contract(tree_id, || {
            MembershipTree::hash_pair(env, &left, &right, &field)
        });
    }
    (current, leaf_index)
}

/// Assert that `current_root()` is reproducible from the merkle path of every
/// populated leaf, i.e. the tree is internally consistent for honest members.
fn assert_root_reproducible(env: &Env, tree_id: &Address, dao_id: u64, leaves: &[U256]) {
    let client = MembershipTreeClient::new(env, tree_id);
    let current_root = client.current_root(&dao_id);

    assert!(
        client.root_ok(&dao_id, &current_root),
        "current_root must be present in the root history"
    );

    for (index, leaf) in leaves.iter().enumerate() {
        let (recomputed, _) =
            root_from_merkle_path(env, tree_id, dao_id, index as u32, leaf.clone());
        assert_eq!(
            recomputed, current_root,
            "leaf {index}: merkle path recomputation does not match current_root. \
             The tree published a root that no member can produce a proof for."
        );
    }
}

/// The reported exploit, end to end: a depth-4 DAO, admin removes leaf 3, then
/// members 12..15 register. Insert 12 forms a right child at level 2
/// (current_index == 3), which is exactly where the stale `filled[2]` used to
/// be spliced in. With the bug this yields a root that is in `Roots` (so
/// `root_ok` says true) yet no merkle path can reproduce.
#[test]
fn test_root_stays_reproducible_after_removal_then_more_registrations() {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let dao_id = 1u64;
    let depth = 4u32; // 16 leaves
    registry_client.set_admin(&dao_id, &admin);
    tree_client.init_tree(&dao_id, &depth, &Symbol::new(&env, "BN254"), &admin);

    // Members 0..11 register (next leaf index is now 12).
    let mut leaves = std::vec::Vec::new();
    for i in 0..12u32 {
        let member = Address::generate(&env);
        sbt_client.set_member(&dao_id, &member, &true);
        let commitment = U256::from_u32(&env, 0x1000 + i);
        tree_client.register_with_caller(&dao_id, &commitment, &member);
        leaves.push(commitment);
    }
    assert_eq!(tree_client.get_tree_info(&dao_id).1, 12);

    // Sanity: the append-only tree is consistent before the removal.
    assert_root_reproducible(&env, &tree_id, dao_id, &leaves);

    // Admin removes leaf 3: the leaf is zeroed and the root is recomputed.
    // This goes through update_leaf, which is where the cache used to go stale.
    update_leaf_via(&env, &tree_id, dao_id, 3, U256::from_u32(&env, 0));
    leaves[3] = U256::from_u32(&env, 0);

    assert_root_reproducible(&env, &tree_id, dao_id, &leaves);

    // Members 12..15 now register. Insert 12 is a right child at level 2 —
    // the exact position that consumed the stale cached subtree hash.
    for i in 12..16u32 {
        let member = Address::generate(&env);
        sbt_client.set_member(&dao_id, &member, &true);
        let commitment = U256::from_u32(&env, 0x1000 + i);
        tree_client.register_with_caller(&dao_id, &commitment, &member);
        leaves.push(commitment);
    }
    assert_eq!(tree_client.get_tree_info(&dao_id).1, 16);

    // The published root must still be derivable by every member.
    assert_root_reproducible(&env, &tree_id, dao_id, &leaves);
}

/// Same regression, but for the reinstatement direction: zeroing a leaf and
/// restoring it must not leave a stale cache behind either.
#[test]
fn test_root_stays_reproducible_after_reinstatement_then_registration() {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let dao_id = 1u64;
    let depth = 4u32;
    registry_client.set_admin(&dao_id, &admin);
    tree_client.init_tree(&dao_id, &depth, &Symbol::new(&env, "BN254"), &admin);

    let mut leaves = std::vec::Vec::new();
    for i in 0..8u32 {
        let member = Address::generate(&env);
        sbt_client.set_member(&dao_id, &member, &true);
        let commitment = U256::from_u32(&env, 0x2000 + i);
        tree_client.register_with_caller(&dao_id, &commitment, &member);
        leaves.push(commitment);
    }

    // Remove leaf 2, then reinstate it by writing the original commitment back.
    update_leaf_via(&env, &tree_id, dao_id, 2, U256::from_u32(&env, 0));
    leaves[2] = U256::from_u32(&env, 0);
    assert_root_reproducible(&env, &tree_id, dao_id, &leaves);

    update_leaf_via(&env, &tree_id, dao_id, 2, U256::from_u32(&env, 0x2002));
    leaves[2] = U256::from_u32(&env, 0x2002);
    assert_root_reproducible(&env, &tree_id, dao_id, &leaves);

    // And the tree must still accept further registrations coherently.
    for i in 8..12u32 {
        let member = Address::generate(&env);
        sbt_client.set_member(&dao_id, &member, &true);
        let commitment = U256::from_u32(&env, 0x2000 + i);
        tree_client.register_with_caller(&dao_id, &commitment, &member);
        leaves.push(commitment);
    }
    assert_root_reproducible(&env, &tree_id, dao_id, &leaves);
}

/// Interleaved removals and inserts at every level. This is the property that
/// actually matters and that no existing test asserted: *for all* populated
/// leaves, the merkle path reproduces the current root.
#[test]
fn test_root_reproducible_under_interleaved_removals_and_inserts() {
    let (env, tree_id, sbt_id, registry_id, admin) = setup_env();
    let tree_client = MembershipTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let dao_id = 1u64;
    let depth = 5u32; // 32 leaves
    registry_client.set_admin(&dao_id, &admin);
    tree_client.init_tree(&dao_id, &depth, &Symbol::new(&env, "BN254"), &admin);

    // Fill 20 leaves.
    let mut leaves = std::vec::Vec::new();
    for i in 0..20u32 {
        let member = Address::generate(&env);
        sbt_client.set_member(&dao_id, &member, &true);
        let commitment = U256::from_u32(&env, 0x3000 + i);
        tree_client.register_with_caller(&dao_id, &commitment, &member);
        leaves.push(commitment);
    }
    assert_root_reproducible(&env, &tree_id, dao_id, &leaves);

    // Remove one leaf per distinct level, checking consistency after each step:
    // 1 (level 5), 6 (level 2/3), 11, 17 (right children of pairs).
    for victim in [1u32, 6u32, 11u32, 17u32] {
        update_leaf_via(&env, &tree_id, dao_id, victim, U256::from_u32(&env, 0));
        leaves[victim as usize] = U256::from_u32(&env, 0);
        assert_root_reproducible(&env, &tree_id, dao_id, &leaves);
    }

    // Append across the level-4 boundary, forcing right children at several
    // levels against caches that were invalidated by the removals.
    for i in 20..24u32 {
        let member = Address::generate(&env);
        sbt_client.set_member(&dao_id, &member, &true);
        let commitment = U256::from_u32(&env, 0x3000 + i);
        tree_client.register_with_caller(&dao_id, &commitment, &member);
        leaves.push(commitment);
        assert_root_reproducible(&env, &tree_id, dao_id, &leaves);
    }

    // Reinstate two of the removed leaves, then append again.
    for restored in [6u32, 17u32] {
        update_leaf_via(
            &env,
            &tree_id,
            dao_id,
            restored,
            U256::from_u32(&env, 0x3000 + restored),
        );
        leaves[restored as usize] = U256::from_u32(&env, 0x3000 + restored);
        assert_root_reproducible(&env, &tree_id, dao_id, &leaves);
    }
}
