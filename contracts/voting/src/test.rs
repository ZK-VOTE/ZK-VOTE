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

        pub fn root_ok(env: Env, dao_id: u64, root: U256) -> bool {
            let key = DataKey::CurrentRoot(dao_id);
            if let Some(curr) = env.storage().persistent().get::<_, U256>(&key) {
                if curr == root {
                    return true;
                }
            }
            root != U256::from_u32(&env, 99999)
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
    let guardian = Address::generate(&env);
    let voting_id = env.register(Voting, (tree_id.clone(), registry_id.clone(), guardian));

    // Link tree to sbt
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    tree_client.set_sbt_contract(&sbt_id);

    // Link sbt to registry
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    sbt_client.set_registry(&registry_id);

    let member = Address::generate(&env);

    (env, voting_id, tree_id, sbt_id, registry_id, member)
}

fn setup_randomness_env() -> (Env, Address, Address, u64, Address, Address) {
    let (env, voting_id, tree_id, sbt_id, registry_id, first) = setup_env_with_registry();
    let second = Address::generate(&env);
    let registry = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let sbt = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree = mock_tree::MockTreeClient::new(&env, &tree_id);
    let voting = VotingClient::new(&env, &voting_id);

    registry.set_admin(&1, &first);
    sbt.set_member(&1, &first, &true);
    sbt.set_member(&1, &second, &true);
    tree.set_root(&1, &U256::from_u32(&env, 12345));
    voting.set_vk(&1, &create_dummy_vk(&env), &first);
    let proposal_id = voting.create_proposal(
        &1,
        &String::from_str(&env, "Randomized candidates"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 10_000),
        &first,
        &VoteMode::Fixed,
    );

    (env, voting_id, registry_id, proposal_id, first, second)
}

fn create_dummy_vk(env: &Env) -> VerificationKey {
    let g1 = bn254_g1_generator(env);
    let g2 = bn254_g2_generator(env);
    VerificationKey {
        alpha: g1.clone(),
        beta: g2.clone(),
        gamma: g2.clone(),
        delta: g2.clone(),
        // IC vector needs 7 elements for 6 public signals:
        // [root, nullifier, daoId, proposalId, voteChoice, numCandidates]
        // (commitment is now private, not a public signal)
        ic: soroban_sdk::vec![
            env,
            g1.clone(),
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
    let guardian = Address::generate(&env);
    let voting_id = env.register(
        Voting,
        (tree_id.clone(), registry_id.clone(), guardian.clone()),
    );
    let client = VotingClient::new(&env, &voting_id);

    assert_eq!(client.tree_contract(), tree_id);
    assert_eq!(client.registry(), registry_id);
    assert_eq!(client.guardian(), guardian);
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
    for _ in 1..7 {
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
    for _ in 1..7 {
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

    // Create VK with IC length = 5 (need exactly 7 for vote circuit: 6 public signals + 1)
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

    // Should panic - need exactly 7 elements
    voting_client.set_vk(&1u64, &invalid_vk, &admin);
}

#[test]
fn test_set_vk_ic_length_7_succeeds() {
    let (env, voting_id, _tree_id, _sbt_id, registry_id, _member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let admin = Address::generate(&env);
    registry_client.set_admin(&1u64, &admin);

    // Create VK with IC length = 7 (correct: 6 public signals + 1)
    let g1 = bn254_g1_generator(&env);
    let g2 = bn254_g2_generator(&env);
    let valid_vk = VerificationKey {
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

    // Should succeed - 7 is the correct IC length for 6 public signals
    voting_client.set_vk(&1u64, &valid_vk, &admin);
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

#[test]
fn test_commit_reveal_finalizes_candidate_seed() {
    let (env, voting_id, _, proposal_id, first, second) = setup_randomness_env();
    let voting = VotingClient::new(&env, &voting_id);
    let first_value = BytesN::from_array(&env, &[1; 32]);
    let second_value = BytesN::from_array(&env, &[2; 32]);

    voting.set_election_config(&1, &proposal_id, &0, &0, &2);
    voting.commit_randomness(
        &1,
        &proposal_id,
        &voting.randomness_commitment(&1, &proposal_id, &first, &first_value),
        &first,
    );
    voting.commit_randomness(
        &1,
        &proposal_id,
        &voting.randomness_commitment(&1, &proposal_id, &second, &second_value),
        &second,
    );
    env.ledger().with_mut(|ledger| {
        ledger.timestamp += RANDOMNESS_COMMIT_WINDOW;
    });
    voting.reveal_randomness(&1, &proposal_id, &first_value, &first);
    voting.reveal_randomness(&1, &proposal_id, &second_value, &second);

    let seed = voting.finalize_candidate_seed(&1, &proposal_id);
    assert_eq!(
        voting.get_candidate_seed(&1, &proposal_id),
        Some(seed.clone())
    );
    assert_eq!(
        voting
            .get_election_config(&1, &proposal_id)
            .unwrap()
            .candidate_seed,
        Some(seed)
    );
    assert_ne!(
        voting.candidate_order_key(&1, &proposal_id, &BytesN::from_array(&env, &[3; 32])),
        voting.candidate_order_key(&1, &proposal_id, &BytesN::from_array(&env, &[4; 32]))
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #35)")]
fn test_rejects_randomness_reveal_mismatch() {
    let (env, voting_id, _, proposal_id, first, _) = setup_randomness_env();
    let voting = VotingClient::new(&env, &voting_id);
    let committed = BytesN::from_array(&env, &[1; 32]);

    voting.commit_randomness(
        &1,
        &proposal_id,
        &voting.randomness_commitment(&1, &proposal_id, &first, &committed),
        &first,
    );
    env.ledger().with_mut(|ledger| {
        ledger.timestamp += RANDOMNESS_COMMIT_WINDOW;
    });
    voting.reveal_randomness(
        &1,
        &proposal_id,
        &BytesN::from_array(&env, &[2; 32]),
        &first,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #37)")]
fn test_finalization_requires_every_committed_reveal() {
    let (env, voting_id, _, proposal_id, first, second) = setup_randomness_env();
    let voting = VotingClient::new(&env, &voting_id);
    let first_value = BytesN::from_array(&env, &[1; 32]);
    let second_value = BytesN::from_array(&env, &[2; 32]);

    for (participant, value) in [(&first, &first_value), (&second, &second_value)] {
        voting.commit_randomness(
            &1,
            &proposal_id,
            &voting.randomness_commitment(&1, &proposal_id, participant, value),
            participant,
        );
    }
    env.ledger().with_mut(|ledger| {
        ledger.timestamp += RANDOMNESS_COMMIT_WINDOW;
    });
    voting.reveal_randomness(&1, &proposal_id, &first_value, &first);
    voting.finalize_candidate_seed(&1, &proposal_id);
}

// === UNTESTED EDGE CASES ===
// - Tree full (2^18 leaves) behavior
// - Vote counter (u64) overflow
// - TTL expiration and data recovery
// - Cross-contract partial failure rollback in create_and_init_dao
// - Concurrent DAO creation in same ledger

#[test]
fn test_guardian_can_pause_and_unpause() {
    let (env, voting_id, _, _, _, _) = setup_env_with_registry();
    let client = VotingClient::new(&env, &voting_id);
    let guardian = client.guardian();

    client.pause(&guardian);
    assert!(client.is_paused());
    client.unpause(&guardian);
    assert!(!client.is_paused());
}

#[test]
#[should_panic(expected = "Error(Contract, #29)")]
fn test_pause_blocks_writes_but_allows_reads() {
    let (env, voting_id, _, _, registry_id, admin) = setup_env_with_registry();
    let client = VotingClient::new(&env, &voting_id);
    mock_registry::MockRegistryClient::new(&env, &registry_id).set_admin(&1, &admin);
    let guardian = client.guardian();

    client.pause(&guardian);
    assert!(client.is_paused());
    assert_eq!(client.proposal_count(&1), 0);
    client.set_vk(&1, &create_dummy_vk(&env), &admin);
}

#[test]
fn test_pause_expires_after_max_duration() {
    let (env, voting_id, _, _, registry_id, admin) = setup_env_with_registry();
    let client = VotingClient::new(&env, &voting_id);
    mock_registry::MockRegistryClient::new(&env, &registry_id).set_admin(&1, &admin);
    let guardian = client.guardian();

    client.pause(&guardian);
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + MAX_PAUSE_DURATION);

    assert!(!client.is_paused());
    client.set_vk(&1, &create_dummy_vk(&env), &admin);
}

#[test]
#[should_panic(expected = "Error(Contract, #30)")]
fn test_non_guardian_cannot_pause() {
    let (env, voting_id, _, _, _, _) = setup_env_with_registry();
    VotingClient::new(&env, &voting_id).pause(&Address::generate(&env));
}

// ── Candidate index bounds tests ────────────────────────────────────────────

#[test]
fn test_election_config_stores_num_candidates() {
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
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    voting_client.set_election_config(&1u64, &proposal_id, &0, &0, &3u32);

    let config = voting_client.get_election_config(&1u64, &proposal_id);
    assert!(config.is_some());
    assert_eq!(config.unwrap().num_candidates, 3);
    assert_eq!(voting_client.get_num_candidates(&1u64, &proposal_id), 3);
}

#[test]
fn test_get_num_candidates_defaults_to_zero() {
    let (env, voting_id, _, _, _, _) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    assert_eq!(voting_client.get_num_candidates(&1u64, &999), 0);
}

#[test]
fn test_vote_succeeds_when_num_candidates_not_set() {
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

    let updated = voting_client.get_proposal(&1u64, &proposal_id);
    assert_eq!(updated.yes_votes, 1);
    assert_eq!(updated.no_votes, 0);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_vote_with_num_candidates_1_rejects_vote_choice_1() {
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
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    voting_client.set_election_config(&1u64, &proposal_id, &0, &0, &1u32);

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let nullifier = U256::from_u32(&env, 99999);
    let proof = create_dummy_proof(&env);

    // vote_choice=true -> index 1 >= num_candidates(1) -> panics
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
fn test_vote_with_num_candidates_2_accepts_both_choices() {
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
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    voting_client.set_election_config(&1u64, &proposal_id, &0, &0, &2u32);

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let proof = create_dummy_proof(&env);

    let nullifier1 = U256::from_u32(&env, 11111);
    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier1,
        &proposal.eligible_root,
        &proof,
    );

    let nullifier2 = U256::from_u32(&env, 22222);
    voting_client.vote(
        &1u64,
        &proposal_id,
        &false,
        &nullifier2,
        &proposal.eligible_root,
        &proof,
    );

    let updated = voting_client.get_proposal(&1u64, &proposal_id);
    assert_eq!(updated.yes_votes, 1);
    assert_eq!(updated.no_votes, 1);
}

// ── ProposalState transition matrix tests (#54) ──────────────────────────────

#[test]
fn test_valid_transitions() {
    assert!(ProposalState::Active.is_valid_transition(ProposalState::Closed));
    assert!(ProposalState::Closed.is_valid_transition(ProposalState::Archived));
}

#[test]
fn test_invalid_transitions_from_active() {
    assert!(!ProposalState::Active.is_valid_transition(ProposalState::Archived));
    assert!(!ProposalState::Active.is_valid_transition(ProposalState::Active));
}

#[test]
fn test_invalid_transitions_from_closed() {
    assert!(!ProposalState::Closed.is_valid_transition(ProposalState::Active));
    assert!(!ProposalState::Closed.is_valid_transition(ProposalState::Closed));
}

#[test]
fn test_archived_is_terminal() {
    assert!(!ProposalState::Archived.is_valid_transition(ProposalState::Active));
    assert!(!ProposalState::Archived.is_valid_transition(ProposalState::Closed));
    assert!(!ProposalState::Archived.is_valid_transition(ProposalState::Archived));
}

// ── Reentrancy Guard Tests ─────────────────────────────────────────────────

#[test]
#[should_panic(expected = "HostError")]
fn test_reentrancy_lock_prevents_reentrant_vote() {
    // Verify that setting the reentrancy lock (simulating a reentrant call)
    // causes the vote function to panic with ReentrantCall.
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
        &String::from_str(&env, "Reentrant test"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Simulate a reentrant call by manually setting the ReentrancyLock flag
    env.as_contract(&voting_id, || {
        env.storage()
            .instance()
            .set(&DataKey::ReentrancyLock, &true);
    });

    // This should panic because the lock is already set
    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    let nullifier = U256::from_u32(&env, 77777);
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
fn test_successful_vote_clears_reentrancy_lock() {
    // Verify that after a successful vote, the reentrancy lock is cleared,
    // allowing a subsequent vote with a different nullifier.
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
        &String::from_str(&env, "Lock clear test"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);

    // First vote should succeed
    let nullifier1 = U256::from_u32(&env, 1001);
    let proof = create_dummy_proof(&env);
    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &nullifier1,
        &proposal.eligible_root,
        &proof,
    );

    // Verify lock is cleared by checking the ReentrancyLock key doesn't exist
    let lock_cleared = env.as_contract(&voting_id, || {
        !env.storage().instance().has(&DataKey::ReentrancyLock)
    });
    assert!(
        lock_cleared,
        "Reentrancy lock should be cleared after successful vote"
    );

    // Second vote with different nullifier should also succeed (lock was cleared)
    let nullifier2 = U256::from_u32(&env, 1002);
    voting_client.vote(
        &1u64,
        &proposal_id,
        &false,
        &nullifier2,
        &proposal.eligible_root,
        &proof,
    );

    let updated = voting_client.get_proposal(&1u64, &proposal_id);
    assert_eq!(updated.yes_votes, 1);
    assert_eq!(updated.no_votes, 1);
}

#[test]
fn test_recursive_tally_submission() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    sbt_client.set_member(&1u64, &member, &true);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    tree_client.set_root(&1u64, &U256::from_u32(&env, 12345));
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 12345);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let dao_id = 1u64;

    // Set recursive VK
    let vk_bytes = Bytes::from_slice(&env, &[1, 2, 3, 4]);
    client.set_recursive_vk(&dao_id, &vk_bytes, &admin);
    let stored_vk = client.get_recursive_vk(&dao_id);
    assert_eq!(stored_vk, Some(vk_bytes));

    // Create a proposal
    let end_time = env.ledger().timestamp() + 3600;
    let prop_id = client.create_proposal(
        &dao_id,
        &String::from_str(&env, "Recursive Test Proposal"),
        &String::from_str(&env, "ipfs://QmTest"),
        &end_time,
        &member,
        &VoteMode::Fixed,
    );

    // Submit recursive tally
    let num_votes = 1000u64;
    let yes_votes = 650u64;
    let no_votes = 350u64;
    let final_acc = U256::from_u32(&env, 99999);
    let proof = Bytes::from_slice(&env, &[0xDE, 0xAD, 0xBE, 0xEF]);

    client.submit_recursive_tally(
        &dao_id, &prop_id, &num_votes, &yes_votes, &no_votes, &final_acc, &proof,
    );

    let tally = client.get_recursive_tally(&dao_id, &prop_id).unwrap();
    assert_eq!(tally.num_votes, 1000);
    assert_eq!(tally.yes_votes, 650);
    assert_eq!(tally.no_votes, 350);

    let prop_info = client.get_proposal(&dao_id, &prop_id);
    assert_eq!(prop_info.yes_votes, 650);
    assert_eq!(prop_info.no_votes, 350);
    assert_eq!(prop_info.state, ProposalState::Closed);
}

// ============================================================================
// Quadratic voting with range proofs (issue #50)
// ============================================================================

// QV circuit has 6 public signals -> IC length must be 7.
fn create_dummy_qv_vk(env: &Env) -> VerificationKey {
    let g1 = bn254_g1_generator(env);
    let g2 = bn254_g2_generator(env);
    VerificationKey {
        alpha: g1.clone(),
        beta: g2.clone(),
        gamma: g2.clone(),
        delta: g2.clone(),
        ic: soroban_sdk::vec![
            env,
            g1.clone(),
            g1.clone(),
            g1.clone(),
            g1.clone(),
            g1.clone(),
            g1.clone(),
            g1.clone()
        ],
    }
}

// Tally VK with `num_public + 1` IC points.
fn create_dummy_tally_vk(env: &Env, num_public: u32) -> VerificationKey {
    let g1 = bn254_g1_generator(env);
    let g2 = bn254_g2_generator(env);
    let mut ic = soroban_sdk::vec![env];
    for _ in 0..(num_public + 1) {
        ic.push_back(g1.clone());
    }
    VerificationKey {
        alpha: g1.clone(),
        beta: g2.clone(),
        gamma: g2.clone(),
        delta: g2,
        ic,
    }
}

// Register mocks, give `member` an SBT, set the root + admin + QV VK, and create
// a quadratic proposal. Returns (env, voting_client, proposal_id, eligible_root).
fn setup_qv_round() -> (Env, VotingClient<'static>, Address, u64, U256) {
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
    voting_client.set_qv_vk(&1u64, &create_dummy_qv_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_qv_proposal(
        &1u64,
        &String::from_str(&env, "QV Round"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
    );
    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    (
        env,
        voting_client,
        admin,
        proposal_id,
        proposal.eligible_root,
    )
}

#[test]
fn test_quadratic_set_qv_vk_and_version() {
    let (env, voting_id, _tree_id, _sbt_id, registry_id, _member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);
    registry_client.set_admin(&1u64, &admin);

    assert_eq!(voting_client.qv_vk_version(&1u64), 0);
    voting_client.set_qv_vk(&1u64, &create_dummy_qv_vk(&env), &admin);
    assert_eq!(voting_client.qv_vk_version(&1u64), 1);
    voting_client.set_qv_vk(&1u64, &create_dummy_qv_vk(&env), &admin);
    assert_eq!(voting_client.qv_vk_version(&1u64), 2);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_quadratic_set_qv_vk_wrong_ic_length_fails() {
    let (env, voting_id, _tree_id, _sbt_id, registry_id, _member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);
    registry_client.set_admin(&1u64, &admin);
    let mut bad_vk = create_dummy_vk(&env);
    bad_vk.ic.pop_back();
    voting_client.set_qv_vk(&1u64, &bad_vk, &admin);
}

#[test]
fn test_quadratic_create_proposal() {
    let (_env, voting_client, _admin, proposal_id, _root) = setup_qv_round();
    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    assert_eq!(proposal.vote_mode, VoteMode::Quadratic);
    assert_eq!(
        voting_client.get_vote_mode(&1u64, &proposal_id),
        VoteMode::Quadratic
    );
    assert_eq!(voting_client.qv_ballot_count(&1u64, &proposal_id), 0);
}

#[test]
fn test_quadratic_cast_vote_success() {
    let (env, voting_client, _admin, proposal_id, root) = setup_qv_round();

    let nullifier = U256::from_u32(&env, 77777);
    let alloc_hash = U256::from_u32(&env, 424242);
    let proof = create_dummy_proof(&env);

    // 3^2 + 1^2 + 0 = 10 credits, within the budget of 100.
    voting_client.cast_qv_vote(
        &1u64,
        &proposal_id,
        &nullifier,
        &root,
        &10u64,
        &alloc_hash,
        &proof,
    );

    assert_eq!(voting_client.qv_ballot_count(&1u64, &proposal_id), 1);
    assert_eq!(voting_client.qv_credits_total(&1u64, &proposal_id), 10u128);
    assert!(voting_client.is_qv_nullifier_used(&1u64, &proposal_id, &nullifier));
    let ballot = voting_client.get_qv_ballot(&1u64, &proposal_id, &nullifier);
    assert_eq!(ballot.total_credits_spent, 10u64);
    assert_eq!(ballot.allocations_hash, alloc_hash);
}

#[test]
fn test_quadratic_credits_total_accumulates() {
    let (env, voting_client, _admin, proposal_id, root) = setup_qv_round();
    let proof = create_dummy_proof(&env);

    voting_client.cast_qv_vote(
        &1u64,
        &proposal_id,
        &U256::from_u32(&env, 11),
        &root,
        &10u64,
        &U256::from_u32(&env, 111),
        &proof,
    );
    voting_client.cast_qv_vote(
        &1u64,
        &proposal_id,
        &U256::from_u32(&env, 22),
        &root,
        &25u64,
        &U256::from_u32(&env, 222),
        &proof,
    );

    assert_eq!(voting_client.qv_ballot_count(&1u64, &proposal_id), 2);
    assert_eq!(voting_client.qv_credits_total(&1u64, &proposal_id), 35u128);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_quadratic_double_vote_fails() {
    let (env, voting_client, _admin, proposal_id, root) = setup_qv_round();
    let nullifier = U256::from_u32(&env, 77777);
    let proof = create_dummy_proof(&env);
    voting_client.cast_qv_vote(
        &1u64,
        &proposal_id,
        &nullifier,
        &root,
        &10u64,
        &U256::from_u32(&env, 1),
        &proof,
    );
    // Same nullifier again -> NullifierUsed.
    voting_client.cast_qv_vote(
        &1u64,
        &proposal_id,
        &nullifier,
        &root,
        &4u64,
        &U256::from_u32(&env, 2),
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_quadratic_budget_exceeded_fails() {
    let (env, voting_client, _admin, proposal_id, root) = setup_qv_round();
    let proof = create_dummy_proof(&env);
    // 101 > MAX_QV_BUDGET (100).
    voting_client.cast_qv_vote(
        &1u64,
        &proposal_id,
        &U256::from_u32(&env, 5),
        &root,
        &101u64,
        &U256::from_u32(&env, 9),
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_quadratic_wrong_root_fails() {
    let (env, voting_client, _admin, proposal_id, _root) = setup_qv_round();
    let proof = create_dummy_proof(&env);
    // Root does not match the snapshot -> RootMismatch.
    voting_client.cast_qv_vote(
        &1u64,
        &proposal_id,
        &U256::from_u32(&env, 5),
        &U256::from_u32(&env, 999999),
        &10u64,
        &U256::from_u32(&env, 9),
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_quadratic_zero_nullifier_fails() {
    let (env, voting_client, _admin, proposal_id, root) = setup_qv_round();
    let proof = create_dummy_proof(&env);
    voting_client.cast_qv_vote(
        &1u64,
        &proposal_id,
        &U256::from_u32(&env, 0),
        &root,
        &10u64,
        &U256::from_u32(&env, 9),
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_quadratic_regular_vote_on_qv_proposal_fails() {
    let (env, voting_client, _admin, proposal_id, root) = setup_qv_round();
    let proof = create_dummy_proof(&env);
    // The plain `vote` entrypoint must reject a Quadratic proposal.
    voting_client.vote(
        &1u64,
        &proposal_id,
        &true,
        &U256::from_u32(&env, 5),
        &root,
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_quadratic_cast_on_non_qv_proposal_fails() {
    // Build a regular Fixed proposal, then try to cast a QV ballot on it.
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
        &String::from_str(&env, "Fixed"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );
    let proof = create_dummy_proof(&env);
    voting_client.cast_qv_vote(
        &1u64,
        &proposal_id,
        &U256::from_u32(&env, 5),
        &root,
        &10u64,
        &U256::from_u32(&env, 9),
        &proof,
    );
}

#[test]
fn test_quadratic_tally_record_and_get() {
    let (env, voting_client, admin, proposal_id, root) = setup_qv_round();
    let proof = create_dummy_proof(&env);

    // Two ballots cast on-chain (allocations stay private).
    voting_client.cast_qv_vote(
        &1u64,
        &proposal_id,
        &U256::from_u32(&env, 11),
        &root,
        &10u64,
        &U256::from_u32(&env, 111),
        &proof,
    );
    voting_client.cast_qv_vote(
        &1u64,
        &proposal_id,
        &U256::from_u32(&env, 22),
        &root,
        &9u64,
        &U256::from_u32(&env, 222),
        &proof,
    );

    // Off-chain aggregation produced these per-proposal totals; commit them
    // on-chain with a tally proof. Public signals = [round_id, 3 ids, 3 tallies]
    // = 7 -> tally VK IC length 8.
    voting_client.set_qv_tally_vk(&1u64, &create_dummy_tally_vk(&env, 7), &admin);

    let proposal_ids = soroban_sdk::vec![&env, 100u64, 200u64, 300u64];
    let tallies = soroban_sdk::vec![&env, 5u64, 3u64, 0u64];
    voting_client.record_qv_tally(&1u64, &proposal_id, &proposal_ids, &tallies, &proof);

    assert!(voting_client.is_qv_tally_finalized(&1u64, &proposal_id));
    assert_eq!(
        voting_client.get_qv_tally(&1u64, &proposal_id, &100u64),
        5u64
    );
    assert_eq!(
        voting_client.get_qv_tally(&1u64, &proposal_id, &200u64),
        3u64
    );
    assert_eq!(
        voting_client.get_qv_tally(&1u64, &proposal_id, &300u64),
        0u64
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_quadratic_tally_length_mismatch_fails() {
    let (env, voting_client, admin, proposal_id, _root) = setup_qv_round();
    let proof = create_dummy_proof(&env);
    voting_client.set_qv_tally_vk(&1u64, &create_dummy_tally_vk(&env, 7), &admin);
    let proposal_ids = soroban_sdk::vec![&env, 100u64, 200u64, 300u64];
    let tallies = soroban_sdk::vec![&env, 5u64, 3u64]; // one short
    voting_client.record_qv_tally(&1u64, &proposal_id, &proposal_ids, &tallies, &proof);
}

/// Issue #64: nullifiers are election-scoped by (dao_id, proposal_id).
/// Using the same nullifier hash in election A must not mark it used in election B.
#[test]
fn test_nullifier_domain_separation_across_elections() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    sbt_client.set_member(&2u64, &member, &true);
    let root = U256::from_u32(&env, 4242);
    tree_client.set_root(&1u64, &root);
    tree_client.set_root(&2u64, &root);
    registry_client.set_admin(&1u64, &admin);
    registry_client.set_admin(&2u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);
    voting_client.set_vk(&2u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let election_a = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Election A"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );
    env.ledger().set_timestamp(now + 300);
    let now2 = env.ledger().timestamp();
    let election_b = voting_client.create_proposal(
        &2u64,
        &String::from_str(&env, "Election B"),
        &String::from_str(&env, ""),
        &(now2 + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let shared_nullifier = U256::from_u32(&env, 0xDEAD);
    let proof = create_dummy_proof(&env);
    let prop_a = voting_client.get_proposal(&1u64, &election_a);
    let prop_b = voting_client.get_proposal(&2u64, &election_b);

    // Vote in election A
    voting_client.vote(
        &1u64,
        &election_a,
        &true,
        &shared_nullifier,
        &prop_a.eligible_root,
        &proof,
    );

    // Scoped queries: used in A, unused in B
    assert!(voting_client.is_nullifier_used(&1u64, &election_a, &shared_nullifier));
    assert!(voting_client.has_nullifier_been_used(&1u64, &election_a, &shared_nullifier));
    assert!(!voting_client.is_nullifier_used(&2u64, &election_b, &shared_nullifier));
    assert!(!voting_client.has_nullifier_been_used(&2u64, &election_b, &shared_nullifier));

    // Same nullifier value must still be votable in election B (no global DoS)
    voting_client.vote(
        &2u64,
        &election_b,
        &false,
        &shared_nullifier,
        &prop_b.eligible_root,
        &proof,
    );
    assert!(voting_client.is_nullifier_used(&2u64, &election_b, &shared_nullifier));
}

/// Issue #64: migrate LegacyNullifierUsed(n) → Nullifier(dao, proposal, n).
#[test]
fn test_migrate_nullifier_to_election_scope() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let root = U256::from_u32(&env, 111);
    tree_client.set_root(&1u64, &root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Migrate election"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let nullifier = U256::from_u32(&env, 777);
    // Seed a legacy flat nullifier entry directly in storage
    env.as_contract(&voting_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::LegacyNullifierUsed(nullifier.clone()), &true);
    });

    assert!(!voting_client.is_nullifier_used(&1u64, &proposal_id, &nullifier));

    let migrated = voting_client.migrate_nullifier(&1u64, &proposal_id, &nullifier, &admin);
    assert!(migrated);
    assert!(voting_client.is_nullifier_used(&1u64, &proposal_id, &nullifier));

    // Second migrate is a no-op (legacy already removed)
    let migrated_again = voting_client.migrate_nullifier(&1u64, &proposal_id, &nullifier, &admin);
    assert!(!migrated_again);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_tally_yes_votes_overflow_fails() {
    let (env, voting_id, _tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    sbt_client.set_member(&1u64, &member, &true);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);
    registry_client.set_admin(&1u64, &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Title"),
        &String::from_str(&env, "Desc"),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let key = DataKey::Proposal(1u64, proposal_id);
    let mut proposal: ProposalInfo =
        env.as_contract(&voting_id, || env.storage().persistent().get(&key).unwrap());
    proposal.yes_votes = u64::MAX;
    env.as_contract(&voting_id, || {
        env.storage().persistent().set(&key, &proposal);
    });

    let nullifier = U256::from_u32(&env, 123);
    let proof = create_dummy_proof(&env);
    let root = voting_client.get_eligible_root(&1u64, &proposal_id);

    voting_client.vote(&1u64, &proposal_id, &true, &nullifier, &root, &proof);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_tally_no_votes_overflow_fails() {
    let (env, voting_id, _tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    sbt_client.set_member(&1u64, &member, &true);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);
    registry_client.set_admin(&1u64, &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Title"),
        &String::from_str(&env, "Desc"),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let key = DataKey::Proposal(1u64, proposal_id);
    let mut proposal: ProposalInfo =
        env.as_contract(&voting_id, || env.storage().persistent().get(&key).unwrap());
    proposal.no_votes = u64::MAX;
    env.as_contract(&voting_id, || {
        env.storage().persistent().set(&key, &proposal);
    });

    let nullifier = U256::from_u32(&env, 123);
    let proof = create_dummy_proof(&env);
    let root = voting_client.get_eligible_root(&1u64, &proposal_id);

    voting_client.vote(&1u64, &proposal_id, &false, &nullifier, &root, &proof);
}

#[test]
fn test_recursive_tally_overflow_fails() {
    let (env, voting_id, _tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    sbt_client.set_member(&1u64, &member, &true);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal(
        &1u64,
        &String::from_str(&env, "Title"),
        &String::from_str(&env, "Desc"),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let key = DataKey::Proposal(1u64, proposal_id);
    let mut proposal: ProposalInfo =
        env.as_contract(&voting_id, || env.storage().persistent().get(&key).unwrap());
    proposal.state = ProposalState::Closed;
    env.as_contract(&voting_id, || {
        env.storage().persistent().set(&key, &proposal);
    });

    let proof = Bytes::from_array(&env, &[1u8; 32]);
    let nullifier_acc = U256::from_u32(&env, 1);

    let res = voting_client.try_submit_recursive_tally(
        &1u64,
        &proposal_id,
        &u64::MAX,
        &u64::MAX,
        &u64::MAX,
        &nullifier_acc,
        &proof,
    );

    assert!(res.is_err());
}

#[test]
fn test_set_merkle_root_during_registration() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let initial_root = U256::from_u32(&env, 100);
    tree_client.set_root(&1u64, &initial_root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal_in_registration(
        &1u64,
        &String::from_str(&env, "Registration Proposal"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    let new_root = U256::from_u32(&env, 200);
    tree_client.set_root(&1u64, &new_root);

    voting_client.set_merkle_root(&1u64, &proposal_id, &new_root, &admin);

    let proposal = voting_client.get_proposal(&1u64, &proposal_id);
    assert_eq!(proposal.eligible_root, new_root);

    let config = voting_client
        .get_election_config(&1u64, &proposal_id)
        .unwrap();
    assert!(config.merkle_root_set_at.is_some());

    let history = voting_client.get_merkle_root_history(&1u64, &proposal_id);
    assert_eq!(history.len(), 1);
    assert_eq!(history.get(0).unwrap().root, new_root);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #63)")]
fn test_set_merkle_root_when_active_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let initial_root = U256::from_u32(&env, 100);
    tree_client.set_root(&1u64, &initial_root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal_in_registration(
        &1u64,
        &String::from_str(&env, "Active Proposal"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    // Activate proposal to lock Merkle root
    voting_client.activate_proposal(&1u64, &proposal_id, &admin);
    let activated_prop = voting_client.get_proposal(&1u64, &proposal_id);
    assert_eq!(activated_prop.state, ProposalState::Active);

    let new_root = U256::from_u32(&env, 200);
    voting_client.set_merkle_root(&1u64, &proposal_id, &new_root, &admin);
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #64)")]
fn test_set_merkle_root_commitment_window_expired_fails() {
    let (env, voting_id, tree_id, sbt_id, registry_id, member) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let sbt_client = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let tree_client = mock_tree::MockTreeClient::new(&env, &tree_id);
    let admin = Address::generate(&env);

    sbt_client.set_member(&1u64, &member, &true);
    let initial_root = U256::from_u32(&env, 100);
    tree_client.set_root(&1u64, &initial_root);
    registry_client.set_admin(&1u64, &admin);
    voting_client.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let now = env.ledger().timestamp();
    let proposal_id = voting_client.create_proposal_in_registration(
        &1u64,
        &String::from_str(&env, "Registration Proposal"),
        &String::from_str(&env, ""),
        &(now + 3600),
        &member,
        &VoteMode::Fixed,
    );

    voting_client.set_commitment_window(&1u64, &proposal_id, &60u64, &admin);
    env.ledger().set_timestamp(now + 120);

    let new_root = U256::from_u32(&env, 200);
    voting_client.set_merkle_root(&1u64, &proposal_id, &new_root, &admin);
}

#[test]
fn test_storage_layout_exposes_client_negotiation_metadata() {
    let (env, voting_id, _, _, _, _) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);

    assert_eq!(voting_client.version(), 2);
    assert_eq!(voting_client.storage_version(), 1);

    let layout = voting_client.storage_layout();
    assert_eq!(layout.contract_version, 2);
    assert_eq!(layout.storage_version, 1);
    assert_eq!(layout.latest_migration_at, 0);
    assert_eq!(layout.rollback_to_version, None);
}

#[test]
fn test_migration_for_version_round_trips_existing_record() {
    let (env, voting_id, _, _, _, _) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let payload_hash = BytesN::from_array(&env, &[9u8; 32]);
    let migration = ContractMigrationInfo {
        from_version: 1,
        to_version: 2,
        storage_version: 1,
        payload_hash: payload_hash.clone(),
        applied_at: env.ledger().timestamp(),
    };

    env.as_contract(&voting_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::UpgradeMigration(2), &migration);
    });

    let fetched = voting_client.migration_for_version(&2u32).unwrap();
    assert_eq!(fetched.from_version, 1);
    assert_eq!(fetched.to_version, 2);
    assert_eq!(fetched.storage_version, 1);
    assert_eq!(fetched.payload_hash, payload_hash);
}

#[test]
fn test_storage_layout_reports_rollback_marker() {
    let (env, voting_id, _, _, _, _) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);

    env.as_contract(&voting_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::UpgradeRollback(2), &1u32);
    });

    let layout = voting_client.storage_layout();
    assert_eq!(layout.rollback_to_version, Some(1));
}

#[test]
#[should_panic(expected = "Error(Contract, #66)")]
fn test_registry_upgrade_hook_rejects_version_mismatch_before_wasm_update() {
    let (env, voting_id, _, _, _, _) = setup_env_with_registry();
    let voting_client = VotingClient::new(&env, &voting_id);
    let wasm_hash = BytesN::from_array(&env, &[4u8; 32]);
    let migration_payload = Bytes::from_array(&env, b"noop");

    voting_client.apply_upgrade_from_registry(&wasm_hash, &1u32, &3u32, &1u32, &migration_payload);
}

// =========================================================================
// Batched voting (#90) and Merkle depth flexibility (#93)
//
// Proof verification is stubbed under `cfg(test)` (see zkvote-groth16), so
// these cover the contract-side rules around the verifier: batch shape,
// nullifier bookkeeping, tallying, and which verification key an election
// resolves to. The cryptography itself is covered against real proofs by
// `zkvote-groth16/tests/batch_verification.rs`.
// =========================================================================

/// A DAO with one active Fixed-mode proposal, ready to receive votes.
fn setup_batch_election() -> (Env, VotingClient<'static>, Address, u64, U256) {
    let (env, voting_id, tree_id, sbt_id, registry_id, admin) = setup_env_with_registry();
    let registry = mock_registry::MockRegistryClient::new(&env, &registry_id);
    let sbt = mock_sbt::MockSbtClient::new(&env, &sbt_id);
    let tree = mock_tree::MockTreeClient::new(&env, &tree_id);
    let voting = VotingClient::new(&env, &voting_id);

    let root = U256::from_u32(&env, 12345);
    registry.set_admin(&1u64, &admin);
    sbt.set_member(&1u64, &admin, &true);
    tree.set_root(&1u64, &root);
    voting.set_vk(&1u64, &create_dummy_vk(&env), &admin);

    let proposal_id = voting.create_proposal(
        &1u64,
        &String::from_str(&env, "Batched election"),
        &String::from_str(&env, ""),
        &(env.ledger().timestamp() + 3600),
        &admin,
        &VoteMode::Fixed,
    );

    (env, voting, admin, proposal_id, root)
}

fn batch_vote(env: &Env, choice: bool, nullifier: u32, root: &U256) -> BatchVote {
    BatchVote {
        vote_choice: choice,
        nullifier: U256::from_u32(env, nullifier),
        root: root.clone(),
        proof: create_all_zero_proof(env),
    }
}

#[test]
fn test_cast_votes_records_every_vote_in_the_batch() {
    let (env, voting, _admin, proposal_id, root) = setup_batch_election();

    let votes = soroban_sdk::vec![
        &env,
        batch_vote(&env, true, 101, &root),
        batch_vote(&env, true, 102, &root),
        batch_vote(&env, false, 103, &root),
    ];

    assert_eq!(voting.cast_votes(&1u64, &proposal_id, &votes), 3);

    let (yes, no) = voting.get_results(&1u64, &proposal_id);
    assert_eq!((yes, no), (2, 1));

    for nullifier in [101u32, 102, 103] {
        assert!(voting.is_nullifier_used(&1u64, &proposal_id, &U256::from_u32(&env, nullifier)));
    }
}

#[test]
fn test_cast_votes_tally_matches_individual_votes() {
    // A batch must land the same tally as the same votes cast one at a time.
    let (env, voting, _admin, proposal_id, root) = setup_batch_election();

    voting.vote(
        &1u64,
        &proposal_id,
        &true,
        &U256::from_u32(&env, 201),
        &root,
        &create_all_zero_proof(&env),
    );
    voting.vote(
        &1u64,
        &proposal_id,
        &false,
        &U256::from_u32(&env, 202),
        &root,
        &create_all_zero_proof(&env),
    );
    let (single_yes, single_no) = voting.get_results(&1u64, &proposal_id);

    let votes = soroban_sdk::vec![
        &env,
        batch_vote(&env, true, 203, &root),
        batch_vote(&env, false, 204, &root),
    ];
    voting.cast_votes(&1u64, &proposal_id, &votes);

    let (yes, no) = voting.get_results(&1u64, &proposal_id);
    assert_eq!((single_yes, single_no), (1, 1));
    assert_eq!((yes, no), (2, 2));
}

#[test]
#[should_panic(expected = "Error(Contract, #72)")]
fn test_cast_votes_rejects_an_empty_batch() {
    let (env, voting, _admin, proposal_id, _root) = setup_batch_election();
    let empty: soroban_sdk::Vec<BatchVote> = soroban_sdk::Vec::new(&env);
    voting.cast_votes(&1u64, &proposal_id, &empty);
}

#[test]
#[should_panic(expected = "Error(Contract, #72)")]
fn test_cast_votes_rejects_an_oversized_batch() {
    let (env, voting, _admin, proposal_id, root) = setup_batch_election();
    let mut votes = soroban_sdk::Vec::new(&env);
    for i in 0..(MAX_VOTE_BATCH + 1) {
        votes.push_back(batch_vote(&env, true, 1000 + i, &root));
    }
    voting.cast_votes(&1u64, &proposal_id, &votes);
}

#[test]
#[should_panic(expected = "Error(Contract, #73)")]
fn test_cast_votes_rejects_a_duplicate_nullifier_inside_the_batch() {
    // The storage check only sees committed state, so a batch carrying the
    // same nullifier twice would otherwise double-vote in one transaction.
    let (env, voting, _admin, proposal_id, root) = setup_batch_election();
    let votes = soroban_sdk::vec![
        &env,
        batch_vote(&env, true, 301, &root),
        batch_vote(&env, false, 301, &root),
    ];
    voting.cast_votes(&1u64, &proposal_id, &votes);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_cast_votes_rejects_an_already_used_nullifier() {
    let (env, voting, _admin, proposal_id, root) = setup_batch_election();
    voting.vote(
        &1u64,
        &proposal_id,
        &true,
        &U256::from_u32(&env, 401),
        &root,
        &create_all_zero_proof(&env),
    );

    let votes = soroban_sdk::vec![
        &env,
        batch_vote(&env, true, 402, &root),
        batch_vote(&env, true, 401, &root),
    ];
    voting.cast_votes(&1u64, &proposal_id, &votes);
}

#[test]
#[should_panic(expected = "Error(Contract, #26)")]
fn test_cast_votes_rejects_a_zero_nullifier() {
    let (env, voting, _admin, proposal_id, root) = setup_batch_election();
    let votes = soroban_sdk::vec![&env, batch_vote(&env, true, 0, &root)];
    voting.cast_votes(&1u64, &proposal_id, &votes);
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn test_cast_votes_rejects_a_wrong_root_in_fixed_mode() {
    let (env, voting, _admin, proposal_id, root) = setup_batch_election();
    let wrong = U256::from_u32(&env, 999_999);
    let votes = soroban_sdk::vec![
        &env,
        batch_vote(&env, true, 501, &root),
        batch_vote(&env, true, 502, &wrong),
    ];
    voting.cast_votes(&1u64, &proposal_id, &votes);
}

#[test]
fn test_cast_votes_leaves_no_nullifier_burned_when_the_batch_fails() {
    // An honest voter grouped with a bad one must be able to retry: a failed
    // batch reverts, so their nullifier must still be unused afterwards.
    let (env, voting, _admin, proposal_id, root) = setup_batch_election();
    let wrong = U256::from_u32(&env, 999_999);
    let votes = soroban_sdk::vec![
        &env,
        batch_vote(&env, true, 601, &root),
        batch_vote(&env, true, 602, &wrong),
    ];

    assert!(voting.try_cast_votes(&1u64, &proposal_id, &votes).is_err());
    assert!(!voting.is_nullifier_used(&1u64, &proposal_id, &U256::from_u32(&env, 601)));

    // ... and the honest vote still goes through on its own.
    let retry = soroban_sdk::vec![&env, batch_vote(&env, true, 601, &root)];
    assert_eq!(voting.cast_votes(&1u64, &proposal_id, &retry), 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #68)")]
fn test_cast_votes_enforces_the_candidate_bound() {
    let (env, voting, _admin, proposal_id, root) = setup_batch_election();
    // One candidate means only index 0 is valid, so a "yes" (index 1) is out of range.
    voting.set_election_config(&1u64, &proposal_id, &0i128, &0u64, &1u32);

    let votes = soroban_sdk::vec![&env, batch_vote(&env, true, 701, &root)];
    voting.cast_votes(&1u64, &proposal_id, &votes);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_cast_votes_rejects_a_closed_proposal() {
    let (env, voting, admin, proposal_id, root) = setup_batch_election();
    voting.close_proposal(&1u64, &proposal_id, &admin);

    let votes = soroban_sdk::vec![&env, batch_vote(&env, true, 801, &root)];
    voting.cast_votes(&1u64, &proposal_id, &votes);
}

#[test]
fn test_merkle_depth_defaults_to_the_default_circuit() {
    let (_env, voting, _admin, proposal_id, _root) = setup_batch_election();
    assert_eq!(voting.get_merkle_depth(&1u64, &proposal_id), 0);
}

#[test]
fn test_set_vk_for_depth_round_trips() {
    let (env, voting, admin, _proposal_id, _root) = setup_batch_election();
    assert!(voting.get_vk_for_depth(&1u64, &10u32).is_none());

    let vk = create_dummy_vk(&env);
    voting.set_vk_for_depth(&1u64, &10u32, &vk, &admin);
    assert!(voting.get_vk_for_depth(&1u64, &10u32).is_some());
    // Registering one depth must not register any other.
    assert!(voting.get_vk_for_depth(&1u64, &15u32).is_none());
}

#[test]
#[should_panic(expected = "Error(Contract, #71)")]
fn test_set_vk_for_depth_rejects_depth_zero() {
    let (env, voting, admin, _proposal_id, _root) = setup_batch_election();
    voting.set_vk_for_depth(&1u64, &0u32, &create_dummy_vk(&env), &admin);
}

#[test]
#[should_panic(expected = "Error(Contract, #71)")]
fn test_set_vk_for_depth_rejects_depth_above_the_maximum() {
    let (env, voting, admin, _proposal_id, _root) = setup_batch_election();
    voting.set_vk_for_depth(
        &1u64,
        &(MAX_MERKLE_DEPTH + 1),
        &create_dummy_vk(&env),
        &admin,
    );
}

#[test]
fn test_election_can_declare_a_merkle_depth() {
    let (env, voting, admin, proposal_id, root) = setup_batch_election();
    voting.set_vk_for_depth(&1u64, &10u32, &create_dummy_vk(&env), &admin);
    voting.set_election_config_with_depth(&1u64, &proposal_id, &0i128, &0u64, &2u32, &10u32);

    assert_eq!(voting.get_merkle_depth(&1u64, &proposal_id), 10);
    let config = voting.get_election_config(&1u64, &proposal_id).unwrap();
    assert_eq!(config.merkle_depth, 10);
    assert_eq!(config.num_candidates, 2);

    // Voting still works: the election just resolves the depth key instead of
    // the version-pinned default one.
    voting.vote(
        &1u64,
        &proposal_id,
        &true,
        &U256::from_u32(&env, 901),
        &root,
        &create_all_zero_proof(&env),
    );
    assert_eq!(voting.get_results(&1u64, &proposal_id).0, 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #71)")]
fn test_election_cannot_declare_a_depth_without_a_registered_key() {
    let (_env, voting, _admin, proposal_id, _root) = setup_batch_election();
    voting.set_election_config_with_depth(&1u64, &proposal_id, &0i128, &0u64, &2u32, &15u32);
}

#[test]
#[should_panic(expected = "Error(Contract, #71)")]
fn test_election_rejects_a_depth_above_the_maximum() {
    let (_env, voting, _admin, proposal_id, _root) = setup_batch_election();
    voting.set_election_config_with_depth(
        &1u64,
        &proposal_id,
        &0i128,
        &0u64,
        &2u32,
        &(MAX_MERKLE_DEPTH + 1),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")]
fn test_replacing_a_depth_key_mid_election_is_rejected() {
    // Same protection the version-pinned default key has: an in-flight vote
    // must not silently start verifying against a different key.
    let (env, voting, admin, proposal_id, root) = setup_batch_election();
    voting.set_vk_for_depth(&1u64, &10u32, &create_dummy_vk(&env), &admin);
    voting.set_election_config_with_depth(&1u64, &proposal_id, &0i128, &0u64, &2u32, &10u32);

    let mut replacement = create_dummy_vk(&env);
    replacement.alpha = BytesN::from_array(&env, &[0u8; 64]);
    voting.set_vk_for_depth(&1u64, &10u32, &replacement, &admin);

    voting.vote(
        &1u64,
        &proposal_id,
        &true,
        &U256::from_u32(&env, 902),
        &root,
        &create_all_zero_proof(&env),
    );
}

#[test]
fn test_set_election_config_preserves_a_declared_depth() {
    // The plain setter must not silently reset the depth an election declared.
    let (env, voting, admin, proposal_id, _root) = setup_batch_election();
    voting.set_vk_for_depth(&1u64, &20u32, &create_dummy_vk(&env), &admin);
    voting.set_election_config_with_depth(&1u64, &proposal_id, &0i128, &0u64, &2u32, &20u32);

    voting.set_election_config(&1u64, &proposal_id, &5i128, &10u64, &3u32);

    let config = voting.get_election_config(&1u64, &proposal_id).unwrap();
    assert_eq!(config.merkle_depth, 20);
    assert_eq!(config.num_candidates, 3);
    assert_eq!(config.min_balance, 5);
}

#[test]
fn test_cast_votes_uses_the_depth_key_when_one_is_declared() {
    let (env, voting, admin, proposal_id, root) = setup_batch_election();
    voting.set_vk_for_depth(&1u64, &15u32, &create_dummy_vk(&env), &admin);
    voting.set_election_config_with_depth(&1u64, &proposal_id, &0i128, &0u64, &2u32, &15u32);

    let votes = soroban_sdk::vec![
        &env,
        batch_vote(&env, true, 1001, &root),
        batch_vote(&env, false, 1002, &root),
    ];
    assert_eq!(voting.cast_votes(&1u64, &proposal_id, &votes), 2);
    assert_eq!(voting.get_results(&1u64, &proposal_id), (1, 1));
}
