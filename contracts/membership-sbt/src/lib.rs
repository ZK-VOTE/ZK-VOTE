#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, Symbol};

const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 6_312_000;
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 6_312_000;

#[contracttype] #[derive(Clone)]
pub enum DataKey {
    Member(u64, Address), Alias(u64, Address), Revoked(u64, Address),
    MemberCount(u64), MemberAtIndex(u64, u64),
    TransferCooldown(u64, Address), InActiveElection(u64, Address),
    ReentrancyLock, Admin(u64), Registry,
}

#[contracterror] #[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum SbtError { NotAdmin=1, AlreadyMember=2, NotMember=3, CooldownActive=5, InElection=6, AlreadyInitialized=7, ReentrantCall=20, }

#[contract] pub struct MembershipSbt;

#[contractimpl]
impl MembershipSbt {
    fn bump_instance(env: &Env) { env.storage().instance().extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND); }
    fn lock(env: &Env) {
        if env.storage().instance().has(&DataKey::ReentrancyLock) { panic_with_error!(env, SbtError::ReentrantCall); }
        env.storage().instance().set(&DataKey::ReentrancyLock, &true);
    }
    fn unlock(env: &Env) { env.storage().instance().remove(&DataKey::ReentrancyLock); }
    fn bump_persistent<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
        env.storage().persistent().extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }
    fn is_admin(env: &Env, dao_id: u64, caller: &Address) -> bool {
        env.storage().instance().get::<DataKey, Address>(&DataKey::Admin(dao_id)).map(|a| &a==caller).unwrap_or(false)
    }

    pub fn __constructor(env: Env, registry: Address) {
        if env.storage().instance().has(&DataKey::Registry) { panic_with_error!(&env, SbtError::AlreadyInitialized); }
        env.storage().instance().set(&DataKey::Registry, &registry);
    }
    pub fn initialize(env: Env, dao_id: u64, admin: Address) {
        Self::bump_instance(&env);
        if env.storage().instance().has(&DataKey::Admin(dao_id)) { panic_with_error!(&env, SbtError::AlreadyInitialized); }
        env.storage().instance().set(&DataKey::Admin(dao_id), &admin);
        env.storage().instance().set(&DataKey::MemberCount(dao_id), &0u64);
    }
    pub fn init_from_registry(env: Env, dao_id: u64, admin: Address) {
        Self::bump_instance(&env);
        let reg: Address = env.storage().instance().get(&DataKey::Registry).unwrap();
        reg.require_auth();
        if env.storage().instance().has(&DataKey::Admin(dao_id)) { return; }
        env.storage().instance().set(&DataKey::Admin(dao_id), &admin);
        env.storage().instance().set(&DataKey::MemberCount(dao_id), &0u64);
    }
    pub fn mint(env: Env, dao_id: u64, member: Address, alias: Symbol, admin: Address) {
        Self::lock(&env); admin.require_auth(); Self::bump_instance(&env);
        if !Self::is_admin(&env, dao_id, &admin) { Self::unlock(&env); panic_with_error!(&env, SbtError::NotAdmin); }
        let key = DataKey::Member(dao_id, member.clone());
        if env.storage().persistent().has(&key) { Self::unlock(&env); panic_with_error!(&env, SbtError::AlreadyMember); }
        if let Some(end) = env.storage().persistent().get::<DataKey, u64>(&DataKey::TransferCooldown(dao_id, member.clone())) {
            if env.ledger().timestamp() < end { Self::unlock(&env); panic_with_error!(&env, SbtError::CooldownActive); }
        }
        env.storage().persistent().set(&key, &true);
        env.storage().persistent().set(&DataKey::Alias(dao_id, member.clone()), &alias);
        env.storage().persistent().set(&DataKey::Revoked(dao_id, member.clone()), &false);
        let count: u64 = env.storage().instance().get(&DataKey::MemberCount(dao_id)).unwrap_or(0);
        env.storage().persistent().set(&DataKey::MemberAtIndex(dao_id, count), &member);
        env.storage().instance().set(&DataKey::MemberCount(dao_id), &(count+1));
        Self::bump_persistent(&env, &key); Self::unlock(&env);
    }
    pub fn burn(env: Env, dao_id: u64, member: Address, admin: Address) {
        Self::lock(&env); admin.require_auth(); Self::bump_instance(&env);
        if !Self::is_admin(&env, dao_id, &admin) { Self::unlock(&env); panic_with_error!(&env, SbtError::NotAdmin); }
        let key = DataKey::Member(dao_id, member.clone());
        if !env.storage().persistent().has(&key) { Self::unlock(&env); panic_with_error!(&env, SbtError::NotMember); }
        if let Some(true) = env.storage().persistent().get::<DataKey, bool>(&DataKey::InActiveElection(dao_id, member.clone())) {
            Self::unlock(&env); panic_with_error!(&env, SbtError::InElection);
        }
        env.storage().persistent().remove(&key);
        env.storage().persistent().set(&DataKey::Revoked(dao_id, member.clone()), &true);
        env.storage().persistent().set(&DataKey::TransferCooldown(dao_id, member.clone()), &(env.ledger().timestamp()+86400));
        Self::unlock(&env);
    }
    pub fn has(env: Env, dao_id: u64, member: Address) -> bool {
        Self::bump_instance(&env); env.storage().persistent().has(&DataKey::Member(dao_id, member))
    }
    pub fn registry(env: Env) -> Address {
        Self::bump_instance(&env); env.storage().instance().get(&DataKey::Registry).unwrap()
    }
    pub fn get_admin(env: Env, dao_id: u64) -> Address {
        Self::bump_instance(&env); env.storage().instance().get(&DataKey::Admin(dao_id)).unwrap()
    }
    pub fn member_count(env: Env, dao_id: u64) -> u64 {
        Self::bump_instance(&env); env.storage().instance().get(&DataKey::MemberCount(dao_id)).unwrap_or(0)
    }
    pub fn get_member_at(env: Env, dao_id: u64, index: u64) -> Option<Address> {
        Self::bump_instance(&env); env.storage().persistent().get(&DataKey::MemberAtIndex(dao_id, index))
    }
}
