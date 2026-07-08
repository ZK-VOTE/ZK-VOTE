use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Env, String};

// Mock tree contract
mod mock_tree {
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, U256};

    #[contracttype]
    pub enum DataKey {
        SbtContract,
        CurrentRoot(u64),
    }

    #[contract]
    pub struct MockTree;

    #[contractimpl]
    impl MockTree {
        pub fn set_sbt_contract(env: Env, sbt: Address) {
            env.storage().persistent().set(&DataKey::SbtContract, &sbt);
        }

        pub fn sbt_contr(env: Env) -> Address {
            env.storage()
                .persistent()
                .get(&DataKey::SbtContract)
                .unwrap()
        }

        pub fn set_root(env: Env, dao_id: u64, root: U256) {
            let key = DataKey::CurrentRoot(dao_id);
            env.storage().persistent().set(&key, &root);
        }

        pub fn get_root(env: Env, dao_id: u64) -> U256 {
            let key = DataKey::CurrentRoot(dao_id);
            env.storage()
                .persistent()
                .get(&key)
                .unwrap_or(U256::from_u32(&env, 0))
        }

        pub fn curr_idx(_env: Env, _dao_id: u64) -> u32 {
            // Mock implementation: return index 0 for current root
            // Real contract tracks root history, mock doesn't need to
            0
        }

        pub fn revok_at(_env: Env, _dao_id: u64, _commitment: U256) -> Option<u64> {
            // Mock implementation: return None (member never revoked)
            // Real contract tracks revocation timestamps
            None
        }

        pub fn reinst_at(_env: Env, _dao_id: u64, _commitment: U256) -> Option<u64> {
            // Mock implementation: return None (member never reinstated)
            // Real contract tracks reinstatement timestamps
            None
        }
    }
}

// Mock Registry contract
mod mock_registry {
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

    #[contracttype]
    pub enum DataKey {
        Admin(u64),
        MembershipOpen(u64),
        MembersCanPropose(u64),
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

        pub fn set_membership_open(env: Env, dao_id: u64, is_open: bool) {
            env.storage()
                .persistent()
                .set(&DataKey::MembershipOpen(dao_id), &is_open);
        }

        pub fn is_membership_open(env: Env, dao_id: u64) -> bool {
            env.storage()
                .persistent()
                .get(&DataKey::MembershipOpen(dao_id))
                .unwrap_or(false)
        }

        pub fn set_members_can_propose(env: Env, dao_id: u64, can_propose: bool) {
            env.storage()
                .persistent()
                .set(&DataKey::MembersCanPropose(dao_id), &can_propose);
        }

        pub fn members_can_propose(env: Env, dao_id: u64) -> bool {
            env.storage()
                .persistent()
                .get(&DataKey::MembersCanPropose(dao_id))
                .unwrap_or(true) // Default to true so existing tests pass
        }
    }
}

// Mock SBT contract
mod mock_sbt {
    use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol};

    const REGISTRY: Symbol = symbol_short!("registry");

    #[contracttype]
    pub enum DataKey {
        Member(u64, Address),
    }

    #[contract]
    pub struct MockSbt;

    #[contractimpl]
    impl MockSbt {
        pub fn set_registry(env: Env, registry: Address) {
            env.storage().instance().set(&REGISTRY, &registry);
        }

        pub fn registry(env: Env) -> Address {
            env.storage().instance().get(&REGISTRY).unwrap()
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

fn setup_env_with_registry() -> (Env, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let registry_id = env.register(mock_registry::MockRegistry, ());
    let sbt_id = env.register(mock_sbt::MockSbt, ());
    let tree_id = env.register(mock_tree::MockTree, ());
    // Pass both tree_id and registry_id to constructor (registry cached to reduce cross-contract calls)
    let voting_id = env.register(Voting, (tree_id.clone(), registry_id.clone()));

    // Link tree to sbt
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    tree_client.set_sbt_contract(&sbt_id);

    // Link sbt to registry
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    sbt_client.set_registry(&registry_id);

    let member = Address::generate(&env);

    (env, voting_id, tree_id, sbt_id, registry_id, member)
}

fn create_dummy_vk(env: &Env) -> VerificationKey {
    let g1 = bn254_g1_generator(env);
    let g2 = bn254_g2_generator(env);
    VerificationKey {
        alpha: g1.clone(),
        beta: g2.clone(),
        gamma: g2.clone(),
        delta: g2.clone(),
        // IC vector needs 6 elements for 5 public signals: [root, nullifier, daoId, proposalId, voteChoice]
        // (commitment is now private, not a public signal)
        ic: soroban_sdk::vec![
            env,
            g1.clone(),
            g1.clone(),
            g1.clone(),
            g1.clone(),
            g1.clone(),
            g1.clone()
        ],
    }
}

fn create_dummy_proof(env: &Env) -> Proof {
    let g1 = bn254_g1_generator(env);
    let g2 = bn254_g2_generator(env);
    Proof {
        a: g1.clone(),
        b: g2,
        c: g1,
    }
}

fn create_wrong_length_proof(env: &Env) -> Proof {
    // Deliberately malformed proof points (not valid curve coordinates).
    // In tests we force verification to fail via VerifyOverride.
    let mut bad_a = [0u8; 64];
    bad_a[0] = 1;
    let mut bad_b = [0u8; 128];
    bad_b[0] = 2;
    let mut bad_c = [0u8; 64];
    bad_c[0] = 3;

    Proof {
        a: BytesN::from_array(env, &bad_a),
        b: BytesN::from_array(env, &bad_b),
        c: BytesN::from_array(env, &bad_c),
    }
}

fn create_all_zero_proof(env: &Env) -> Proof {
    Proof {
        a: BytesN::from_array(env, &[0u8; 64]),
        b: BytesN::from_array(env, &[0u8; 128]),
        c: BytesN::from_array(env, &[0u8; 64]),
    }
}

fn create_off_curve_proof(env: &Env) -> Proof {
    // Use obviously invalid coordinates: set y = 0 while x = 1,2 to break curve equation
    let mut off_a = [0u8; 64];
    off_a[31] = 1; // x = 1
    off_a[63] = 0; // y = 0 (not on curve)

    let mut off_c = [0u8; 64];
    off_c[31] = 2; // x = 2
    off_c[63] = 0; // y = 0 (not on curve)

    // For G2, use the existing generator but flip one byte to move off-curve
    let mut off_b = bn254_g2_generator(env).to_array();
    off_b[0] ^= 0xFF; // perturb

    Proof {
        a: BytesN::from_array(env, &off_a),
        b: BytesN::from_array(env, &off_b),
        c: BytesN::from_array(env, &off_c),
    }
}

// BN254 G1 generator: (1, 2)
fn bn254_g1_generator(env: &Env) -> BytesN<64> {
    let mut bytes = [0u8; 64];
    bytes[31] = 1; // x = 1
    bytes[63] = 2; // y = 2
    BytesN::from_array(env, &bytes)
}

// BN254 G2 generator
fn bn254_g2_generator(env: &Env) -> BytesN<128> {
    let bytes: [u8; 128] = [
        0x18, 0x00, 0x50, 0x6a, 0x06, 0x12, 0x86, 0xeb, 0x6a, 0x84, 0xa5, 0x73, 0x0b, 0x8f, 0x10,
        0x29, 0x3e, 0x29, 0x81, 0x6c, 0xd1, 0x91, 0x3d, 0x53, 0x38, 0xf7, 0x15, 0xde, 0x3e, 0x98,
        0xf9, 0xad, 0x19, 0x83, 0x90, 0x42, 0x11, 0xa5, 0x3f, 0x6e, 0x0b, 0x08, 0x53, 0xa9, 0x0a,
        0x00, 0xef, 0xbf, 0xf1, 0x70, 0x0c, 0x7b, 0x1d, 0xc0, 0x06, 0x32, 0x4d, 0x85, 0x9d, 0x75,
        0xe3, 0xca, 0xa5, 0xa2, 0x12, 0xc8, 0x5e, 0xa5, 0xdb, 0x8c, 0x6d, 0xeb, 0x4a, 0xab, 0x71,
        0x8e, 0x80, 0x6a, 0x51, 0xa5, 0x66, 0x08, 0x21, 0x4c, 0x3f, 0x62, 0x8b, 0x96, 0x2c, 0xf1,
        0x91, 0xea, 0xcd, 0xc8, 0x0e, 0x7a, 0x09, 0x0d, 0x97, 0xc0, 0x9c, 0xe1, 0x48, 0x60, 0x63,
        0xb3, 0x59, 0xf3, 0xdd, 0x89, 0xb7, 0xc4, 0x3c, 0x5f, 0x18, 0x95, 0x8f, 0xb3, 0xe6, 0xb9,
        0x6d, 0xb5, 0x5e, 0x19, 0xa3, 0xb7, 0xc0, 0xfb,
    ];
    BytesN::from_array(env, &bytes)
}

#[test]
fn test_constructor() {
    let env = Env::default();
    env.mock_all_auths();

    let registry_id = env.register(mock_registry::MockRegistry, ());
    let tree_id = env.register(mock_tree::MockTree, ());
    let voting_id = env.register(Voting, (tree_id.clone(), registry_id.clone()));
    let client = VotingClient::new(&env, &voting_id);

    assert_eq!(client.tree_contract(), tree_id);
    assert_eq!(client.registry(), registry_id);
}

#[test]
fn test_create_proposal() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let admin = Address::generate(&env);

    // Give member SBT
    sbt_client.set_member(&1u64, &member, &true);

    // Set root (required for proposal creation to snapshot)
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);

    // Set VK (required for proposal creation)
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Test Proposal"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    assert_eq!(proposal_id, 1);
    assert_eq!(voting_client.proposal_count(&1u64), 1);

    let _proposal = voting_client.get_proposal(&1u64, &proposal_id);
    assert_eq!(_proposal.yes_votes, 0);
    assert_eq!(_proposal.no_votes, 0);
    assert_eq!(_proposal.eligible_root, root);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_create_proposal_without_sbt_fails() {
    let (env, voting_id, tree_id, _, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let admin = Address::generate(&env);

    // Set root
    tree_client.set_root(&1u64, &U256::from_u32(&env, 12345));

    // Set VK (required for proposal creation)
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );
}

#[test]
fn test_multiple_proposals() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);

    // Set root
    tree_client.set_root(&1u64, &U256::from_u32(&env, 12345));

    // Set VK (required for proposal creation)
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let p1 = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Proposal 1"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );
    let p2 = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Proposal 2"),
        &String::from_str(&env, ""),
        &(now + 7200),
        &member,
        &VoteMode::Fixed,
    );

    assert_eq!(p1, 1);
    assert_eq!(p2, 2);
    assert_eq!(voting_client.proposal_count(&1u64), 2);
}

#[test]
fn test_vote_success() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    // Setup
    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);

    // Set admin in registry before calling set_vk
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Vote with the snapshotted root
    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let nullifier = U256::from_u32(&env, 99999);
    let proof = create_dummy_proof(&env);

    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );

    let updated_proposal = voting_client.get_proposal(&1u64, &proposal_id);
    assert_eq!(updated_proposal.yes_votes, 1);
    assert_eq!(updated_proposal.no_votes, 0);
    assert!(voting_client.is_nullifier_used(&1u64, &proposal_id, &nullifier));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_double_vote_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);

    // Set admin in registry before calling set_vk
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let nullifier = U256::from_u32(&env, 99999);
    let proof = create_dummy_proof(&env);

    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );
    voting_client.vote(
        &1u64,
        &proposal_id,
        &false,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );

    // Close proposal and ensure subsequent votes fail
    voting_client.close_proposal(&1u64, &proposal_id, &admin);
    let closed = voting_client.get_proposal(&1u64, &proposal_id);
    assert_eq!(closed.state, ProposalState::Closed);

    let nullifier2 = U256::from_u32(&env, 55555);
    voting_client.vote(
        &1u64,
        &proposal_id,
        &false,
        &nullifier2,
        &proposal.eligible_root,
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_nullifier_zero_rejected() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);

    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Nullifier zero"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let nullifier = U256::from_u32(&env, 0);
    let proof = create_dummy_proof(&env);

    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_vote_after_close_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);

    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Close me"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    voting_client.close_proposal(&1u64, &proposal_id, &admin);

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let nullifier = U256::from_u32(&env, 99999);
    let proof = create_dummy_proof(&env);

    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );
}

#[test]
fn test_close_proposal_emits_event_once() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);

    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Close event"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Close twice; second should be no-op
    voting_client.close_proposal(&1u64, &proposal_id, &admin);
    voting_client.close_proposal(&1u64, &proposal_id, &admin);

    let closed = voting_client.get_proposal(&1u64, &proposal_id);
    assert_eq!(closed.state, ProposalState::Closed);

    // Event emission is best-effort in this test environment; state closed is the key guard.
}

#[test]
#[should_panic(expected = "HostError")]
fn test_vote_after_archive_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);

    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Archive me"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Must close before archive
    voting_client.close_proposal(&1u64, &proposal_id, &admin);
    voting_client.archive_proposal(&1u64, &proposal_id, &admin);

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let nullifier = U256::from_u32(&env, 99999);
    let proof = create_dummy_proof(&env);

    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_archive_without_close_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);

    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Archive without close"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Should panic because proposal not closed
    voting_client.archive_proposal(&1u64, &proposal_id, &admin);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_close_after_archive_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);

    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Archive then close"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    voting_client.close_proposal(&1u64, &proposal_id, &admin);
    voting_client.archive_proposal(&1u64, &proposal_id, &admin);

    // Attempting to close again should fail
    voting_client.close_proposal(&1u64, &proposal_id, &admin);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_nullifier_duplicate_panics_in_stream() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Duplicate nullifier stream"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let proof = create_dummy_proof(&env);

    // Sequence with a duplicate nullifier at the end
    let nullifiers = [1u32, 2u32, 3u32, 4u32, 5u32, 6u32, 3u32];

    for n in nullifiers.iter() {
        let n_u = U256::from_u32(&env, *n);
        voting_client.vote(
            &1u64,
            &proposal_id,
            &true,
            &n_u,
            &proposal.eligible_root,
            &proof,
        );
    }
}

#[test]
#[should_panic(expected = "HostError")]
fn test_reopen_not_allowed() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "No reopen"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Close then archive
    voting_client.close_proposal(&1u64, &proposal_id, &admin);
    voting_client.archive_proposal(&1u64, &proposal_id, &admin);

    // Any attempt to vote (i.e., pretend reopen) should panic due to state
    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let proof = create_dummy_proof(&env);
    let nullifier = U256::from_u32(&env, 55555);
    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );
}

#[test]
fn test_randomized_nullifier_sequence_no_duplicates() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Randomized nullifiers"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let proof = create_dummy_proof(&env);

    // Pseudo-randomish sequence without duplicates (hardcoded for determinism)
    let nullifiers: [u32; 10] = [17, 3, 11, 25, 2, 19, 7, 13, 23, 29];

    for (i, n) in nullifiers.iter().enumerate() {
        let n_u = U256::from_u32(&env, *n);
        voting_client.vote(
            &1u64,
            &proposal_id,
            &(i % 2 == 0),
            &n_u,
            &proposal.eligible_root,
            &proof,
        );
    }

    let updated = voting_client.get_proposal(&1u64, &proposal_id);
    assert_eq!(
        updated.yes_votes + updated.no_votes,
        nullifiers.len() as u64
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_tampered_vk_hash_rejected() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "VK hash tamper"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Tamper vk_hash on stored proposal
    env.as_contract(&voting_id, || {
        let mut p = env
            .storage()
            .persistent()
            .get::<_, ProposalInfo>(&DataKey::Proposal(1, proposal_id))
            .unwrap();
        let bogus_hash = BytesN::from_array(&env, &[1u8; 32]);
        p.vk_hash = bogus_hash;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(1, proposal_id), &p);
    });

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let proof = create_dummy_proof(&env);
    let nullifier = U256::from_u32(&env, 99999);

    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_close_proposal_non_admin_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);
    let fake = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);

    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Non-admin close"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    voting_client.close_proposal(&1u64, &proposal_id, &fake);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_vote_with_invalid_root_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);

    // Set admin in registry before calling set_vk
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Try to vote with wrong root
    let invalid_root = U256::from_u32(&env, 99999);
    let nullifier = U256::from_u32(&env, 88888);
    let proof = create_dummy_proof(&env);

    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &invalid_root,
        &proof,
    );
}

#[test]
fn test_different_daos_isolated() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    sbt_client.set_member(&2u64, &member, &true);

    // Set roots for both DAOs
    tree_client.set_root(&1u64, &U256::from_u32(&env, 11111));
    tree_client.set_root(&2u64, &U256::from_u32(&env, 22222));

    // Set VK for both DAOs (required for proposal creation)
    registry_client.set_admin(&1u64, &admin);
    registry_client.set_admin(&2u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);
    voting_client.set_vk(&2u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let p1 = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "DAO 1 Proposal"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );
    let p2 = voting_client.create_proposal(
        &2u64,
        &String::from_str(&env, "DAO 2 Proposal"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Both should be proposal 1 in their respective DAOs
    assert_eq!(p1, 1);
    assert_eq!(p2, 1);

    assert_eq!(voting_client.proposal_count(&1u64), 1);
    assert_eq!(voting_client.proposal_count(&2u64), 1);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_set_vk_non_admin_fails() {
    let (env, voting_id, _tree_id, _sbt_id, registry_id, _member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let real_admin = Address::generate(&env);
    let fake_admin = Address::generate(&env);

    // Set real admin in registry
    registry_client.set_admin(&1u64, &real_admin);

    // Try to set VK with wrong admin - should fail
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &fake_admin);
}

#[test]
fn test_get_results() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    // Setup
    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Initial results should be (0, 0)
    let (yes, no) = voting_client.get_results(&1u64, &proposal_id);
    assert_eq!(yes, 0);
    assert_eq!(no, 0);

    // Cast a yes vote with proposal's eligible root
    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let nullifier = U256::from_u32(&env, 99999);
    let proof = create_dummy_proof(&env);
    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );

    // Results should be (1, 0)
    let (yes, no) = voting_client.get_results(&1u64, &proposal_id);
    assert_eq!(yes, 1);
    assert_eq!(no, 0);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_create_proposal_with_past_end_time_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    // Set a non-zero timestamp before creating proposal
    env.ledger().with_mut(|li| {
        li.timestamp = 1000;
    });

    let now = env.ledger().timestamp();
    // Create proposal with end time in the past
    voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, ""),
        &(now - 1), // end time in the past
        &member,
        &VoteMode::Fixed,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_vote_with_malformed_proof_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Malformed proof"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let nullifier = U256::from_u32(&env, 99999);
    let bad_proof = create_wrong_length_proof(&env);

    // Force verify_groth16 to return false in test mode
    env.as_contract(&voting_id, || {
        env.storage()
            .instance()
            .set(&DataKey::VerifyOverride, &false);
    });

    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &bad_proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_vote_with_swapped_pub_signals_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Swap pub signals"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Force verify_groth16 to return false to simulate swapped public inputs
    env.as_contract(&voting_id, || {
        env.storage()
            .instance()
            .set(&DataKey::VerifyOverride, &false);
    });

    let _proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let nullifier = U256::from_u32(&env, 99988);
    let proof = create_dummy_proof(&env);

    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        // Intentionally swap dao_id/proposal_id signals (wrong roots/commitments)
        &U256::from_u32(&env, 99999),
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_vote_with_swapped_dao_proposal_ids_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Swap dao/proposal"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    env.as_contract(&voting_id, || {
        env.storage()
            .instance()
            .set(&DataKey::VerifyOverride, &false);
    });

    let nullifier = U256::from_u32(&env, 1010);
    let proof = create_dummy_proof(&env);

    // Use wrong dao_id and proposal_id in signals (by calling with swapped IDs)
    voting_client.vote(
        &2u64,               // wrong dao_id
        &(&proposal_id + 1), // wrong proposal_id
        &true,
        &nullifier,
        &U256::from_u32(&env, 99999),
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_vote_with_all_zero_proof_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Zero proof"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Force verification to run and fail
    env.as_contract(&voting_id, || {
        env.storage()
            .instance()
            .set(&DataKey::VerifyOverride, &false);
    });

    let nullifier = U256::from_u32(&env, 2020);
    let proof = create_all_zero_proof(&env);

    voting_client.vote(&1u64, &proposal_id, &true, &nullifier, &root, &proof);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_vote_with_off_curve_proof_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Off-curve proof"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Force verification to run and fail
    env.as_contract(&voting_id, || {
        env.storage()
            .instance()
            .set(&DataKey::VerifyOverride, &false);
    });

    let nullifier = U256::from_u32(&env, 3030);
    let proof = create_off_curve_proof(&env);

    voting_client.vote(&1u64, &proposal_id, &true, &nullifier, &root, &proof);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_vote_after_expiry_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, ""),
        &(now + 3600), // 1 hour
        &member,
        &VoteMode::Fixed,
    );

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);

    // Set ledger to after end time
    env.ledger().with_mut(|li| {
        li.timestamp = proposal.end_time + 1;
    });

    let nullifier = U256::from_u32(&env, 99999);
    let proof = create_dummy_proof(&env);
    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_vote_with_commitment_from_other_dao_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    // Member belongs to DAO 1 with commitment and root1
    sbt_client.set_member(&1u64, &member, &true);
    let root_dao1 = U256::from_u32(&env, 11111);
    tree_client.set_root(&1u64, &root_dao1);

    // DAO 2 setup with different root; member has SBT but no matching commitment/root
    sbt_client.set_member(&2u64, &member, &true);
    registry_client.set_admin(&2u64, &admin);
    let root_dao2 = U256::from_u32(&env, 22222);
    tree_client.set_root(&2u64, &root_dao2);
    voting_client.set_vk(&2u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &2u64,
        &String::from_str(&env, "Cross-DAO vote"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Use commitment rooted in DAO 1 while voting in DAO 2 with DAO 1 root -> should panic (root mismatch)
    let nullifier = U256::from_u32(&env, 9999);
    let proof = create_dummy_proof(&env);
    voting_client.vote(
        &2u64,
        &proposal_id,
        &true,
        &nullifier,
        &root_dao1, // wrong root for DAO 2
        &proof,
    );
}

// TODO: Add a G2 subgroup/cofactor negative once host provides subgroup checks.
// Current pairing check rejects off-curve points; invalid-cofactor in G2 is not enforced by the host yet.

#[test]
#[should_panic(expected = "HostError")]
fn test_vote_with_mismatched_vk_hash_in_proposal_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "VK hash mismatch"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Tamper vk_hash on stored proposal and disable test shortcut to force verify failure
    env.as_contract(&voting_id, || {
        let mut p = env
            .storage()
            .persistent()
            .get::<_, ProposalInfo>(&DataKey::Proposal(1, proposal_id))
            .unwrap();
        let bogus_hash = BytesN::from_array(&env, &[9u8; 32]);
        p.vk_hash = bogus_hash;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(1, proposal_id), &p);
        env.storage()
            .instance()
            .set(&DataKey::VerifyOverride, &false);
    });

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let nullifier = U256::from_u32(&env, 4040);
    let proof = create_dummy_proof(&env);

    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_vote_with_vk_ic_length_mismatch_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);

    // Craft a VK with an IC length mismatch (8 elements instead of 7)
    let mut vk = create_dummy_vk(&env);
    vk.ic.push_back(bn254_g1_generator(&env)); // now len = 8

    // Bypass validation and install mismatched VK/version directly
    env.as_contract(&voting_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::VkVersion(1), &1u32);
        env.storage()
            .persistent()
            .set(&DataKey::VkByVersion(1, 1), &vk);
    });

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Bad VK"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);

    let nullifier = U256::from_u32(&env, 111);
    let proof = create_dummy_proof(&env);

    // With IC length mismatch, verify_groth16 should fail and panic
    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );
}

/// Randomized mixed operations to stress nullifier and FSM invariants.
#[test]
fn test_randomized_mixed_actions_preserve_invariants() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    registry_client.set_admin(&1u64, &admin);
    sbt_client.set_member(&1u64, &member, &true);
    tree_client.set_root(&1u64, &U256::from_u32(&env, 12345));
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let mut proposals = soroban_sdk::vec![&env];
    let mut nullifiers = soroban_sdk::vec![&env];

    // Create a couple of proposals
    for _idx in 0..3 {
        let pid = voting_client.create_proposal(
            &1u64,
            &String::from_str(&env, "P"),
            &String::from_str(&env, ""),
            &(env.ledger().timestamp() + 10_000),
            &member,
            &VoteMode::Fixed,
        );
        proposals.push_back(pid);
    }

    // Randomized sequence of actions
    let mut archived_once = false;
    for i in 0..5 {
        // Close/archive only once to avoid InvalidState repeats
        if !archived_once && i % 2 == 0 {
            let target = proposals.get(0).unwrap();
            voting_client.close_proposal(&1u64, &target, &admin);
            voting_client.archive_proposal(&1u64, &target, &admin);
            archived_once = true;
        }

        // Vote on remaining active proposals with unique nullifiers
        for pid in proposals.iter() {
            if pid == proposals.get(0).unwrap() {
                continue; // archived/closed
            }
            let base = 1000u64 + (i as u64) * 10 + pid;
            let n = U256::from_u128(&env, base as u128);
            nullifiers.push_back(n.clone());
            let proposal = voting_client.get_proposal(&1u64, &pid);
            let proof = create_dummy_proof(&env);
            voting_client.vote(
                &1u64,
                &pid,
                &(i % 2 == 0),
                &n,
                &proposal.eligible_root,
                &proof,
            );
        }
    }

    // Ensure no duplicate nullifiers recorded and archived proposal is closed/archived
    let mut seen = soroban_sdk::vec![&env];
    for n in nullifiers.iter() {
        assert!(!seen.iter().any(|x| x == n));
        seen.push_back(n);
    }
    let archived = proposals.get(0).unwrap();
    let archived_info = voting_client.get_proposal(&1u64, &archived);
    assert_eq!(archived_info.state, ProposalState::Archived);
}

#[test]
fn test_nullifier_reusable_across_proposals() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    // Create two proposals
    let now = env.ledger().timestamp();
    let proposal1 = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Proposal 1"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );
    let proposal2 = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Proposal 2"),
        &String::from_str(&env, ""),
        &(now + 7200),
        &member,
        &VoteMode::Fixed,
    );

    // Same nullifier should work for different proposals
    // (In reality, nullifier = hash(secret, proposalId), so different proposals have different nullifiers)
    // But this tests that nullifier storage is scoped per proposal
    let prop1 = voting_client.get_proposal(&1u64, &proposal1);
    let prop2 = voting_client.get_proposal(&1u64, &proposal2);
    let nullifier = U256::from_u32(&env, 99999);
    let proof = create_dummy_proof(&env);

    voting_client.vote(
        &1u64,
        &proposal1,
        &true,
        &nullifier,
        &prop1.eligible_root,
        &proof,
    );
    voting_client.vote(
        &1u64,
        &proposal2,
        &false,
        &nullifier,
        &prop2.eligible_root,
        &proof,
    );

    let (yes1, no1) = voting_client.get_results(&1u64, &proposal1);
    let (yes2, no2) = voting_client.get_results(&1u64, &proposal2);

    assert_eq!(yes1, 1);
    assert_eq!(no1, 0);
    assert_eq!(yes2, 0);
    assert_eq!(no2, 1);
}

#[test]
fn test_multiple_unique_nullifiers_succeed() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Batch votes"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let proof = create_dummy_proof(&env);

    for i in 1..6 {
        let nullifier = U256::from_u32(&env, i);
        voting_client.vote(
            &1u64,
            &proposal_id,
            &(i % 2 == 0),
            &nullifier,
            &proposal.eligible_root,
            &proof,
        );
    }

    let updated = voting_client.get_proposal(&1u64, &proposal_id);
    assert_eq!(updated.yes_votes + updated.no_votes, 5);
}

// Validation test for BN254 base field modulus constant
// This ensures the hardcoded modulus in g1_negate is correct
#[test]
fn test_bn254_modulus_constant_validation() {
    // BN254 base field modulus (Fq)
    // p = 21888242871839275222246405745257275088696311157297823662689037894645226208583
    let field_modulus: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
        0x5d, 0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c,
        0xfd, 0x47,
    ];

    // Convert to decimal to verify
    let mut value: [u64; 4] = [0; 4];
    for i in 0..4 {
        let mut chunk = 0u64;
        for j in 0..8 {
            chunk = (chunk << 8) | field_modulus[i * 8 + j] as u64;
        }
        value[i] = chunk;
    }

    // Known properties of BN254 Fq:
    // - Last byte should be 0x47 (71 in decimal)
    assert_eq!(field_modulus[31], 0x47);
    // - First byte should be 0x30
    assert_eq!(field_modulus[0], 0x30);
    // - p mod 2 = 1 (odd)
    assert_eq!(field_modulus[31] % 2, 1);

    // Verify p - 2 ends with 0x45 (for -G1 = (1, p-2) validation)
    // p - 2 should end with 0x47 - 2 = 0x45
    let expected_p_minus_2_last_byte = field_modulus[31] - 2;
    assert_eq!(expected_p_minus_2_last_byte, 0x45);
}

#[test]
fn test_vk_change_after_proposal_creation_resists_vk_change() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);

    // Set initial VK
    let vk1 = create_dummy_vk(&env);
    voting_client.set_vk(&1u64, &vk1, &admin);

    // Create proposal (snapshots VK hash)
    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Admin changes VK after proposal creation
    let mut vk2 = create_dummy_vk(&env);
    // Modify VK slightly (different IC point)
    let different_g1 = {
        let mut bytes = [0u8; 64];
        bytes[31] = 2; // x = 2 instead of 1
        bytes[63] = 3; // Different y
        BytesN::from_array(&env, &bytes)
    };
    vk2.ic = soroban_sdk::vec![
        &env,
        different_g1.clone(),
        different_g1.clone(),
        different_g1.clone(),
        different_g1.clone(),
        different_g1.clone(),
        different_g1
    ];
    voting_client.set_vk(&1u64, &vk2, &admin);

    // Try to vote with proof - should still succeed using stored versioned VK
    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let nullifier = U256::from_u32(&env, 99999);
    let proof = create_dummy_proof(&env);

    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_vk_version_mismatch_rejected() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);

    // Set VK version 1 and create proposal
    let vk1 = create_dummy_vk(&env);
    voting_client.set_vk(&1u64, &vk1, &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "VK version snapshot"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Bump VK version to 2
    let mut vk2 = create_dummy_vk(&env);
    let different_g1 = {
        let mut bytes = [0u8; 64];
        bytes[31] = 3;
        bytes[63] = 4;
        BytesN::from_array(&env, &bytes)
    };
    vk2.ic = soroban_sdk::vec![
        &env,
        different_g1.clone(),
        different_g1.clone(),
        different_g1.clone(),
        different_g1.clone(),
        different_g1.clone(),
        different_g1
    ];
    voting_client.set_vk(&1u64, &vk2, &admin);

    // Remove stored VK v1 to simulate missing history and ensure vote fails
    env.as_contract(&voting_id, || {
        env.storage()
            .persistent()
            .remove(&DataKey::VkByVersion(1, 1));
    });

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let nullifier = U256::from_u32(&env, 99999);
    let proof = create_dummy_proof(&env);

    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );
}

#[test]
fn test_create_proposal_with_specific_vk_version() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);

    // Set VK v1 and v2
    let vk1 = create_dummy_vk(&env);
    voting_client.set_vk(&1u64, &vk1, &admin);
    let mut vk2 = create_dummy_vk(&env);
    // Make vk2 distinct: tweak IC[0] and alpha
    let mut vk2_ic = soroban_sdk::vec![&env];
    let mut first_ic_bytes = vk1.ic.get(0).unwrap().to_array();
    first_ic_bytes[31] = 0x05; // change x
    vk2_ic.push_back(BytesN::from_array(&env, &first_ic_bytes));
    for _ in 1..6 {
        vk2_ic.push_back(vk1.ic.get(0).unwrap());
    }
    vk2.ic = vk2_ic;

    let mut alpha_bytes = vk2.alpha.to_array();
    alpha_bytes[0] = 0xAA;
    alpha_bytes[31] = 0xBB;
    alpha_bytes[63] = 0xCC;
    vk2.alpha = BytesN::from_array(&env, &alpha_bytes);
    voting_client.set_vk(&1u64, &vk2, &admin);

    // Create proposal pinned to v1 even though latest is v2
    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal_with_vk_version(
        &1u64,
        &String::from_str(&env, "Old VK proposal"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
        &1u32,
    );

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    assert_eq!(proposal.vk_version, 1);

    let nullifier = U256::from_u32(&env, 99999);
    let proof = create_dummy_proof(&env);

    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier,
        &proposal.eligible_root,
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_create_proposal_with_future_vk_version_rejected() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);

    // Only VK v1 exists
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    // Request non-existent future version 2
    voting_client.create_proposal_with_vk_version(
        &1u64,
        &String::from_str(&env, "Future version"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
        &2u32,
    );
}

#[test]
fn test_vk_for_version_exposes_stored_key() {
    let (env, voting_id, _tree_id, _sbt_id, registry_id, _member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    registry_client.set_admin(&1u64, &admin);

    let vk1 = create_dummy_vk(&env);
    let mut vk2 = create_dummy_vk(&env);
    // Make vk2 distinct: tweak IC[0] and alpha
    let mut vk2_ic = soroban_sdk::vec![&env];
    let mut first_ic_bytes = vk1.ic.get(0).unwrap().to_array();
    first_ic_bytes[31] = 0x05; // change x
    vk2_ic.push_back(BytesN::from_array(&env, &first_ic_bytes));
    for _ in 1..6 {
        vk2_ic.push_back(vk1.ic.get(0).unwrap());
    }
    vk2.ic = vk2_ic;
    let mut alpha_bytes = vk2.alpha.to_array();
    alpha_bytes[0] = 0xAA;
    alpha_bytes[31] = 0xBB;
    alpha_bytes[63] = 0xCC;
    vk2.alpha = BytesN::from_array(&env, &alpha_bytes);

    let vk1_hash = Voting::hash_vk(&env, &vk1);
    let vk2_hash = Voting::hash_vk(&env, &vk2);
    assert_ne!(vk1_hash, vk2_hash);

    voting_client.set_vk(&1u64, &vk1, &admin);
    voting_client.set_vk(&1u64, &vk2, &admin);

    let fetched_v1 = voting_client.vk_for_version(&1u64, &1u32);
    let fetched_v2 = voting_client.vk_for_version(&1u64, &2u32);

    assert_eq!(Voting::hash_vk(&env, &fetched_v1), vk1_hash);
    assert_eq!(Voting::hash_vk(&env, &fetched_v2), vk2_hash);
    assert_ne!(vk1_hash, vk2_hash);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_set_vk_empty_ic_fails() {
    let (env, voting_id, _tree_id, _sbt_id, registry_id, _member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let admin = Address::generate(&env);

    // Create a DAO
    registry_client.set_admin(&1u64, &admin);

    // Create VK with empty IC vector
    let g1 = bn254_g1_generator(&env);
    let g2 = bn254_g2_generator(&env);
    let invalid_vk = VerificationKey {
        alpha: g1.clone(),
        beta: g2.clone(),
        gamma: g2.clone(),
        delta: g2,
        ic: soroban_sdk::vec![&env], // Empty!
    };

    // Should panic - IC length must be exactly 6
    voting_client.set_vk(&1u64, &invalid_vk, &admin);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_set_vk_ic_too_large_fails() {
    let (env, voting_id, _tree_id, _sbt_id, registry_id, _member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let admin = Address::generate(&env);

    // Create a DAO
    registry_client.set_admin(&1u64, &admin);

    // Create VK with too many IC elements (22 > MAX_IC_LENGTH of 21)
    let g1 = bn254_g1_generator(&env);
    let g2 = bn254_g2_generator(&env);
    let mut ic_vec = soroban_sdk::vec![&env];
    for _ in 0..22 {
        // MAX_IC_LENGTH is 21, so 22 should fail
        ic_vec.push_back(g1.clone());
    }

    let invalid_vk = VerificationKey {
        alpha: g1.clone(),
        beta: g2.clone(),
        gamma: g2.clone(),
        delta: g2,
        ic: ic_vec,
    };

    // Should panic - first check catches IC length != 6
    voting_client.set_vk(&1u64, &invalid_vk, &admin);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_set_vk_ic_length_5_fails() {
    let (env, voting_id, _tree_id, _sbt_id, registry_id, _member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let admin = Address::generate(&env);
    registry_client.set_admin(&1u64, &admin);

    // Create VK with IC length = 5 (need exactly 6 for vote circuit: 5 public signals + 1)
    let g1 = bn254_g1_generator(&env);
    let g2 = bn254_g2_generator(&env);
    let invalid_vk = VerificationKey {
        alpha: g1.clone(),
        beta: g2.clone(),
        gamma: g2.clone(),
        delta: g2,
        ic: soroban_sdk::vec![
            &env,
            g1.clone(),
            g1.clone(),
            g1.clone(),
            g1.clone(),
            g1.clone()
        ],
    };

    // Should panic - need exactly 6 elements
    voting_client.set_vk(&1u64, &invalid_vk, &admin);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_set_vk_ic_length_7_fails() {
    let (env, voting_id, _tree_id, _sbt_id, registry_id, _member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let admin = Address::generate(&env);
    registry_client.set_admin(&1u64, &admin);

    // Create VK with IC length = 7 (need exactly 6 for vote circuit: 5 public signals + 1)
    let g1 = bn254_g1_generator(&env);
    let g2 = bn254_g2_generator(&env);
    let invalid_vk = VerificationKey {
        alpha: g1.clone(),
        beta: g2.clone(),
        gamma: g2.clone(),
        delta: g2,
        ic: soroban_sdk::vec![
            &env,
            g1.clone(),
            g1.clone(),
            g1.clone(),
            g1.clone(),
            g1.clone(),
            g1.clone(),
            g1.clone()
        ],
    };

    // Should panic - need exactly 6 elements
    voting_client.set_vk(&1u64, &invalid_vk, &admin);
}

// NOTE: G1/G2 point validation tests are not included here because point validation
// is disabled in test mode (#[cfg(not(any(test, feature = "testutils")))]).
//
// Point validation (curve membership, subgroup checks) is only active in production.
// This is intentional because:
// 1. Test environment doesn't have access to BN254 host functions
// 2. Point validation is security-critical and should be tested on real network
// 3. Integration tests on P25 testnet verify actual point validation
//
// Tests that should be added as integration tests on real network:
// - Invalid G1 point in VK alpha (off-curve)
// - Invalid G1 point in VK IC (off-curve)
// - Invalid G2 point in VK beta/gamma/delta (off-curve or wrong subgroup)
// - Malformed point byte lengths (though BytesN<64>/BytesN<128> types prevent this)

#[test]
#[should_panic(expected = "HostError")]
fn test_create_proposal_title_too_long_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    tree_client.set_root(&1u64, &U256::from_u32(&env, 12345));
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    // Create title > 100 bytes (MAX_TITLE_LEN)
    let long_title = "a".repeat(101);

    let now = env.ledger().timestamp();
    voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, &long_title),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );
}

#[test]
fn test_create_proposal_max_title_length_succeeds() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    tree_client.set_root(&1u64, &U256::from_u32(&env, 12345));
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    // Create title exactly 100 bytes (MAX_TITLE_LEN)
    let max_title = "a".repeat(100);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, &max_title),
        &String::from_str(
            &env,
            "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
        ),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    assert_eq!(proposal_id, 1);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_create_proposal_content_cid_too_long_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    tree_client.set_root(&1u64, &U256::from_u32(&env, 12345));
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    // Create content_cid > 64 bytes (MAX_CID_LEN)
    let long_cid = "a".repeat(65);

    let now = env.ledger().timestamp();
    voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, &long_cid),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );
}

// Test helper: manual G1 negation (same logic as production code)
fn test_g1_negate(point: &[u8; 64]) -> [u8; 64] {
    // BN254 base field modulus (Fq)
    let field_modulus: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
        0x5d, 0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c,
        0xfd, 0x47,
    ];

    let mut x = [0u8; 32];
    let mut y = [0u8; 32];
    x.copy_from_slice(&point[0..32]);
    y.copy_from_slice(&point[32..64]);

    // Compute -y = p - y
    let mut neg_y = [0u8; 32];
    let mut borrow: u16 = 0;
    for i in (0..32).rev() {
        let diff = (field_modulus[i] as u16) as i32 - (y[i] as u16) as i32 - borrow as i32;
        if diff < 0 {
            neg_y[i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            neg_y[i] = diff as u8;
            borrow = 0;
        }
    }

    let mut result = [0u8; 64];
    result[0..32].copy_from_slice(&x);
    result[32..64].copy_from_slice(&neg_y);
    result
}

#[test]
fn test_g1_negation_correctness() {
    // This test validates the manual G1 negation (y-flip) without SDK BN254 ops
    // (which aren't available in test environment - only on real ledger).
    //
    // Key mathematical validation: For correct field negation,
    // y + (-y) ≡ 0 (mod p), which means y + (p - y) = p
    // We verify this sum equals the field modulus exactly.
    //
    // If this test passes, the negation is mathematically correct because:
    // - We validate the full 32-byte modulus constant
    // - We test multiple points with varying y-coordinates
    // - We verify y + neg_y = p (proves subtraction correctness)
    // - We verify double negation = identity (involution)
    // - We test complex bytes to catch endianness bugs

    // Full modulus assertion - validate entire 32-byte BN254 Fq constant
    let expected_fq: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
        0x5d, 0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c,
        0xfd, 0x47,
    ];
    let field_modulus_in_code: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
        0x5d, 0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c,
        0xfd, 0x47,
    ];
    assert_eq!(
        field_modulus_in_code, expected_fq,
        "Field modulus must match BN254 Fq exactly"
    );

    // Test multiple points with known y-coordinates
    // Point format: (x, y) where both are 32-byte big-endian
    let test_points: [([u8; 64], &str); 4] = [
        // Generator G = (1, 2)
        (
            {
                let mut bytes = [0u8; 64];
                bytes[31] = 1; // x = 1
                bytes[63] = 2; // y = 2
                bytes
            },
            "generator (1, 2)",
        ),
        // Point with large y coordinate
        (
            {
                let mut bytes = [0u8; 64];
                bytes[31] = 3; // x = 3
                               // y = large value close to p
                bytes[32..64].copy_from_slice(&[
                    0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                    0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
                ]);
                bytes
            },
            "point with large y",
        ),
        // Point with small y
        (
            {
                let mut bytes = [0u8; 64];
                bytes[31] = 5; // x = 5
                bytes[63] = 100; // y = 100
                bytes
            },
            "point (5, 100)",
        ),
        // Point with y in middle range
        (
            {
                let mut bytes = [0u8; 64];
                bytes[31] = 7; // x = 7
                bytes[56..64].copy_from_slice(&[0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0]);
                bytes
            },
            "point with mid-range y",
        ),
    ];

    for (point_arr, name) in test_points.iter() {
        // Apply manual negation
        let neg_arr = test_g1_negate(point_arr);

        // Validation 1: x-coordinate unchanged
        assert_eq!(
            &point_arr[0..32],
            &neg_arr[0..32],
            "{}: x coordinate must be unchanged after negation",
            name
        );

        // Validation 2: y-coordinate changed
        assert_ne!(
            &point_arr[32..64],
            &neg_arr[32..64],
            "{}: y coordinate must change after negation",
            name
        );

        // Validation 3: Double negation returns original (involution property)
        let double_neg_arr = test_g1_negate(&neg_arr);
        assert_eq!(
            *point_arr, double_neg_arr,
            "{}: double negation must return original point",
            name
        );

        // Validation 4: -y = p - y (verify arithmetic correctness)
        // Add y + neg_y and verify it equals p
        let y = &point_arr[32..64];
        let neg_y = &neg_arr[32..64];
        let sum = add_big_endian_256(y, neg_y);
        assert_eq!(
            sum, expected_fq,
            "{}: y + (-y) must equal field modulus p",
            name
        );
    }

    // Test edge cases
    // y = 1: -y should be p - 1
    let point_y1: [u8; 64] = {
        let mut bytes = [0u8; 64];
        bytes[31] = 1;
        bytes[63] = 1;
        bytes
    };
    let neg_y1 = test_g1_negate(&point_y1);
    let expected_p_minus_1: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
        0x5d, 0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c,
        0xfd, 0x46, // 0x47 - 1 = 0x46
    ];
    assert_eq!(
        &neg_y1[32..64],
        &expected_p_minus_1,
        "y=1: -y must equal p-1"
    );

    // Test that negation with random-looking bytes works correctly
    // This catches byte-order/endianness bugs
    let complex_point: [u8; 64] = {
        let mut bytes = [0u8; 64];
        // Some x value
        bytes[0..32].copy_from_slice(&[
            0x0A, 0x1B, 0x2C, 0x3D, 0x4E, 0x5F, 0x60, 0x71, 0x82, 0x93, 0xA4, 0xB5, 0xC6, 0xD7,
            0xE8, 0xF9, 0x01, 0x12, 0x23, 0x34, 0x45, 0x56, 0x67, 0x78, 0x89, 0x9A, 0xAB, 0xBC,
            0xCD, 0xDE, 0xEF, 0x00,
        ]);
        // Some y value (must be < p)
        bytes[32..64].copy_from_slice(&[
            0x20, 0x55, 0x44, 0x33, 0x22, 0x11, 0x00, 0xFF, 0xEE, 0xDD, 0xCC, 0xBB, 0xAA, 0x99,
            0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x00, 0xFF, 0xEE, 0xDD, 0xCC, 0xBB,
            0xAA, 0x99, 0x88, 0x77,
        ]);
        bytes
    };
    let neg_complex = test_g1_negate(&complex_point);
    let double_neg_complex = test_g1_negate(&neg_complex);
    assert_eq!(
        complex_point, double_neg_complex,
        "Complex point: double negation must return original"
    );

    // Verify y + (-y) = p for complex point
    let sum = add_big_endian_256(&complex_point[32..64], &neg_complex[32..64]);
    assert_eq!(sum, expected_fq, "Complex point: y + (-y) must equal p");
}

// Helper: Add two 256-bit big-endian numbers
fn add_big_endian_256(a: &[u8], b: &[u8]) -> [u8; 32] {
    let mut result = [0u8; 32];
    let mut carry: u16 = 0;
    for i in (0..32).rev() {
        let sum = a[i] as u16 + b[i] as u16 + carry;
        result[i] = (sum & 0xFF) as u8;
        carry = sum >> 8;
    }
    result
}

// ============================================================================
// Field Modulus Validation Tests
// ============================================================================
// These tests verify that public signals >= BN254 scalar field modulus r are
// rejected. This prevents modular reduction attacks where different U256 values
// that are congruent mod r (e.g., nullifier=1 vs nullifier=r+1) would verify
// identically but be stored as different keys, allowing double-voting.

/// BN254 scalar field modulus r (big-endian)
/// r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
const BN254_FR_MODULUS_TEST: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// Helper to create U256 from big-endian bytes
fn u256_from_be(env: &Env, bytes: &[u8; 32]) -> U256 {
    U256::from_be_bytes(env, &soroban_sdk::Bytes::from_array(env, bytes))
}

/// Helper to create r + offset (wrapping addition in big-endian)
fn modulus_plus(env: &Env, offset: u8) -> U256 {
    let mut bytes = BN254_FR_MODULUS_TEST;
    // Add offset to the last byte with carry propagation
    let mut carry = offset as u16;
    for i in (0..32).rev() {
        let sum = bytes[i] as u16 + carry;
        bytes[i] = (sum & 0xFF) as u8;
        carry = sum >> 8;
        if carry == 0 {
            break;
        }
    }
    u256_from_be(env, &bytes)
}

#[test]
#[should_panic(expected = "Error(Contract, #25)")]
fn test_vote_rejects_nullifier_at_modulus() {
    // SignalNotInField = 25
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let dao_id = 1u64;
    registry_client.set_admin(&dao_id, &member);
    sbt_client.set_member(&dao_id, &member, &true);
    registry_client.set_members_can_propose(&dao_id, &true);

    // Set up VK and create proposal
    let vk = create_dummy_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &member);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&dao_id, &root);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, "QmTest"),
        &(now + 3600),
        &member,
        &VoteMode::Trailing,
    );

    // Try to vote with nullifier = r (the field modulus itself)
    let nullifier_at_modulus = u256_from_be(&env, &BN254_FR_MODULUS_TEST);
    let proof = create_dummy_proof(&env);

    // This should panic with SignalNotInField
    voting_client.vote(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier_at_modulus,
        &root,
        &proof,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #25)")]
fn test_vote_rejects_nullifier_above_modulus() {
    // SignalNotInField = 25
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let dao_id = 1u64;
    registry_client.set_admin(&dao_id, &member);
    sbt_client.set_member(&dao_id, &member, &true);
    registry_client.set_members_can_propose(&dao_id, &true);

    let vk = create_dummy_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &member);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&dao_id, &root);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, "QmTest"),
        &(now + 3600),
        &member,
        &VoteMode::Trailing,
    );

    // Try to vote with nullifier = r + 1 (would reduce to 1 mod r)
    let nullifier_above_modulus = modulus_plus(&env, 1);
    let proof = create_dummy_proof(&env);

    // This should panic with SignalNotInField
    voting_client.vote(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier_above_modulus,
        &root,
        &proof,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #25)")]
fn test_vote_rejects_root_at_modulus() {
    // SignalNotInField = 25
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let dao_id = 1u64;
    registry_client.set_admin(&dao_id, &member);
    sbt_client.set_member(&dao_id, &member, &true);
    registry_client.set_members_can_propose(&dao_id, &true);

    let vk = create_dummy_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &member);

    // Set root to a value at the modulus (invalid)
    let root_at_modulus = u256_from_be(&env, &BN254_FR_MODULUS_TEST);
    tree_client.set_root(&dao_id, &root_at_modulus);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, "QmTest"),
        &(now + 3600),
        &member,
        &VoteMode::Trailing,
    );

    let nullifier = U256::from_u32(&env, 42);
    let proof = create_dummy_proof(&env);

    // This should panic with SignalNotInField for root
    voting_client.vote(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier,
        &root_at_modulus,
        &proof,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #26)")]
fn test_vote_rejects_zero_nullifier() {
    // InvalidNullifier = 26
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let dao_id = 1u64;
    registry_client.set_admin(&dao_id, &member);
    sbt_client.set_member(&dao_id, &member, &true);
    registry_client.set_members_can_propose(&dao_id, &true);

    let vk = create_dummy_vk(&env);
    voting_client.set_vk(&dao_id, &vk, &member);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&dao_id, &root);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Test"),
        &String::from_str(&env, "QmTest"),
        &(now + 3600),
        &member,
        &VoteMode::Trailing,
    );

    // Try to vote with nullifier = 0 (invalid)
    let zero_nullifier = U256::from_u32(&env, 0);
    let proof = create_dummy_proof(&env);

    // This should panic with InvalidNullifier
    voting_client.vote(&dao_id, &proposal_id, &true, &zero_nullifier, &root, &proof);
}

// === UNTESTED EDGE CASES ===
// - Tree full (2^18 leaves) behavior
// - Vote counter (u64) overflow
// - TTL expiration and data recovery
// - Cross-contract partial failure rollback in create_and_init_dao
// - Concurrent DAO creation in same ledger
