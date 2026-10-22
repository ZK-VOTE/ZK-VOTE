#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Bytes, BytesN, Env, IntoVal, Symbol, Vec, U256,
};

mod poseidon_params;
mod poseidon_params_bls12_381;

const SBT_CONTRACT: Symbol = symbol_short!("sbt");
const REGISTRY: Symbol = symbol_short!("registry");
const VOTING_CONTRACT_KEY: Symbol = symbol_short!("voting");
const DEFAULT_MAX_ROOTS: u32 = 30;
const MIN_MAX_ROOTS: u32 = 10;
const MAX_MAX_ROOTS: u32 = 100;
const MAX_TREE_DEPTH: u32 = 18;
const MIN_REGISTRATION_INTERVAL_SECS: u64 = 3600;
const ZEROS_CACHE: Symbol = symbol_short!("zeros");
const ZEROS_CACHE_BLS: Symbol = symbol_short!("z_bls");
const VERSION: u32 = 2;
const VERSION_KEY: Symbol = symbol_short!("ver");

const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 6_312_000;
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 6_312_000;
pub const SWEEP_MAX_RECORDS: u32 = 50;

const POSEIDON_MDS: Symbol = symbol_short!("pos_mds");
const POSEIDON_RC: Symbol = symbol_short!("pos_rc");
const POSEIDON_MDS_BLS: Symbol = symbol_short!("mds_bl");
const POSEIDON_RC_BLS: Symbol = symbol_short!("rc_bls");

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum TreeError {
    NotAdmin = 1, InvalidDepth = 2, TreeInitialized = 3, TreeNotInitialized = 4,
    CommitmentExists = 5, MemberExists = 6, TreeFull = 7, NoSbt = 8, NotOpenMembership = 9,
    LeafOutOfBounds = 10, MemberRemoved = 11, MemberNotInTree = 12, RootNotFound = 13,
    AlreadyInitialized = 14, MemberNotRevoked = 15, CommitmentAlreadyUsed = 16,
    RateLimited = 17, MaxRootsOutOfRange = 18, RootPinnedByProposal = 19,
    Sha3TreeNotInitialized = 20, PqCommitmentExists = 21, InvalidField = 22,
    CommitmentPending = 23, CommitmentNotPending = 24, CommitmentRevealTooEarly = 25,
    CommitmentHashMismatch = 26, UnknownEpoch = 27, ReentrantCall = 28,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    TreeDepth(u64), NextLeafIndex(u64), FilledSubtrees(u64), Roots(u64),
    LeafIndex(u64, U256), MemberLeafIndex(u64, Address), LeafValue(u64, u32),
    NextRootIndex(u64), RootIndex(u64, U256), RevokedAt(u64, U256),
    ReinstatedAt(u64, U256), NodeHash(u64, u32, u32), MinValidRootIdx(u64),
    PoseidonField(u64), CommitmentUsed(u64, U256), MaxRoots(u64),
    LastRegistrationAt(u64, Address), Sha3Roots(u64), Sha3NextRootIdx(u64),
    Sha3RootIndex(u64, U256), PqCommitment(U256),
    PendingRegistration(u64, Address), CommitmentSaltHash(u64, BytesN<32>),
    Epoch(u64), EpochRoot(u64, u32), EpochAdvancedAt(u64, u32),
    ReentrancyLock,
}

#[contracttype] #[derive(Clone, Debug, PartialEq)]
pub struct PendingRegistration { pub commitment_hash: BytesN<32>, pub committed_at_ledger: u32, pub committed_at: u64, }

#[contracttype] #[derive(Clone, Debug, PartialEq)]
pub struct EpochInfo { pub epoch: u32, pub root: U256, pub advanced_at: u64, }

#[soroban_sdk::contractevent] #[derive(Clone, Debug, PartialEq)]
pub struct TreeInitEvent { #[topic] pub dao_id: u64, pub depth: u32, pub empty_root: U256, pub root_index: u32, }
#[soroban_sdk::contractevent] #[derive(Clone, Debug, PartialEq)]
pub struct CommitEvent { #[topic] pub dao_id: u64, pub commitment: U256, pub index: u32, pub new_root: U256, pub root_index: u32, }
#[soroban_sdk::contractevent] #[derive(Clone, Debug, PartialEq)]
pub struct RemovalEvent { #[topic] pub dao_id: u64, #[topic] pub member: Address, pub index: u32, pub new_root: U256, pub root_index: u32, }
#[soroban_sdk::contractevent] #[derive(Clone, Debug, PartialEq)]
pub struct ReinstatementEvent { #[topic] pub dao_id: u64, #[topic] pub member: Address, pub reinstated_at: u64, }
#[soroban_sdk::contractevent] #[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgraded { pub from: u32, pub to: u32, }
#[soroban_sdk::contractevent] #[derive(Clone, Debug, PartialEq)]
pub struct RootEvictedEvent { #[topic] pub dao_id: u64, pub evicted_root: U256, pub roots_len_after: u32, }
#[soroban_sdk::contractevent] #[derive(Clone, Debug, PartialEq)]
pub struct CommitmentCommittedEvent { #[topic] pub dao_id: u64, #[topic] pub member: Address, pub commitment_hash: BytesN<32>, pub committed_at_ledger: u32, }
#[soroban_sdk::contractevent] #[derive(Clone, Debug, PartialEq)]
pub struct CommitmentRevealedEvent { #[topic] pub dao_id: u64, #[topic] pub member: Address, pub commitment: U256, pub index: u32, }
#[soroban_sdk::contractevent] #[derive(Clone, Debug, PartialEq)]
pub struct EpochAdvancedEvent { #[topic] pub dao_id: u64, pub epoch: u32, pub root: U256, pub advanced_at: u64, }

#[contract] pub struct MembershipTree;

#[contractimpl]
impl MembershipTree {
    fn bump_instance(env: &Env) { env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND); }
    fn bump_persistent<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
        env.storage().persistent().extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }
    fn lock(env: &Env) {
        if env.storage().instance().has(&DataKey::ReentrancyLock) { panic_with_error!(env, TreeError::ReentrantCall); }
        env.storage().instance().set(&DataKey::ReentrancyLock, &true);
    }
    fn unlock(env: &Env) { env.storage().instance().remove(&DataKey::ReentrancyLock); }

    fn get_max_roots(env: &Env, dao_id: u64) -> u32 { env.storage().persistent().get(&DataKey::MaxRoots(dao_id)).unwrap_or(DEFAULT_MAX_ROOTS) }
    fn voting_contract(env: &Env) -> Option<Address> { env.storage().instance().get(&VOTING_CONTRACT_KEY) }

    pub fn set_voting_contract(env: Env, voting_contract: Address, registry: Address) {
        Self::bump_instance(&env); registry.require_auth();
        let expected: Address = env.storage().instance().get(&REGISTRY).unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));
        if registry != expected { panic_with_error!(&env, TreeError::NotAdmin); }
        env.storage().instance().set(&VOTING_CONTRACT_KEY, &voting_contract);
    }
    pub fn set_max_roots(env: Env, dao_id: u64, new_max: u32, admin: Address) {
        Self::lock(&env); Self::bump_instance(&env); admin.require_auth();
        let sbt_contract = Self::sbt_contract(&env);
        let registry: Address = env.invoke_contract(&sbt_contract, &symbol_short!("registry"), soroban_sdk::vec![&env]);
        let dao_admin: Address = env.invoke_contract(&registry, &symbol_short!("get_admin"), soroban_sdk::vec![&env, dao_id.into_val(&env)]);
        if dao_admin != admin { Self::unlock(&env); panic_with_error!(&env, TreeError::NotAdmin); }
        if new_max < MIN_MAX_ROOTS || new_max > MAX_MAX_ROOTS { Self::unlock(&env); panic_with_error!(&env, TreeError::MaxRootsOutOfRange); }
        let key = DataKey::MaxRoots(dao_id); env.storage().persistent().set(&key, &new_max); Self::bump_persistent(&env, &key); Self::unlock(&env);
    }
    pub fn max_roots(env: Env, dao_id: u64) -> u32 { Self::bump_instance(&env); Self::get_max_roots(&env, dao_id) }
    pub fn roots_len(env: Env, dao_id: u64) -> u32 {
        Self::bump_instance(&env);
        let roots: Vec<U256> = env.storage().persistent().get(&DataKey::Roots(dao_id)).unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));
        roots.len()
    }
    fn check_root_eviction_safety(env: &Env, dao_id: u64, candidate_root: &U256) {
        let Some(voting_addr) = Self::voting_contract(env) else { return; };
        let is_pinned: bool = env.invoke_contract(&voting_addr, &symbol_short!("root_pin"), soroban_sdk::vec![env, dao_id.into_val(env), candidate_root.clone().into_val(env)]);
        if is_pinned { panic_with_error!(env, TreeError::RootPinnedByProposal); }
        let _: () = env.invoke_contract(&voting_addr, &symbol_short!("chk_risk"), soroban_sdk::vec![env, dao_id.into_val(env), candidate_root.clone().into_val(env)]);
    }
    fn evict_oldest_root(env: &Env, dao_id: u64, roots: &mut Vec<U256>) {
        if let Some(evicted_root) = roots.get(0) {
            let evicted_key = DataKey::RootIndex(dao_id, evicted_root.clone()); env.storage().persistent().remove(&evicted_key);
            let mut new_roots = Vec::new(env); for i in 1..roots.len() { if let Some(r) = roots.get(i) { new_roots.push_back(r); } }
            *roots = new_roots;
            RootEvictedEvent { dao_id, evicted_root, roots_len_after: roots.len() }.publish(env);
        }
    }
    pub fn __constructor(env: Env, sbt_contract: Address, registry: Address) {
        if env.storage().instance().has(&VERSION_KEY) { panic_with_error!(&env, TreeError::AlreadyInitialized); }
        env.storage().instance().set(&VERSION_KEY, &VERSION);
        ContractUpgraded { from: 0, to: VERSION }.publish(&env);
        env.storage().instance().set(&SBT_CONTRACT, &sbt_contract);
        env.storage().instance().set(&REGISTRY, &registry);
        Self::ensure_zeros_cache(&env);
    }
    fn sbt_contract(env: &Env) -> Address { env.storage().instance().get(&SBT_CONTRACT).unwrap_or_else(|| panic_with_error!(env, TreeError::TreeNotInitialized)) }

    pub fn init_tree(env: Env, dao_id: u64, depth: u32, field: Symbol, admin: Address) {
        Self::lock(&env); Self::bump_instance(&env); admin.require_auth();
        let sbt_contract: Address = Self::sbt_contract(&env);
        let registry: Address = env.invoke_contract(&sbt_contract, &symbol_short!("registry"), soroban_sdk::vec![&env]);
        let dao_admin: Address = env.invoke_contract(&registry, &symbol_short!("get_admin"), soroban_sdk::vec![&env, dao_id.into_val(&env)]);
        if dao_admin != admin { Self::unlock(&env); panic_with_error!(&env, TreeError::NotAdmin); }
        if depth == 0 || depth > MAX_TREE_DEPTH { Self::unlock(&env); panic_with_error!(&env, TreeError::InvalidDepth); }
        Self::assert_valid_field(&env, &field);
        let depth_key = DataKey::TreeDepth(dao_id);
        if env.storage().persistent().has(&depth_key) { Self::unlock(&env); panic_with_error!(&env, TreeError::TreeInitialized); }
        env.storage().persistent().set(&depth_key, &depth); Self::bump_persistent(&env, &depth_key);
        let next_leaf_key = DataKey::NextLeafIndex(dao_id); env.storage().persistent().set(&next_leaf_key, &0u32); Self::bump_persistent(&env, &next_leaf_key);
        let field_key = DataKey::PoseidonField(dao_id); env.storage().persistent().set(&field_key, &field); Self::bump_persistent(&env, &field_key);
        let next_root_key = DataKey::NextRootIndex(dao_id); env.storage().persistent().set(&next_root_key, &0u32); Self::bump_persistent(&env, &next_root_key);
        let mut filled = Vec::new(&env); for level in 0..depth { filled.push_back(Self::zero_at_level_for_field(&env, level, &field)); }
        let filled_key = DataKey::FilledSubtrees(dao_id); env.storage().persistent().set(&filled_key, &filled); Self::bump_persistent(&env, &filled_key);
        let empty_root = Self::zero_at_level_for_field(&env, depth, &field);
        let mut roots = Vec::new(&env); roots.push_back(empty_root.clone());
        let roots_key = DataKey::Roots(dao_id); env.storage().persistent().set(&roots_key, &roots); Self::bump_persistent(&env, &roots_key);
        let root_idx_key = DataKey::RootIndex(dao_id, empty_root.clone()); env.storage().persistent().set(&root_idx_key, &0u32); Self::bump_persistent(&env, &root_idx_key);
        Self::init_epoch_zero(&env, dao_id, empty_root.clone());
        TreeInitEvent { dao_id, depth, empty_root, root_index: 0 }.publish(&env); Self::unlock(&env);
    }

    pub fn init_tree_from_registry(env: Env, dao_id: u64, depth: u32, field: Symbol) {
        Self::lock(&env); Self::bump_instance(&env);
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap_or_else(|| panic_with_error!(&env, TreeError::NotAdmin));
        registry.require_auth();
        if depth == 0 || depth > MAX_TREE_DEPTH { Self::unlock(&env); panic_with_error!(&env, TreeError::InvalidDepth); }
        Self::assert_valid_field(&env, &field);
        let depth_key = DataKey::TreeDepth(dao_id);
        if env.storage().persistent().has(&depth_key) { Self::unlock(&env); panic_with_error!(&env, TreeError::TreeInitialized); }
        env.storage().persistent().set(&depth_key, &depth); Self::bump_persistent(&env, &depth_key);
        let next_leaf_key = DataKey::NextLeafIndex(dao_id); env.storage().persistent().set(&next_leaf_key, &0u32); Self::bump_persistent(&env, &next_leaf_key);
        let field_key = DataKey::PoseidonField(dao_id); env.storage().persistent().set(&field_key, &field); Self::bump_persistent(&env, &field_key);
        let next_root_key = DataKey::NextRootIndex(dao_id); env.storage().persistent().set(&next_root_key, &0u32); Self::bump_persistent(&env, &next_root_key);
        let mut filled = Vec::new(&env); for level in 0..depth { filled.push_back(Self::zero_at_level_for_field(&env, level, &field)); }
        let filled_key = DataKey::FilledSubtrees(dao_id); env.storage().persistent().set(&filled_key, &filled); Self::bump_persistent(&env, &filled_key);
        let empty_root = Self::zero_at_level_for_field(&env, depth, &field);
        let mut roots = Vec::new(&env); roots.push_back(empty_root.clone());
        let roots_key = DataKey::Roots(dao_id); env.storage().persistent().set(&roots_key, &roots); Self::bump_persistent(&env, &roots_key);
        let root_idx_key = DataKey::RootIndex(dao_id, empty_root.clone()); env.storage().persistent().set(&root_idx_key, &0u32); Self::bump_persistent(&env, &root_idx_key);
        Self::init_epoch_zero(&env, dao_id, empty_root.clone());
        TreeInitEvent { dao_id, depth, empty_root, root_index: 0 }.publish(&env); Self::unlock(&env);
    }

    fn init_epoch_zero(env: &Env, dao_id: u64, root: U256) {
        let epoch_key = DataKey::Epoch(dao_id); env.storage().persistent().set(&epoch_key, &0u32); Self::bump_persistent(env, &epoch_key);
        let root_key = DataKey::EpochRoot(dao_id, 0u32); env.storage().persistent().set(&root_key, &root); Self::bump_persistent(env, &root_key);
        let at_key = DataKey::EpochAdvancedAt(dao_id, 0u32); env.storage().persistent().set(&at_key, &env.ledger().timestamp()); Self::bump_persistent(env, &at_key);
    }
    fn reserve_commitment(env: &Env, dao_id: u64, commitment: &U256) {
        let used_key = DataKey::CommitmentUsed(dao_id, commitment.clone());
        let legacy_key = DataKey::LeafIndex(dao_id, commitment.clone());
        if env.storage().persistent().has(&used_key) || env.storage().persistent().has(&legacy_key) { panic_with_error!(env, TreeError::CommitmentAlreadyUsed); }
        env.storage().persistent().set(&used_key, &true); Self::bump_persistent(env, &used_key);
    }
    fn enforce_registration_cooldown(env: &Env, dao_id: u64, member: &Address) {
        let key = DataKey::LastRegistrationAt(dao_id, member.clone());
        let last: Option<u64> = env.storage().persistent().get(&key);
        if last.is_some() { Self::bump_persistent(env, &key); }
        if let Some(last) = last { if env.ledger().timestamp() < last.saturating_add(MIN_REGISTRATION_INTERVAL_SECS) { panic_with_error!(env, TreeError::RateLimited); } }
    }
    fn record_registration(env: &Env, dao_id: u64, member: &Address) {
        let key = DataKey::LastRegistrationAt(dao_id, member.clone());
        env.storage().persistent().set(&key, &env.ledger().timestamp()); Self::bump_persistent(env, &key);
    }

    pub fn register_from_registry(env: Env, dao_id: u64, commitment: U256, member: Address) {
        Self::lock(&env); Self::bump_instance(&env);
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap_or_else(|| panic_with_error!(&env, TreeError::NotAdmin));
        registry.require_auth();
        let depth_key = DataKey::TreeDepth(dao_id);
        if !env.storage().persistent().has(&depth_key) { Self::unlock(&env); panic_with_error!(&env, TreeError::TreeNotInitialized); }
        Self::enforce_registration_cooldown(&env, dao_id, &member); Self::reserve_commitment(&env, dao_id, &commitment);
        let leaf_key = DataKey::LeafIndex(dao_id, commitment.clone());
        let member_key = DataKey::MemberLeafIndex(dao_id, member.clone());
        if env.storage().persistent().has(&member_key) { Self::unlock(&env); panic_with_error!(&env, TreeError::MemberExists); }
        let depth: u32 = env.storage().persistent().get(&depth_key).unwrap();
        let next_index: u32 = env.storage().persistent().get(&DataKey::NextLeafIndex(dao_id)).unwrap();
        if next_index >= (1u32 << depth) { Self::unlock(&env); panic_with_error!(&env, TreeError::TreeFull); }
        let (new_root, root_index) = Self::insert_leaf(&env, dao_id, commitment.clone(), next_index, depth);
        env.storage().persistent().set(&DataKey::NextLeafIndex(dao_id), &(next_index+1)); Self::bump_persistent(&env, &DataKey::NextLeafIndex(dao_id));
        env.storage().persistent().set(&leaf_key, &next_index); Self::bump_persistent(&env, &leaf_key);
        env.storage().persistent().set(&member_key, &next_index); Self::bump_persistent(&env, &member_key);
        let leaf_value_key = DataKey::LeafValue(dao_id, next_index); env.storage().persistent().set(&leaf_value_key, &commitment); Self::bump_persistent(&env, &leaf_value_key);
        CommitEvent { dao_id, commitment, index: next_index, new_root, root_index }.publish(&env);
        Self::record_registration(&env, dao_id, &member); Self::unlock(&env);
    }

    pub fn register_with_caller(env: Env, dao_id: u64, commitment: U256, caller: Address) {
        Self::register_with_caller_internal(env, dao_id, commitment, caller, true);
    }

    fn register_with_caller_internal(env: Env, dao_id: u64, commitment: U256, caller: Address, require_auth: bool) {
        Self::lock(&env); Self::bump_instance(&env);
        if require_auth { caller.require_auth(); }
        let sbt_contract: Address = Self::sbt_contract(&env);
        let has_sbt: bool = env.invoke_contract(&sbt_contract, &symbol_short!("has"), soroban_sdk::vec![&env, dao_id.into_val(&env), caller.clone().into_val(&env)]);
        if !has_sbt { Self::unlock(&env); panic_with_error!(&env, TreeError::NoSbt); }
        Self::enforce_registration_cooldown(&env, dao_id, &caller);
        let depth_key = DataKey::TreeDepth(dao_id);
        if !env.storage().persistent().has(&depth_key) { Self::unlock(&env); panic_with_error!(&env, TreeError::TreeNotInitialized); }
        Self::reserve_commitment(&env, dao_id, &commitment);
        let leaf_key = DataKey::LeafIndex(dao_id, commitment.clone());
        let member_key = DataKey::MemberLeafIndex(dao_id, caller.clone());
        if env.storage().persistent().has(&member_key) { Self::unlock(&env); panic_with_error!(&env, TreeError::MemberExists); }
        let depth: u32 = env.storage().persistent().get(&depth_key).unwrap();
        let next_index: u32 = env.storage().persistent().get(&DataKey::NextLeafIndex(dao_id)).unwrap();
        if next_index >= (1u32 << depth) { Self::unlock(&env); panic_with_error!(&env, TreeError::TreeFull); }
        let (new_root, root_index) = Self::insert_leaf(&env, dao_id, commitment.clone(), next_index, depth);
        env.storage().persistent().set(&DataKey::NextLeafIndex(dao_id), &(next_index+1)); Self::bump_persistent(&env, &DataKey::NextLeafIndex(dao_id));
        env.storage().persistent().set(&leaf_key, &next_index); Self::bump_persistent(&env, &leaf_key);
        env.storage().persistent().set(&member_key, &next_index); Self::bump_persistent(&env, &member_key);
        let leaf_value_key = DataKey::LeafValue(dao_id, next_index); env.storage().persistent().set(&leaf_value_key, &commitment); Self::bump_persistent(&env, &leaf_value_key);
        CommitEvent { dao_id, commitment, index: next_index, new_root, root_index }.publish(&env);
        Self::record_registration(&env, dao_id, &caller); Self::unlock(&env);
    }

    pub fn self_register(env: Env, dao_id: u64, commitment: U256, member: Address) {
        Self::lock(&env); Self::bump_instance(&env); member.require_auth();
        let sbt_contract: Address = Self::sbt_contract(&env);
        let has_sbt: bool = env.invoke_contract(&sbt_contract, &symbol_short!("has"), soroban_sdk::vec![&env, dao_id.into_val(&env), member.clone().into_val(&env)]);
        if !has_sbt { Self::unlock(&env); panic_with_error!(&env, TreeError::NoSbt); }
        let registry: Address = env.invoke_contract(&sbt_contract, &symbol_short!("registry"), soroban_sdk::vec![&env]);
        let membership_open: bool = env.invoke_contract(&registry, &Symbol::new(&env, "is_membership_open"), soroban_sdk::vec![&env, dao_id.into_val(&env)]);
        if !membership_open { Self::unlock(&env); panic_with_error!(&env, TreeError::NotOpenMembership); }
        Self::enforce_registration_cooldown(&env, dao_id, &member);
        let depth_key = DataKey::TreeDepth(dao_id);
        if !env.storage().persistent().has(&depth_key) { Self::unlock(&env); panic_with_error!(&env, TreeError::TreeNotInitialized); }
        Self::reserve_commitment(&env, dao_id, &commitment);
        let leaf_key = DataKey::LeafIndex(dao_id, commitment.clone());
        let member_key = DataKey::MemberLeafIndex(dao_id, member.clone());
        if env.storage().persistent().has(&member_key) { Self::unlock(&env); panic_with_error!(&env, TreeError::MemberExists); }
        let depth: u32 = env.storage().persistent().get(&depth_key).unwrap();
        let next_index: u32 = env.storage().persistent().get(&DataKey::NextLeafIndex(dao_id)).unwrap();
        if next_index >= (1u32 << depth) { Self::unlock(&env); panic_with_error!(&env, TreeError::TreeFull); }
        let (new_root, root_index) = Self::insert_leaf(&env, dao_id, commitment.clone(), next_index, depth);
        env.storage().persistent().set(&DataKey::NextLeafIndex(dao_id), &(next_index+1)); Self::bump_persistent(&env, &DataKey::NextLeafIndex(dao_id));
        env.storage().persistent().set(&leaf_key, &next_index); Self::bump_persistent(&env, &leaf_key);
        env.storage().persistent().set(&member_key, &next_index); Self::bump_persistent(&env, &member_key);
        let leaf_value_key = DataKey::LeafValue(dao_id, next_index); env.storage().persistent().set(&leaf_value_key, &commitment); Self::bump_persistent(&env, &leaf_value_key);
        CommitEvent { dao_id, commitment, index: next_index, new_root, root_index }.publish(&env);
        Self::record_registration(&env, dao_id, &member); Self::unlock(&env);
    }

    pub fn hash_registration(env: Env, commitment: U256, salt: BytesN<32>) -> BytesN<32> {
        Self::bump_instance(&env);
        let mut input = Bytes::new(&env); input.append(&commitment.to_be_bytes()); input.append(&Bytes::from_array(&env, &salt.to_array()));
        env.crypto().sha256(&input).into()
    }
    pub fn commit_registration(env: Env, dao_id: u64, commitment_hash: BytesN<32>, caller: Address) {
        Self::lock(&env); Self::bump_instance(&env); caller.require_auth();
        let sbt_contract: Address = Self::sbt_contract(&env);
        let has_sbt: bool = env.invoke_contract(&sbt_contract, &symbol_short!("has"), soroban_sdk::vec![&env, dao_id.into_val(&env), caller.clone().into_val(&env)]);
        if !has_sbt { Self::unlock(&env); panic_with_error!(&env, TreeError::NoSbt); }
        let depth_key = DataKey::TreeDepth(dao_id);
        if !env.storage().persistent().has(&depth_key) { Self::unlock(&env); panic_with_error!(&env, TreeError::TreeNotInitialized); }
        let pending_key = DataKey::PendingRegistration(dao_id, caller.clone());
        if env.storage().persistent().has(&pending_key) { Self::unlock(&env); panic_with_error!(&env, TreeError::CommitmentPending); }
        let replay_key = DataKey::CommitmentSaltHash(dao_id, commitment_hash.clone());
        if env.storage().persistent().has(&replay_key) { Self::unlock(&env); panic_with_error!(&env, TreeError::CommitmentAlreadyUsed); }
        let pending = PendingRegistration { commitment_hash: commitment_hash.clone(), committed_at_ledger: env.ledger().sequence(), committed_at: env.ledger().timestamp() };
        env.storage().persistent().set(&pending_key, &pending); Self::bump_persistent(&env, &pending_key);
        env.storage().persistent().set(&replay_key, &true); Self::bump_persistent(&env, &replay_key);
        CommitmentCommittedEvent { dao_id, member: caller, commitment_hash, committed_at_ledger: env.ledger().sequence() }.publish(&env); Self::unlock(&env);
    }
    pub fn reveal_registration(env: Env, dao_id: u64, commitment: U256, salt: BytesN<32>, caller: Address) {
        Self::bump_instance(&env); caller.require_auth();
        let pending_key = DataKey::PendingRegistration(dao_id, caller.clone());
        let pending: PendingRegistration = env.storage().persistent().get(&pending_key).unwrap_or_else(|| panic_with_error!(&env, TreeError::CommitmentNotPending));
        if env.ledger().sequence() <= pending.committed_at_ledger { panic_with_error!(&env, TreeError::CommitmentRevealTooEarly); }
        let expected = Self::hash_registration(env.clone(), commitment.clone(), salt);
        if expected != pending.commitment_hash { panic_with_error!(&env, TreeError::CommitmentHashMismatch); }
        env.storage().persistent().remove(&pending_key);
        let replay_key = DataKey::CommitmentSaltHash(dao_id, pending.commitment_hash.clone()); env.storage().persistent().remove(&replay_key);
        Self::register_with_caller_internal(env.clone(), dao_id, commitment.clone(), caller.clone(), false);
        let index: u32 = env.storage().persistent().get(&DataKey::LeafIndex(dao_id, commitment.clone())).unwrap_or(0);
        CommitmentRevealedEvent { dao_id, member: caller, commitment, index }.publish(&env);
    }
    pub fn pending_registration(env: Env, dao_id: u64, member: Address) -> Option<PendingRegistration> {
        Self::bump_instance(&env); env.storage().persistent().get(&DataKey::PendingRegistration(dao_id, member))
    }

    pub fn advance_epoch(env: Env, dao_id: u64, admin: Address) -> u32 {
        Self::lock(&env); Self::bump_instance(&env); admin.require_auth();
        let sbt_contract: Address = Self::sbt_contract(&env);
        let registry: Address = env.invoke_contract(&sbt_contract, &symbol_short!("registry"), soroban_sdk::vec![&env]);
        let dao_admin: Address = env.invoke_contract(&registry, &symbol_short!("get_admin"), soroban_sdk::vec![&env, dao_id.into_val(&env)]);
        if dao_admin != admin { Self::unlock(&env); panic_with_error!(&env, TreeError::NotAdmin); }
        let current: u32 = Self::current_epoch_internal(&env, dao_id);
        let next = current+1;
        let root = Self::current_root(env.clone(), dao_id);
        let at_key = DataKey::EpochAdvancedAt(dao_id, next); env.storage().persistent().set(&at_key, &env.ledger().timestamp()); Self::bump_persistent(&env, &at_key);
        let root_key = DataKey::EpochRoot(dao_id, next); env.storage().persistent().set(&root_key, &root); Self::bump_persistent(&env, &root_key);
        let epoch_key = DataKey::Epoch(dao_id); env.storage().persistent().set(&epoch_key, &next); Self::bump_persistent(&env, &epoch_key);
        EpochAdvancedEvent { dao_id, epoch: next, root, advanced_at: env.ledger().timestamp() }.publish(&env); Self::unlock(&env); next
    }
    pub fn current_epoch(env: Env, dao_id: u64) -> u32 { Self::bump_instance(&env); Self::current_epoch_internal(&env, dao_id) }
    fn current_epoch_internal(env: &Env, dao_id: u64) -> u32 { env.storage().persistent().get(&DataKey::Epoch(dao_id)).unwrap_or(0) }
    pub fn epoch_root(env: Env, dao_id: u64, epoch: u32) -> U256 {
        Self::bump_instance(&env);
        let key = DataKey::EpochRoot(dao_id, epoch);
        let root: U256 = env.storage().persistent().get(&key).unwrap_or_else(|| panic_with_error!(&env, TreeError::UnknownEpoch));
        Self::bump_persistent(&env, &key); root
    }
    pub fn epoch_advanced_at(env: Env, dao_id: u64, epoch: u32) -> u64 {
        Self::bump_instance(&env); let key = DataKey::EpochAdvancedAt(dao_id, epoch);
        let at: u64 = env.storage().persistent().get(&key).unwrap_or_else(|| panic_with_error!(&env, TreeError::UnknownEpoch)); Self::bump_persistent(&env, &key); at
    }
    pub fn get_epoch_info(env: Env, dao_id: u64) -> EpochInfo {
        Self::bump_instance(&env); let epoch = Self::current_epoch_internal(&env, dao_id);
        EpochInfo { epoch, root: Self::epoch_root(env.clone(), dao_id, epoch), advanced_at: Self::epoch_advanced_at(env, dao_id, epoch) }
    }
    pub fn epoch_root_ok(env: Env, dao_id: u64, epoch: u32, root: U256) -> bool {
        Self::bump_instance(&env); let key = DataKey::EpochRoot(dao_id, epoch);
        env.storage().persistent().get::<_, U256>(&key).map(|stored| stored==root).unwrap_or(false)
    }

    pub fn current_root(env: Env, dao_id: u64) -> U256 {
        Self::bump_instance(&env);
        let roots_key = DataKey::Roots(dao_id);
        let roots: Vec<U256> = env.storage().persistent().get(&roots_key).unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));
        Self::bump_persistent(&env, &roots_key); roots.get(roots.len().saturating_sub(1)).unwrap()
    }
    pub fn get_root(env: Env, dao_id: u64) -> U256 { Self::current_root(env, dao_id) }
    pub fn root_ok(env: Env, dao_id: u64, root: U256) -> bool {
        Self::bump_instance(&env);
        let roots_key = DataKey::Roots(dao_id);
        if !env.storage().persistent().has(&roots_key) { return false; }
        let roots: Vec<U256> = env.storage().persistent().get(&roots_key).unwrap(); for i in 0..roots.len() { if roots.get(i).unwrap()==root { return true; } } false
    }
    pub fn root_eligibility(env: Env, dao_id: u64, root: U256, earliest_root_index: u32) -> u32 {
        Self::bump_instance(&env);
        let index_key = DataKey::RootIndex(dao_id, root);
        let root_index: Option<u32> = env.storage().persistent().get(&index_key);
        let Some(root_index) = root_index else { return 1; };
        Self::bump_persistent(&env, &index_key);
        if root_index < earliest_root_index { return 2; }
        if root_index < Self::min_root(env.clone(), dao_id) { return 3; } 0
    }
    pub fn root_idx(env: Env, dao_id: u64, root: U256) -> u32 {
        Self::bump_instance(&env); let key = DataKey::RootIndex(dao_id, root);
        let idx: u32 = env.storage().persistent().get(&key).unwrap_or_else(|| panic_with_error!(&env, TreeError::RootNotFound)); Self::bump_persistent(&env, &key); idx
    }
    pub fn curr_idx(env: Env, dao_id: u64) -> u32 { let current_root = Self::current_root(env.clone(), dao_id); Self::root_idx(env, dao_id, current_root) }
    pub fn get_leaf_index(env: Env, dao_id: u64, commitment: U256) -> u32 {
        Self::bump_instance(&env); let key = DataKey::LeafIndex(dao_id, commitment);
        let idx: u32 = env.storage().persistent().get(&key).unwrap_or_else(|| panic_with_error!(&env, TreeError::MemberNotInTree)); Self::bump_persistent(&env, &key); idx
    }
    pub fn get_tree_info(env: Env, dao_id: u64) -> (u32, u32, U256) {
        Self::bump_instance(&env);
        let depth: u32 = env.storage().persistent().get(&DataKey::TreeDepth(dao_id)).unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));
        let next_index: u32 = env.storage().persistent().get(&DataKey::NextLeafIndex(dao_id)).unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized));
        let root = Self::current_root(env, dao_id); (depth, next_index, root)
    }
    pub fn root_history_len(env: Env, dao_id: u64) -> u32 {
        Self::bump_instance(&env); let roots_key = DataKey::Roots(dao_id);
        let roots: Vec<U256> = env.storage().persistent().get(&roots_key).unwrap_or_else(|| Vec::new(&env)); Self::bump_persistent(&env, &roots_key); roots.len()
    }
    pub fn anonymity_set_size(env: Env, dao_id: u64) -> u32 {
        Self::bump_instance(&env); let next_index: u32 = env.storage().persistent().get(&DataKey::NextLeafIndex(dao_id)).unwrap_or(0);
        let depth_key = DataKey::TreeDepth(dao_id); if !env.storage().persistent().has(&depth_key) { return 0; } Self::bump_persistent(&env, &depth_key); next_index
    }
    pub fn get_merkle_path(env: Env, dao_id: u64, leaf_index: u32) -> (Vec<U256>, Vec<u32>) {
        Self::bump_instance(&env);
        let field = Self::dao_field(&env, dao_id);
        let depth: u32 = env.storage().persistent().get(&DataKey::TreeDepth(dao_id)).unwrap();
        let next_index: u32 = env.storage().persistent().get(&DataKey::NextLeafIndex(dao_id)).unwrap();
        if leaf_index >= next_index { panic_with_error!(&env, TreeError::LeafOutOfBounds); }
        let mut path_elements = Vec::new(&env); let mut path_indices = Vec::new(&env); let mut current_index = leaf_index;
        for level in 0..depth {
            let is_left = current_index % 2 == 0; path_indices.push_back(if is_left { 0 } else { 1 });
            let sibling_index = if is_left { current_index + 1 } else { current_index - 1 };
            let sibling = if level == 0 {
                if sibling_index < next_index {
                    let leaf_key = DataKey::LeafValue(dao_id, sibling_index);
                    match env.storage().persistent().get::<_, U256>(&leaf_key) {
                        Some(raw_leaf) => Self::hash_leaf(&env, &raw_leaf, &field), None => Self::zero_at_level_for_field(&env, level, &field),
                    }
                } else { Self::zero_at_level_for_field(&env, level, &field) }
            } else {
                let node_key = DataKey::NodeHash(dao_id, level, sibling_index);
                env.storage().persistent().get(&node_key).unwrap_or_else(|| Self::zero_at_level_for_field(&env, level, &field))
            };
            path_elements.push_back(sibling); current_index /= 2;
        } (path_elements, path_indices)
    }
    pub fn sbt_contr(env: Env) -> Address { Self::bump_instance(&env); env.storage().instance().get(&SBT_CONTRACT).unwrap_or_else(|| panic_with_error!(&env, TreeError::TreeNotInitialized)) }
    pub fn init_zeros_cache(env: Env) { Self::bump_instance(&env); Self::ensure_zeros_cache(&env); }

    pub fn remove_member(env: Env, dao_id: u64, member: Address, admin: Address) {
        Self::lock(&env); Self::bump_instance(&env); admin.require_auth();
        let sbt_contract: Address = Self::sbt_contr(env.clone());
        let registry: Address = env.invoke_contract(&sbt_contract, &symbol_short!("registry"), soroban_sdk::vec![&env]);
        let dao_admin: Address = env.invoke_contract(&registry, &symbol_short!("get_admin"), soroban_sdk::vec![&env, dao_id.into_val(&env)]);
        if dao_admin != admin { Self::unlock(&env); panic_with_error!(&env, TreeError::NotAdmin); }
        let member_key = DataKey::MemberLeafIndex(dao_id, member.clone());
        let leaf_index: u32 = env.storage().persistent().get(&member_key).unwrap_or_else(|| panic_with_error!(&env, TreeError::MemberNotInTree));
        let commitment: U256 = env.storage().persistent().get(&DataKey::LeafValue(dao_id, leaf_index)).unwrap_or_else(|| panic_with_error!(&env, TreeError::MemberNotInTree));
        if commitment == Self::zero_value(&env) { Self::unlock(&env); panic_with_error!(&env, TreeError::MemberRemoved); }
        let zero = Self::zero_value(&env);
        let (new_root, root_index) = Self::update_leaf(&env, dao_id, leaf_index, zero);
        let min_root_key = DataKey::MinValidRootIdx(dao_id); env.storage().persistent().set(&min_root_key, &root_index); Self::bump_persistent(&env, &min_root_key);
        env.invoke_contract::<()>(&sbt_contract, &symbol_short!("revoke"), soroban_sdk::vec![&env, dao_id.into_val(&env), member.clone().into_val(&env), admin.into_val(&env)]);
        RemovalEvent { dao_id, member, index: leaf_index, new_root, root_index }.publish(&env); Self::unlock(&env);
    }
    pub fn reinstate_member(env: Env, dao_id: u64, member: Address, admin: Address) {
        Self::lock(&env); Self::bump_instance(&env); admin.require_auth();
        let sbt_contract: Address = Self::sbt_contr(env.clone());
        let registry: Address = env.invoke_contract(&sbt_contract, &symbol_short!("registry"), soroban_sdk::vec![&env]);
        let dao_admin: Address = env.invoke_contract(&registry, &symbol_short!("get_admin"), soroban_sdk::vec![&env, dao_id.into_val(&env)]);
        if admin != dao_admin { Self::unlock(&env); panic_with_error!(&env, TreeError::NotAdmin); }
        let leaf_index_key = DataKey::MemberLeafIndex(dao_id, member.clone());
        let leaf_index: u32 = env.storage().persistent().get(&leaf_index_key).unwrap_or_else(|| panic_with_error!(&env, TreeError::MemberNotInTree));
        let current_value: U256 = env.storage().persistent().get(&DataKey::LeafValue(dao_id, leaf_index)).unwrap_or_else(|| panic_with_error!(&env, TreeError::MemberNotInTree));
        if current_value != Self::zero_value(&env) { Self::unlock(&env); panic_with_error!(&env, TreeError::MemberNotRevoked); }
        env.storage().persistent().remove(&leaf_index_key);
        let last_reg_key = DataKey::LastRegistrationAt(dao_id, member.clone()); env.storage().persistent().remove(&last_reg_key);
        let reinstated_at = env.ledger().timestamp();
        ReinstatementEvent { dao_id, member, reinstated_at }.publish(&env); Self::unlock(&env);
    }
    pub fn revok_at(env: Env, dao_id: u64, commitment: U256) -> Option<u64> {
        Self::bump_instance(&env); let key = DataKey::RevokedAt(dao_id, commitment); let result: Option<u64> = env.storage().persistent().get(&key); if result.is_some() { Self::bump_persistent(&env, &key); } result
    }
    pub fn reinst_at(env: Env, dao_id: u64, commitment: U256) -> Option<u64> {
        Self::bump_instance(&env); let key = DataKey::ReinstatedAt(dao_id, commitment); let result: Option<u64> = env.storage().persistent().get(&key); if result.is_some() { Self::bump_persistent(&env, &key); } result
    }
    pub fn min_root(env: Env, dao_id: u64) -> u32 {
        Self::bump_instance(&env); let key = DataKey::MinValidRootIdx(dao_id); let result: u32 = env.storage().persistent().get(&key).unwrap_or(0); if result > 0 { Self::bump_persistent(&env, &key); } result
    }
    pub fn sweep_dao(env: Env, dao_id: u64, start: u64, limit: u32) -> u32 {
        Self::lock(&env); Self::bump_instance(&env);
        let limit = if limit == 0 || limit > SWEEP_MAX_RECORDS { SWEEP_MAX_RECORDS } else { limit };
        for key in [DataKey::TreeDepth(dao_id), DataKey::NextLeafIndex(dao_id), DataKey::NextRootIndex(dao_id), DataKey::Roots(dao_id), DataKey::MaxRoots(dao_id), DataKey::MinValidRootIdx(dao_id), DataKey::Epoch(dao_id)] {
            if env.storage().persistent().has(&key) { Self::bump_persistent(&env, &key); }
        }
        let roots_key = DataKey::Roots(dao_id);
        if let Some(roots) = env.storage().persistent().get::<_, Vec<U256>>(&roots_key) { for r in roots.iter() { let rk = DataKey::RootIndex(dao_id, r); if env.storage().persistent().has(&rk) { Self::bump_persistent(&env, &rk); } } }
        let next_index: u64 = env.storage().persistent().get(&DataKey::NextLeafIndex(dao_id)).unwrap_or(0);
        let end = (start + limit as u64).min(next_index); let mut refreshed = 0u32;
        for i in start..end { let leaf_key = DataKey::LeafValue(dao_id, i as u32); if env.storage().persistent().has(&leaf_key) { Self::bump_persistent(&env, &leaf_key); refreshed+=1; } }
        Self::unlock(&env); refreshed
    }

    // ===== HELPERS (poseidon) =====
    fn assert_valid_field(env: &Env, field: &Symbol) {
        let bn = Symbol::new(env, "BN254"); let bls = Symbol::new(env, "BLS12_381");
        if field != &bn && field != &bls { panic_with_error!(env, TreeError::InvalidField); }
    }
    fn dao_field(env: &Env, dao_id: u64) -> Symbol {
        env.storage().persistent().get(&DataKey::PoseidonField(dao_id)).unwrap_or(Symbol::new(env, "BN254"))
    }
    fn zero_value(env: &Env) -> U256 { U256::from_u32(env, 0) }
    fn zero_at_level_for_field(env: &Env, level: u32, _field: &Symbol) -> U256 {
        if let Some(cache) = env.storage().instance().get::<_, Vec<U256>>(&ZEROS_CACHE) { if (level as usize) < cache.len() as usize { return cache.get(level).unwrap(); } }
        U256::from_u32(env, 0)
    }
    fn hash_leaf(env: &Env, leaf: &U256, _field: &Symbol) -> U256 { 
        let mut b = Bytes::new(env); b.append(&leaf.to_be_bytes()); b.push_back(1);
        let h = env.crypto().keccak256(&b); U256::from_be_bytes(env, &h)
    }
    fn hash_pair(env: &Env, left: &U256, right: &U256, _field: &Symbol) -> U256 {
        let mut b = Bytes::new(env); b.append(&left.to_be_bytes()); b.append(&right.to_be_bytes());
        let h = env.crypto().keccak256(&b); U256::from_be_bytes(env, &h)
    }
    fn ensure_zeros_cache(env: &Env) {
        if env.storage().instance().has(&ZEROS_CACHE) { return; }
        let mut zeros = Vec::new(env); let mut cur = Self::zero_value(env);
        zeros.push_back(cur.clone()); for _ in 0..MAX_TREE_DEPTH { cur = Self::hash_pair(env, &cur, &cur, &Symbol::new(env, "BN254")); zeros.push_back(cur.clone()); }
        env.storage().instance().set(&ZEROS_CACHE, &zeros);
    }
    fn insert_leaf(env: &Env, dao_id: u64, commitment: U256, index: u32, depth: u32) -> (U256, u32) {
        let field = Self::dao_field(env, dao_id);
        let mut filled: Vec<U256> = env.storage().persistent().get(&DataKey::FilledSubtrees(dao_id)).unwrap();
        let mut cur = Self::hash_leaf(env, &commitment, &field);
        let mut idx = index;
        for level in 0..depth {
            if idx % 2 == 0 {
                filled.set(level, cur.clone());
                let zero = Self::zero_at_level_for_field(env, level, &field);
                cur = Self::hash_pair(env, &cur, &zero, &field);
            } else {
                let left = filled.get(level).unwrap();
                cur = Self::hash_pair(env, &left, &cur, &field);
            }
            let node_key = DataKey::NodeHash(dao_id, level, idx); env.storage().persistent().set(&node_key, &cur); Self::bump_persistent(env, &node_key);
            idx /= 2;
        }
        let filled_key = DataKey::FilledSubtrees(dao_id); env.storage().persistent().set(&filled_key, &filled); Self::bump_persistent(env, &filled_key);
        let mut roots: Vec<U256> = env.storage().persistent().get(&DataKey::Roots(dao_id)).unwrap();
        let max_roots = Self::get_max_roots(env, dao_id);
        if roots.len() >= max_roots { Self::check_root_eviction_safety(env, dao_id, &roots.get(0).unwrap()); Self::evict_oldest_root(env, dao_id, &mut roots); }
        let next_root_idx: u32 = env.storage().persistent().get(&DataKey::NextRootIndex(dao_id)).unwrap_or(0);
        roots.push_back(cur.clone());
        let roots_key = DataKey::Roots(dao_id); env.storage().persistent().set(&roots_key, &roots); Self::bump_persistent(env, &roots_key);
        let root_idx_key = DataKey::RootIndex(dao_id, cur.clone()); env.storage().persistent().set(&root_idx_key, &next_root_idx); Self::bump_persistent(env, &root_idx_key);
        env.storage().persistent().set(&DataKey::NextRootIndex(dao_id), &(next_root_idx+1)); Self::bump_persistent(env, &DataKey::NextRootIndex(dao_id));
        (cur, next_root_idx)
    }
    fn update_leaf(env: &Env, dao_id: u64, leaf_index: u32, new_value: U256) -> (U256, u32) {
        let field = Self::dao_field(env, dao_id);
        let depth: u32 = env.storage().persistent().get(&DataKey::TreeDepth(dao_id)).unwrap();
        let leaf_key = DataKey::LeafValue(dao_id, leaf_index); env.storage().persistent().set(&leaf_key, &new_value); Self::bump_persistent(env, &leaf_key);
        let mut cur = if new_value == Self::zero_value(env) { Self::zero_at_level_for_field(env, 0, &field) } else { Self::hash_leaf(env, &new_value, &field) };
        let mut idx = leaf_index;
        for level in 0..depth {
            let node_key = DataKey::NodeHash(dao_id, level, idx); env.storage().persistent().set(&node_key, &cur.clone()); Self::bump_persistent(env, &node_key);
            let sibling_idx = if idx % 2 == 0 { idx+1 } else { idx-1 };
            let sibling_key = DataKey::NodeHash(dao_id, level, sibling_idx);
            let sibling: U256 = env.storage().persistent().get(&sibling_key).unwrap_or_else(|| Self::zero_at_level_for_field(env, level, &field));
            cur = if idx % 2 == 0 { Self::hash_pair(env, &cur, &sibling, &field) } else { Self::hash_pair(env, &sibling, &cur, &field) };
            idx /= 2;
        }
        let mut roots: Vec<U256> = env.storage().persistent().get(&DataKey::Roots(dao_id)).unwrap();
        let max_roots = Self::get_max_roots(env, dao_id);
        if roots.len() >= max_roots { Self::check_root_eviction_safety(env, dao_id, &roots.get(0).unwrap()); Self::evict_oldest_root(env, dao_id, &mut roots); }
        let next_root_idx: u32 = env.storage().persistent().get(&DataKey::NextRootIndex(dao_id)).unwrap_or(0);
        roots.push_back(cur.clone());
        let roots_key = DataKey::Roots(dao_id); env.storage().persistent().set(&roots_key, &roots); Self::bump_persistent(env, &roots_key);
        let root_idx_key = DataKey::RootIndex(dao_id, cur.clone()); env.storage().persistent().set(&root_idx_key, &next_root_idx); Self::bump_persistent(env, &root_idx_key);
        env.storage().persistent().set(&DataKey::NextRootIndex(dao_id), &(next_root_idx+1)); Self::bump_persistent(env, &DataKey::NextRootIndex(dao_id));
        (cur, next_root_idx)
    }
}
