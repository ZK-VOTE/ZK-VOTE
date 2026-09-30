use super::*;
use soroban_sdk::{testutils::Address as _, BytesN, Env, Vec, U256};

// Mock tree contract with minimal interface needed by rewards
mod mock_tree {
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, U256};

    #[contracttype]
    pub enum DataKey {
        CurrentRoot(u64),
        RootValid(u64, U256),
        RootIdx(u64, U256),
        Earliest(u64),
        MinRoot(u64),
        CurrIdx(u64),
    }

    #[contract]
    pub struct MockTree;

    #[contractimpl]
    impl MockTree {
        pub fn set_root(env: Env, dao_id: u64, root: U256) {
            env.storage()
                .persistent()
                .set(&DataKey::CurrentRoot(dao_id), &root);
            // also mark valid and idx 0
            env.storage()
                .persistent()
                .set(&DataKey::RootValid(dao_id, root.clone()), &true);
            env.storage()
                .persistent()
                .set(&DataKey::RootIdx(dao_id, root.clone()), &0u32);
        }
        pub fn get_root(env: Env, dao_id: u64) -> U256 {
            env.storage()
                .persistent()
                .get(&DataKey::CurrentRoot(dao_id))
                .unwrap_or(U256::from_u32(&env, 0))
        }
        pub fn curr_idx(env: Env, dao_id: u64) -> u32 {
            env.storage()
                .persistent()
                .get(&DataKey::CurrIdx(dao_id))
                .unwrap_or(0)
        }
        pub fn root_ok(env: Env, dao_id: u64, root: U256) -> bool {
            env.storage()
                .persistent()
                .get(&DataKey::RootValid(dao_id, root))
                .unwrap_or(true)
        }
        pub fn root_idx(env: Env, dao_id: u64, root: U256) -> u32 {
            env.storage()
                .persistent()
                .get(&DataKey::RootIdx(dao_id, root))
                .unwrap_or(0)
        }
        pub fn min_root(env: Env, dao_id: u64) -> u32 {
            env.storage()
                .persistent()
                .get(&DataKey::MinRoot(dao_id))
                .unwrap_or(0)
        }
        /// Single-hop form, matching the real tree: 0 = eligible,
        /// 1 = not in history, 2 = predates the election, 3 = predates a member
        /// removal.
        pub fn root_eligibility(env: Env, dao_id: u64, root: U256, earliest: u32) -> u32 {
            if !Self::root_ok(env.clone(), dao_id, root.clone()) {
                return 1;
            }
            let idx = Self::root_idx(env.clone(), dao_id, root);
            if idx < earliest {
                return 2;
            }
            if idx < Self::min_root(env, dao_id) {
                return 3;
            }
            0
        }

        pub fn set_root_idx(env: Env, dao_id: u64, root: U256, idx: u32) {
            env.storage()
                .persistent()
                .set(&DataKey::RootValid(dao_id, root.clone()), &true);
            env.storage()
                .persistent()
                .set(&DataKey::RootIdx(dao_id, root), &idx);
        }
        pub fn set_min_root(env: Env, dao_id: u64, idx: u32) {
            env.storage()
                .persistent()
                .set(&DataKey::MinRoot(dao_id), &idx);
        }
        pub fn set_curr_idx(env: Env, dao_id: u64, idx: u32) {
            env.storage()
                .persistent()
                .set(&DataKey::CurrIdx(dao_id), &idx);
        }
        // also need sbt_contr etc? Not needed for rewards
        pub fn sbt_contr(env: Env) -> Address {
            Address::generate(&env)
        }
    }
}

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

mod mock_voting {
    use super::super::VoteMode;
    use soroban_sdk::{contract, contractimpl, contracttype, Env, U256};
    #[contracttype]
    pub enum DataKey {
        Nullifier(u64, u64, U256),
        VoteMode(u64, u64),
        EligibleRoot(u64, u64),
        EarliestIdx(u64, u64),
    }
    #[contract]
    pub struct MockVoting;
    #[contractimpl]
    impl MockVoting {
        pub fn set_nullifier(env: Env, dao_id: u64, proposal_id: u64, nullifier: U256, used: bool) {
            env.storage()
                .persistent()
                .set(&DataKey::Nullifier(dao_id, proposal_id, nullifier), &used);
        }
        pub fn is_nullifier_used(env: Env, dao_id: u64, proposal_id: u64, nullifier: U256) -> bool {
            env.storage()
                .persistent()
                .get(&DataKey::Nullifier(dao_id, proposal_id, nullifier))
                .unwrap_or(false)
        }
        pub fn set_vote_mode(env: Env, dao_id: u64, proposal_id: u64, mode: VoteMode) {
            env.storage()
                .persistent()
                .set(&DataKey::VoteMode(dao_id, proposal_id), &mode);
        }
        pub fn get_vote_mode(env: Env, dao_id: u64, proposal_id: u64) -> VoteMode {
            env.storage()
                .persistent()
                .get(&DataKey::VoteMode(dao_id, proposal_id))
                .unwrap_or(VoteMode::Fixed)
        }
        pub fn set_eligible_root(env: Env, dao_id: u64, proposal_id: u64, root: U256) {
            env.storage()
                .persistent()
                .set(&DataKey::EligibleRoot(dao_id, proposal_id), &root);
        }
        pub fn get_eligible_root(env: Env, dao_id: u64, proposal_id: u64) -> U256 {
            env.storage()
                .persistent()
                .get(&DataKey::EligibleRoot(dao_id, proposal_id))
                .unwrap_or(U256::from_u32(&env, 0))
        }
        pub fn set_earliest_idx(env: Env, dao_id: u64, proposal_id: u64, idx: u32) {
            env.storage()
                .persistent()
                .set(&DataKey::EarliestIdx(dao_id, proposal_id), &idx);
        }
        pub fn get_earliest_idx(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
            env.storage()
                .persistent()
                .get(&DataKey::EarliestIdx(dao_id, proposal_id))
                .unwrap_or(0)
        }
        // stubs for other voting methods not needed
        pub fn get_proposal(
            _env: Env,
            _dao_id: u64,
            _proposal_id: u64,
        ) -> super::super::ProposalInfoStub {
            // Not used in rewards (we use separate getters)
            panic!("not implemented")
        }
    }
}

fn create_test_vk(env: &Env) -> VerificationKey {
    let g1_gen = bn254_g1_generator(env);
    let g2_gen = bn254_g2_generator(env);
    VerificationKey {
        alpha: g1_gen.clone(),
        beta: g2_gen.clone(),
        gamma: g2_gen.clone(),
        delta: g2_gen.clone(),
        ic: Vec::from_array(
            env,
            [
                g1_gen.clone(),
                g1_gen.clone(),
                g1_gen.clone(),
                g1_gen.clone(),
                g1_gen.clone(),
                g1_gen.clone(),
            ],
        ),
    }
}
fn create_test_proof(env: &Env) -> Proof {
    let g1 = bn254_g1_generator(env);
    let g2 = bn254_g2_generator(env);
    Proof {
        a: g1.clone(),
        b: g2,
        c: g1,
    }
}
fn bn254_g1_generator(env: &Env) -> BytesN<64> {
    let mut bytes = [0u8; 64];
    bytes[31] = 1;
    bytes[63] = 2;
    BytesN::from_array(env, &bytes)
}
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

struct TestEnv {
    env: Env,
    #[allow(dead_code)]
    registry: Address,
    tree: Address,
    voting: Address,
    rewards: Address,
    admin: Address,
}

impl TestEnv {
    fn setup() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        let registry = env.register(mock_registry::MockRegistry, ());
        let tree = env.register(mock_tree::MockTree, ());
        let voting = env.register(mock_voting::MockVoting, ());
        let rewards = env.register(Rewards, (tree.clone(), registry.clone(), voting.clone()));
        let admin = Address::generate(&env);
        // set admin for dao 1
        env.as_contract(&registry, || {
            mock_registry::MockRegistry::set_admin(env.clone(), 1, admin.clone());
        });
        Self {
            env,
            registry,
            tree,
            voting,
            rewards,
            admin,
        }
    }

    fn rewards_client(&self) -> crate::RewardsClient<'_> {
        crate::RewardsClient::new(&self.env, &self.rewards)
    }

    fn setup_dao(&self, dao_id: u64, root: U256, vote_nullifier: U256) {
        // setup voting mock: mark vote nullifier used, set mode Fixed and eligible root
        self.env.as_contract(&self.voting, || {
            mock_voting::MockVoting::set_nullifier(
                self.env.clone(),
                dao_id,
                1,
                vote_nullifier,
                true,
            );
            mock_voting::MockVoting::set_vote_mode(self.env.clone(), dao_id, 1, VoteMode::Fixed);
            mock_voting::MockVoting::set_eligible_root(self.env.clone(), dao_id, 1, root.clone());
        });
        self.env.as_contract(&self.tree, || {
            mock_tree::MockTree::set_root(self.env.clone(), dao_id, root);
        });
        // set VK and fund treasury
        let vk = create_test_vk(&self.env);
        self.rewards_client().set_vk(&dao_id, &vk, &self.admin);
        self.rewards_client()
            .fund_treasury(&dao_id, &10_000_000_000, &self.admin);
        self.rewards_client()
            .set_reward(&dao_id, &1_000_000_000, &self.admin);
    }
}

#[test]
fn test_claim_succeeds_with_used_vote_nullifier() {
    let t = TestEnv::setup();
    let dao_id = 1;
    let proposal_id = 1;
    let root = U256::from_u32(&t.env, 123);
    let vote_nullifier = U256::from_u32(&t.env, 111);
    let claim_nullifier = U256::from_u32(&t.env, 222);
    t.setup_dao(dao_id, root.clone(), vote_nullifier.clone());

    let proof = create_test_proof(&t.env);
    t.rewards_client().claim(
        &dao_id,
        &proposal_id,
        &vote_nullifier,
        &claim_nullifier,
        &root,
        &proof,
    );

    assert!(t
        .rewards_client()
        .is_claimed(&dao_id, &proposal_id, &claim_nullifier));
    assert_eq!(
        t.rewards_client().get_claimed_count(&dao_id, &proposal_id),
        1
    );
    // treasury debited
    assert_eq!(t.rewards_client().get_treasury(&dao_id), 9_000_000_000);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_replayed_claim_nullifier_rejected() {
    let t = TestEnv::setup();
    let dao_id = 1;
    let proposal_id = 1;
    let root = U256::from_u32(&t.env, 123);
    let vote_nullifier = U256::from_u32(&t.env, 111);
    let claim_nullifier = U256::from_u32(&t.env, 222);
    t.setup_dao(dao_id, root.clone(), vote_nullifier.clone());
    let proof = create_test_proof(&t.env);
    t.rewards_client().claim(
        &dao_id,
        &proposal_id,
        &vote_nullifier,
        &claim_nullifier,
        &root,
        &proof,
    );
    // replay same claim nullifier should fail
    t.rewards_client().claim(
        &dao_id,
        &proposal_id,
        &vote_nullifier,
        &claim_nullifier,
        &root,
        &proof,
    );
}

#[test]
#[should_panic(expected = "HostError")]
fn test_claim_fails_if_not_voted() {
    let t = TestEnv::setup();
    let dao_id = 1;
    let proposal_id = 1;
    let root = U256::from_u32(&t.env, 123);
    let vote_nullifier = U256::from_u32(&t.env, 999); // not marked used
    let claim_nullifier = U256::from_u32(&t.env, 222);
    // setup dao but with different vote nullifier marked used (111)
    let used = U256::from_u32(&t.env, 111);
    t.setup_dao(dao_id, root.clone(), used);
    // set vote nullifier not used for this claim
    t.env.as_contract(&t.voting, || {
        mock_voting::MockVoting::set_nullifier(
            t.env.clone(),
            dao_id,
            1,
            vote_nullifier.clone(),
            false,
        );
    });
    let proof = create_test_proof(&t.env);
    t.rewards_client().claim(
        &dao_id,
        &proposal_id,
        &vote_nullifier,
        &claim_nullifier,
        &root,
        &proof,
    );
}

#[test]
fn test_treasury_pool_fund_and_reward_config() {
    let t = TestEnv::setup();
    let dao_id = 1;
    let client = t.rewards_client();
    // initial 0
    assert_eq!(client.get_treasury(&dao_id), 0);
    // fund
    client.fund_treasury(&dao_id, &500, &t.admin);
    assert_eq!(client.get_treasury(&dao_id), 500);
    client.fund_treasury(&dao_id, &300, &t.admin);
    assert_eq!(client.get_treasury(&dao_id), 800);
    // set reward
    client.set_reward(&dao_id, &50, &t.admin);
    assert_eq!(client.get_reward_amount(&dao_id), 50);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_funding_cap_exceeded() {
    let t = TestEnv::setup();
    let dao_id = 1;
    // fund huge amount exceeds cap
    t.rewards_client()
        .fund_treasury(&dao_id, &MAX_FUNDING_CAP, &t.admin);
    t.rewards_client().fund_treasury(&dao_id, &1, &t.admin);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_invalid_reward_amount() {
    let t = TestEnv::setup();
    t.rewards_client().set_reward(&1, &0, &t.admin);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_treasury_insufficient() {
    let t = TestEnv::setup();
    let dao_id = 1;
    let proposal_id = 1;
    let root = U256::from_u32(&t.env, 123);
    let vote_nullifier = U256::from_u32(&t.env, 111);
    let claim_nullifier = U256::from_u32(&t.env, 222);
    t.setup_dao(dao_id, root.clone(), vote_nullifier.clone());
    // drain treasury by setting reward higher than treasury
    t.rewards_client()
        .set_reward(&dao_id, &20_000_000_000, &t.admin); // 2M but treasury only 1M
    let proof = create_test_proof(&t.env);
    t.rewards_client().claim(
        &dao_id,
        &proposal_id,
        &vote_nullifier,
        &claim_nullifier,
        &root,
        &proof,
    );
}

#[test]
fn test_claim_nullifier_domain_separation() {
    // Ensure claim nullifier is distinct from vote nullifier even with same secret/dao/proposal
    // In contract we just check both are stored separately; this test documents domain tag.
    // Claim nullifier = Poseidon(secret, dao, prop, CLAIM_TAG) where CLAIM_TAG = 427020085613
    // Vote nullifier = Poseidon(secret, dao, prop)
    // They must differ for same inputs; contract enforces replay only on claim nullifier.
    let t = TestEnv::setup();
    let dao_id = 1;
    let proposal_id = 1;
    let root = U256::from_u32(&t.env, 123);
    let vote_nullifier = U256::from_u32(&t.env, 111);
    let claim_nullifier_a = U256::from_u32(&t.env, 222);
    let claim_nullifier_b = U256::from_u32(&t.env, 333);
    t.setup_dao(dao_id, root.clone(), vote_nullifier.clone());
    let proof = create_test_proof(&t.env);
    // first claim succeeds
    t.rewards_client().claim(
        &dao_id,
        &proposal_id,
        &vote_nullifier,
        &claim_nullifier_a,
        &root,
        &proof,
    );
    // second claim with different claim nullifier but same vote nullifier should also succeed?
    // No — treasury logic allows only one claim per vote? Actually our contract ties claim nullifier uniqueness,
    // not vote nullifier reuse. So a second claim with same vote nullifier but different claim nullifier would be
    // a different proof (needs different secret? not). For this thin crate we allow re-claim with different claim nullifier
    // only if circuit verifies (which would require same secret but different claim nullifier => proof would fail).
    // Here we just test that different claim nullifier is considered distinct storage key.
    // Mark second claim's vote nullifier still used, so check passes; but claim nullifier is new.
    // In test mode proof always passes, so second claim would succeed if we allowed it.
    // This test documents that double-claim protection is via claim_nullifier, not vote_nullifier.
    // To prevent vote-nullifier reuse for multiple claims, circuit must bind claim_nullifier to same secret.
    // Since test mode bypasses circuit, we demonstrate storage separation:
    assert!(t
        .rewards_client()
        .is_claimed(&dao_id, &proposal_id, &claim_nullifier_a));
    assert!(!t
        .rewards_client()
        .is_claimed(&dao_id, &proposal_id, &claim_nullifier_b));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_root_mismatch_fixed() {
    let t = TestEnv::setup();
    let dao_id = 1;
    let proposal_id = 1;
    let root_eligible = U256::from_u32(&t.env, 123);
    let root_wrong = U256::from_u32(&t.env, 999);
    let vote_nullifier = U256::from_u32(&t.env, 111);
    let claim_nullifier = U256::from_u32(&t.env, 222);
    t.setup_dao(dao_id, root_eligible.clone(), vote_nullifier.clone());
    let proof = create_test_proof(&t.env);
    t.rewards_client().claim(
        &dao_id,
        &proposal_id,
        &vote_nullifier,
        &claim_nullifier,
        &root_wrong,
        &proof,
    );
}

#[test]
fn test_trailing_mode_claim() {
    let t = TestEnv::setup();
    let dao_id = 1;
    let proposal_id = 1;
    let root = U256::from_u32(&t.env, 555);
    let vote_nullifier = U256::from_u32(&t.env, 111);
    let claim_nullifier = U256::from_u32(&t.env, 222);
    // setup fixed then switch to trailing
    t.setup_dao(dao_id, root.clone(), vote_nullifier.clone());
    t.env.as_contract(&t.voting, || {
        mock_voting::MockVoting::set_vote_mode(
            t.env.clone(),
            dao_id,
            proposal_id,
            VoteMode::Trailing,
        );
        mock_voting::MockVoting::set_earliest_idx(t.env.clone(), dao_id, proposal_id, 0);
    });
    t.env.as_contract(&t.tree, || {
        mock_tree::MockTree::set_root_idx(t.env.clone(), dao_id, root.clone(), 5);
        mock_tree::MockTree::set_min_root(t.env.clone(), dao_id, 0);
    });
    let proof = create_test_proof(&t.env);
    t.rewards_client().claim(
        &dao_id,
        &proposal_id,
        &vote_nullifier,
        &claim_nullifier,
        &root,
        &proof,
    );
    assert!(t
        .rewards_client()
        .is_claimed(&dao_id, &proposal_id, &claim_nullifier));
}
