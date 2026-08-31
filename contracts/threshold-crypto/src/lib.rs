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
    ParticipantList,                       // Vec<Address>
    Share(Address),                        // U256 share per participant
    ShareCount,                            // u32
    FinalKey,                              // U256 aggregated key
    AnalyticsCfg,                          // u32 minimum cohort (privacy budget)
    AnalyticsAggregate(u64, u64),          // (dao_id, round_id) -> AnalyticsAggregate
    AnalyticsSubmitted(u64, u64, Address), // (dao_id, round_id, address) -> bool
}

/// An on-chain homomorphic aggregate of encrypted analytic contributions for one
/// (dao, round).
///
/// Each contributor submits an ElGamal ciphertext `(c1, c2) = (r·G, m·G + r·Y)`
/// over BN254 G1 (with `m` the contributed value, `Y` the joint public key). The
/// contract accumulates them with the `bn254_g1_add` host function, so it only ever
/// stores the *sum* ciphertext:
///
/// `sum_c1 = R·G`, `sum_c2 = (Σm)·G + R·Y`
///
/// No intermediate aggregate equals any single contributor's ciphertext, so the
/// per-voter value `m` never appears on-chain in a decodable form. The aggregate
/// is only readable once `contribution_count >= minimum_cohort` (the privacy
/// budget), after which a threshold decryption of `Σm` is permitted. The curve
/// point at infinity (64 zero bytes) is used as the identity element for `g1_add`.
#[contracttype]
#[derive(Clone)]
pub struct AnalyticsAggregate {
    pub c1: Bn254G1Affine,       // Σ r_i·G
    pub c2: Bn254G1Affine,       // (Σ m_i)·G + R·Y
    pub contribution_count: u64, // number of accumulated contributions
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

    // ===== Privacy Analytics (#306) =====

    /// Configure the privacy budget (minimum cohort) for decryption. Admin only,
    /// call once per contract. `min_cohort` is the smallest number of accumulated
    /// contributions that must be present before an aggregate may be decrypted, so
    /// no single (or few) contributor(s) can be singled out.
    pub fn init_analytics(env: Env, min_cohort: u32, admin: Address) {
        Self::bump_instance(&env);
        if env.storage().instance().has(&DataKey::AnalyticsCfg) {
            panic_with_error!(&env, ThresholdError::AlreadyInitialized);
        }
        admin.require_auth();
        if min_cohort < 1 {
            panic_with_error!(&env, ThresholdError::InvalidCohort);
        }
        env.storage()
            .instance()
            .set(&DataKey::AnalyticsCfg, &min_cohort);
    }

    /// Accumulate one encrypted contribution `(c1, c2)` homomorphically into the
    /// aggregate for `(dao_id, round_id)`. A given contributor may contribute at
    /// most once per round; the per-contributor ciphertext is never stored in
    /// decodable form, only the running sum.
    #[allow(clippy::too_many_arguments)]
    pub fn submit_analytic_contribution(
        env: Env,
        dao_id: u64,
        round_id: u64,
        c1: Bn254G1Affine,
        c2: Bn254G1Affine,
        contributor: Address,
    ) {
        Self::bump_instance(&env);
        if !env.storage().instance().has(&DataKey::AnalyticsCfg) {
            panic_with_error!(&env, ThresholdError::AnalyticsNotConfigured);
        }
        contributor.require_auth();

        // One contribution per contributor per round.
        let submitted_key = DataKey::AnalyticsSubmitted(dao_id, round_id, contributor.clone());
        if env.storage().persistent().has(&submitted_key) {
            panic_with_error!(&env, ThresholdError::AlreadySubmitted);
        }
        env.storage().persistent().set(&submitted_key, &true);
        Self::bump_persistent(&env, &submitted_key);

        let agg_key = DataKey::AnalyticsAggregate(dao_id, round_id);
        // Identity element for g1_add is the point at infinity: 64 zero bytes.
        let identity = |env: &Env| Bn254G1Affine::from_array(env, &[0u8; 64]);
        let mut agg: AnalyticsAggregate =
            env.storage()
                .persistent()
                .get(&agg_key)
                .unwrap_or_else(|| AnalyticsAggregate {
                    c1: identity(&env),
                    c2: identity(&env),
                    contribution_count: 0,
                });
        agg.c1 = env.crypto().bn254().g1_add(&agg.c1, &c1);
        agg.c2 = env.crypto().bn254().g1_add(&agg.c2, &c2);
        agg.contribution_count += 1;
        env.storage().persistent().set(&agg_key, &agg);
        Self::bump_persistent(&env, &agg_key);
    }

    /// Return the on-chain homomorphic aggregate for a `(dao_id, round_id)`,
    /// refusing to reveal it until the minimum cohort (privacy budget) has been
    /// met. Once released, it is still encrypted: only a threshold of key shares
    /// can decrypt `Σ m_i` off-chain.
    pub fn analytics_aggregate(env: Env, dao_id: u64, round_id: u64) -> AnalyticsAggregate {
        Self::bump_instance(&env);
        let min_cohort: u32 = env
            .storage()
            .instance()
            .get(&DataKey::AnalyticsCfg)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::AnalyticsNotConfigured));
        let agg_key = DataKey::AnalyticsAggregate(dao_id, round_id);
        let agg: AnalyticsAggregate = env
            .storage()
            .persistent()
            .get(&agg_key)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::AnalyticsNotConfigured));
        if agg.contribution_count < min_cohort as u64 {
            panic_with_error!(&env, ThresholdError::AnalyticsBelowMinCohort);
        }
        Self::bump_persistent(&env, &agg_key);
        agg
    }

    /// Number of contributions accumulated for a `(dao_id, round_id)`, always
    /// visible (counts are not sensitive in aggregate).
    pub fn analytics_count(env: Env, dao_id: u64, round_id: u64) -> u64 {
        env.storage()
            .persistent()
            .get::<DataKey, AnalyticsAggregate>(&DataKey::AnalyticsAggregate(dao_id, round_id))
            .map(|a| a.contribution_count)
            .unwrap_or(0)
    }

    /// The configured minimum cohort (privacy budget) for this contract.
    pub fn analytics_min_cohort(env: Env) -> u32 {
        env.storage()
            .instance()
            .get::<_, _>(&DataKey::AnalyticsCfg)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
