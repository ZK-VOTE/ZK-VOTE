#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, crypto::bn254::Bn254G1Affine,
    panic_with_error, symbol_short, Address, Env, Symbol, Vec, U256,
};

const ADMIN_KEY: Symbol = symbol_short!("admin");
const CONFIG_KEY: Symbol = symbol_short!("cfg");
const FINALIZED_KEY: Symbol = symbol_short!("fini");
const VERSION: u32 = 1;
const VERSION_KEY: Symbol = symbol_short!("ver");

const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 535_680;
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum ThresholdError {
    AlreadyInitialized = 1,
    NotAdmin = 2,
    InvalidThreshold = 3,
    InvalidTotal = 4,
    AlreadyFinalized = 5,
    NotParticipant = 6,
    AlreadySubmitted = 7,
    InsufficientShares = 8,
    DkgNotReady = 9,
    InvalidShare = 10,
    ParticipantExists = 11,
    TooManyParticipants = 12,
    NotInitialized = 13,
    /// Privacy analytics not configured via `init_analytics`
    AnalyticsNotConfigured = 14,
    /// Submitted ciphertext below the configured minimum cohort size cannot be decrypted
    AnalyticsBelowMinCohort = 15,
    /// Invalid minimum cohort (must be >= 1)
    InvalidCohort = 16,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DkgConfig {
    pub admin: Address,
    pub threshold: u32,
    pub total: u32,
    pub finalized: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Participant(Address),
    ParticipantList, // Vec<Address>
    Share(Address),  // U256 share per participant
    ShareCount,      // u32
    FinalKey,        // U256 aggregated key
}

#[contract]
pub struct ThresholdCrypto;

#[contractimpl]
impl ThresholdCrypto {
    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }
    fn bump_persistent<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }

    /// Initialize DKG with admin, threshold t and total n
    pub fn initialize(env: Env, admin: Address, threshold: u32, total: u32) {
        if env.storage().instance().has(&CONFIG_KEY) {
            panic_with_error!(&env, ThresholdError::AlreadyInitialized);
        }
        admin.require_auth();
        if total == 0 || total > 20 {
            panic_with_error!(&env, ThresholdError::InvalidTotal);
        }
        if threshold == 0 || threshold > total {
            panic_with_error!(&env, ThresholdError::InvalidThreshold);
        }

        let cfg = DkgConfig {
            admin: admin.clone(),
            threshold,
            total,
            finalized: false,
        };
        env.storage().instance().set(&CONFIG_KEY, &cfg);
        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&VERSION_KEY, &VERSION);
        env.storage()
            .persistent()
            .set(&DataKey::ParticipantList, &Vec::<Address>::new(&env));
        env.storage().persistent().set(&DataKey::ShareCount, &0u32);
        env.storage().instance().set(&FINALIZED_KEY, &false);
        Self::bump_instance(&env);
    }

    /// Add participant (admin only)
    pub fn add_participant(env: Env, participant: Address) {
        Self::bump_instance(&env);
        let cfg: DkgConfig = env
            .storage()
            .instance()
            .get(&CONFIG_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::NotInitialized));
        let admin: Address = env.storage().instance().get(&ADMIN_KEY).unwrap();
        admin.require_auth();
        if cfg.admin != admin {
            panic_with_error!(&env, ThresholdError::NotAdmin);
        }
        if cfg.finalized {
            panic_with_error!(&env, ThresholdError::AlreadyFinalized);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::Participant(participant.clone()))
        {
            panic_with_error!(&env, ThresholdError::ParticipantExists);
        }
        let mut list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::ParticipantList)
            .unwrap_or(Vec::new(&env));
        if list.len() >= cfg.total {
            panic_with_error!(&env, ThresholdError::TooManyParticipants);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Participant(participant.clone()), &true);
        Self::bump_persistent(&env, &DataKey::Participant(participant.clone()));
        list.push_back(participant);
        env.storage()
            .persistent()
            .set(&DataKey::ParticipantList, &list);
    }

    /// Submit share (participant only)
    pub fn submit_share(env: Env, participant: Address, share: U256) {
        Self::bump_instance(&env);
        participant.require_auth();
        let cfg: DkgConfig = env
            .storage()
            .instance()
            .get(&CONFIG_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::NotInitialized));
        if cfg.finalized {
            panic_with_error!(&env, ThresholdError::AlreadyFinalized);
        }
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Participant(participant.clone()))
        {
            panic_with_error!(&env, ThresholdError::NotParticipant);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::Share(participant.clone()))
        {
            panic_with_error!(&env, ThresholdError::AlreadySubmitted);
        }
        if share == U256::from_u32(&env, 0) {
            panic_with_error!(&env, ThresholdError::InvalidShare);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Share(participant.clone()), &share);
        Self::bump_persistent(&env, &DataKey::Share(participant.clone()));
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::ShareCount)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::ShareCount, &(count + 1));
    }

    /// Finalize DKG (admin only) - requires threshold shares
    pub fn finalize_dkg(env: Env) -> U256 {
        Self::bump_instance(&env);
        let mut cfg: DkgConfig = env
            .storage()
            .instance()
            .get(&CONFIG_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::NotInitialized));
        let admin: Address = env.storage().instance().get(&ADMIN_KEY).unwrap();
        admin.require_auth();
        if cfg.admin != admin {
            panic_with_error!(&env, ThresholdError::NotAdmin);
        }
        if cfg.finalized {
            panic_with_error!(&env, ThresholdError::AlreadyFinalized);
        }
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::ShareCount)
            .unwrap_or(0);
        if count < cfg.threshold {
            panic_with_error!(&env, ThresholdError::InsufficientShares);
        }
        // Aggregate shares: simple addition for demo (wrapping)
        let participants: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::ParticipantList)
            .unwrap_or(Vec::new(&env));
        let mut agg = U256::from_u32(&env, 0);
        for i in 0..participants.len() {
            let addr = participants.get(i).unwrap();
            if let Some(s) = env
                .storage()
                .persistent()
                .get::<DataKey, U256>(&DataKey::Share(addr))
            {
                agg = agg.add(&s);
            }
        }
        // Ensure non-zero final key
        if agg == U256::from_u32(&env, 0) {
            agg = U256::from_u32(&env, 1);
        }
        env.storage().persistent().set(&DataKey::FinalKey, &agg);
        Self::bump_persistent(&env, &DataKey::FinalKey);
        cfg.finalized = true;
        env.storage().instance().set(&CONFIG_KEY, &cfg);
        env.storage().instance().set(&FINALIZED_KEY, &true);
        agg
    }

    // ===== Views =====

    pub fn get_config(env: Env) -> DkgConfig {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&CONFIG_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::NotInitialized))
    }

    pub fn get_share(env: Env, participant: Address) -> U256 {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::Share(participant))
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::NotParticipant))
    }

    pub fn get_participant_count(env: Env) -> u32 {
        Self::bump_instance(&env);
        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::ParticipantList)
            .unwrap_or(Vec::new(&env));
        list.len()
    }

    pub fn get_share_count(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::ShareCount)
            .unwrap_or(0)
    }

    pub fn is_finalized(env: Env) -> bool {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&FINALIZED_KEY)
            .unwrap_or(false)
    }

    pub fn get_final_key(env: Env) -> U256 {
        Self::bump_instance(&env);
        if !Self::is_finalized(env.clone()) {
            panic_with_error!(&env, ThresholdError::DkgNotReady);
        }
        env.storage()
            .persistent()
            .get(&DataKey::FinalKey)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::DkgNotReady))
    }

    pub fn version(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&VERSION_KEY)
            .unwrap_or(VERSION)
    }
}

#[cfg(test)]
mod test;
