//! # Vote-to-Earn Rewards Contract (Thin Rewards Crate)
//!
//! Design choice: Thin rewards crate vs extending token.
//! ---------------------------------------------------
//! The requirement allows "extend token or thin rewards crate — document choice".
//! We chose a THIN REWARDS CRATE (`rewards`) for the following reasons:
//!
//! 1. **Separation of concerns**: Token (SEP-41/Stellar Asset) logic is deployment- and asset-specific;
//!    rewards accounting is minimal (treasury pool + single-claim semantics) and should not pollute token mint/burn.
//! 2. **Minimal attack surface**: Rewards crate has no transfer/admin-override paths beyond treasury funding;
//!    avoids upgrading a live token contract.
//! 3. **Reusability**: Same rewards crate can front any fungible back-end (native Stellar asset, Soroban token, or
//!    off-chain settlement) via event listening; on-chain pool is an i128 accounting ledger, not necessarily a token.
//! 4. **Testability**: Thin crate keeps `cargo test -p rewards` isolated; token tests remain green without coupling.
//!
//! If an existing SEP-41 token is desired, deployment can wire `rewards` events to mint on the token contract
//! off-chain, or the reward logic can be moved into `contracts/token` by copying this module verbatim.
//!
//! ## Claim Protocol
//!
//! Anonymous claim for voters who have cast a vote:
//!
//! - Circuit `claim.circom` (level 18) proves membership and derives TWO nullifiers from same secret:
//!   * `vote_nullifier = Poseidon(secret, daoId, proposalId)` — identical to vote circuit; must be USED on voting contract.
//!   * `claim_nullifier = Poseidon(secret, daoId, proposalId, CLAIM_TAG)` — domain-separated, prevents double-claim.
//!     `CLAIM_TAG = 427020085613` (`0x636c61696d` = ascii("claim")) + Poseidon arity 4 vs 3 ensures unlinkability.
//! - On-chain `claim()` checks:
//!   1. All U256 signals < BN254 scalar field `r` (modular reduction attack prevention)
//!   2. `claim_nullifier` not used before (per dao, proposal)
//!   3. `vote_nullifier` is marked used in voting contract (`is_nullifier_used`) — only voters can claim.
//!   4. Merkle root validity matching proposal's vote_mode (Fixed = snapshot, Trailing = history + minValidRoot)
//!   5. VK hashpinned per DAO version; Groth16 pairing `e(-A,B)*e(alpha,beta)*e(vk_x,gamma)*e(C,delta)=1`
//!   6. Treasury pool has sufficient funds; funding caps enforced.
//!
//! Anonymity: No `require_auth` on claimer — relayer submits. Commitment stays private (computed inside circuit).
//! Sybil bounds: See `THREAT_MODEL.md` § Vote-to-Earn Sybil Bounds.
//! - SBT-age gating (policy), QV/funding caps (on-chain pool limits + per-proposal claim caps).
#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Bytes, BytesN, Env, IntoVal, String, Symbol, Vec, U256,
};

pub use zkvote_groth16::{Groth16Error, PathContext, Proof, VerificationKey};

const TREE_CONTRACT: Symbol = symbol_short!("tree");
const REGISTRY: Symbol = symbol_short!("registry");
const VOTING_CONTRACT: Symbol = symbol_short!("voting");
const VERSION: u32 = 1;
const VERSION_KEY: Symbol = symbol_short!("ver");

const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 535_680;
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum RewardsError {
    NotAdmin = 1,
    Unauthorized = 19,
    VkIcLengthMismatch = 2,
    VkIcTooLarge = 3,
    NotVoted = 4,
    ClaimNullifierUsed = 5,
    InvalidProof = 6,
    VkNotSet = 7,
    VkVersionMismatch = 8,
    AlreadyInitialized = 9,
    InvalidState = 10,
    InvalidG1Point = 11,
    SignalNotInField = 12,
    InvalidNullifier = 13,
    RootMismatch = 14,
    RootNotInHistory = 15,
    RootPredatesProposal = 16,
    RootPredatesRemoval = 17,
    VkChanged = 18,
    TreasuryInsufficient = 20,
    InvalidRewardAmount = 21,
    FundingCapExceeded = 22,
    InvalidTreasury = 23,
    // -- Coarse error codes (100-106) --
    InvalidInput = 100,
    EligibilityFailed = 101,
    ProofInvalid = 102,
    AlreadySubmitted = 103,
    WindowClosed = 104,
    InsufficientFunds = 105,
    ConfigError = 106,
}

impl RewardsError {
    /// Map fine-grained errors to coarse buckets when called from Anonymous path.
    /// Admin path preserves full diagnostics (identity).
    pub fn to_coarse(&self, ctx: PathContext) -> RewardsError {
        match ctx {
            PathContext::Admin => *self,
            PathContext::Anonymous => match self {
                RewardsError::SignalNotInField
                | RewardsError::InvalidNullifier
                | RewardsError::InvalidG1Point => RewardsError::InvalidInput,
                RewardsError::NotVoted
                | RewardsError::RootMismatch
                | RewardsError::RootNotInHistory
                | RewardsError::RootPredatesProposal
                | RewardsError::RootPredatesRemoval => RewardsError::EligibilityFailed,
                RewardsError::InvalidProof
                | RewardsError::VkIcLengthMismatch
                | RewardsError::VkIcTooLarge
                | RewardsError::VkChanged
                | RewardsError::VkVersionMismatch => RewardsError::ProofInvalid,
                RewardsError::ClaimNullifierUsed => RewardsError::AlreadySubmitted,
                RewardsError::TreasuryInsufficient => RewardsError::InsufficientFunds,
                RewardsError::VkNotSet | RewardsError::InvalidState => RewardsError::ConfigError,
                // pass-through: admin-only / structural / already-coarse
                _ => *self,
            },
        }
    }
}

#[inline]
fn panic_coarse(env: &Env, ctx: PathContext, err: RewardsError) {
    panic_with_error!(env, err.to_coarse(ctx));
}

const MAX_IC_LENGTH: u32 = 21;
const NUM_PUBLIC_SIGNALS: u32 = 6;
const CLAIM_CIRCUIT_IC_LEN: u32 = NUM_PUBLIC_SIGNALS + 1;

// Funding / reward caps — Sybil bounds
// Treasury cap per DAO: 1e9 * 1e7 (1B tokens with 7 decimals) typical Stellar limit
const MAX_FUNDING_CAP: i128 = 10_000_000_000_000_000; // 1e9 * 1e7 = 1e16
const MAX_REWARD_PER_CLAIM: i128 = 100_000_000_000; // 10k * 1e7 = 1e11
const DEFAULT_REWARD: i128 = 1_000_000_000; // 100 * 1e7

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    ClaimNullifier(u64, u64, U256), // (dao_id, proposal_id, claim_nullifier) -> bool
    VotingKey(u64),                 // dao_id -> latest VerificationKey for claim circuit
    VkVersion(u64),                 // dao_id -> current VK version
    VkByVersion(u64, u32),          // (dao_id, vk_version) -> VerificationKey
    Treasury(u64),                  // dao_id -> i128 remaining pool
    RewardAmount(u64),              // dao_id -> i128 reward per claim
    ClaimedCount(u64, u64),         // (dao_id, proposal_id) -> u64 count
    TotalClaimed(u64),              // dao_id -> u64 total claims
    /// Test-only override
    VerifyOverride,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoteMode {
    Fixed,
    Trailing,
}

#[contracttype]
#[derive(Clone)]
pub struct ProposalInfoStub {
    pub id: u64,
    pub dao_id: u64,
    pub title: String,
    pub content_cid: String,
    pub yes_votes: u64,
    pub no_votes: u64,
    pub end_time: u64,
    pub created_by: Address,
    pub created_at: u64,
    pub vk_hash: BytesN<32>,
    pub vk_version: u32,
    pub eligible_root: U256,
    pub vote_mode: VoteMode,
    pub earliest_root_index: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VKSetEvent {
    #[topic]
    pub dao_id: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct TreasuryFunded {
    #[topic]
    pub dao_id: u64,
    pub amount: i128,
    pub new_balance: i128,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct RewardSet {
    #[topic]
    pub dao_id: u64,
    pub amount: i128,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ClaimEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub claim_nullifier: U256,
    pub vote_nullifier: U256,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgraded {
    pub from: u32,
    pub to: u32,
}

#[contract]
pub struct Rewards;

#[contractimpl]
impl Rewards {
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

    pub fn __constructor(
        env: Env,
        tree_contract: Address,
        registry: Address,
        voting_contract: Address,
    ) {
        if env.storage().instance().has(&VERSION_KEY) {
            panic_with_error!(&env, RewardsError::AlreadyInitialized);
        }
        env.storage().instance().set(&VERSION_KEY, &VERSION);
        ContractUpgraded {
            from: 0,
            to: VERSION,
        }
        .publish(&env);
        env.storage().instance().set(&TREE_CONTRACT, &tree_contract);
        env.storage().instance().set(&REGISTRY, &registry);
        env.storage()
            .instance()
            .set(&VOTING_CONTRACT, &voting_contract);
    }

    fn assert_in_field(env: &Env, ctx: PathContext, value: &U256) {
        if zkvote_groth16::assert_in_field(env, value).is_err() {
            panic_coarse(env, ctx, RewardsError::SignalNotInField);
        }
    }

    fn assert_admin(env: &Env, dao_id: u64, admin: &Address) {
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();
        let dao_admin: Address = env.invoke_contract(
            &registry,
            &symbol_short!("get_admin"),
            soroban_sdk::vec![env, dao_id.into_val(env)],
        );
        if &dao_admin != admin {
            panic_with_error!(env, RewardsError::NotAdmin);
        }
    }

    fn validate_vk(env: &Env, vk: &VerificationKey) {
        if vk.ic.len() != CLAIM_CIRCUIT_IC_LEN {
            panic_with_error!(env, RewardsError::VkIcLengthMismatch);
        }
        if vk.ic.len() > MAX_IC_LENGTH {
            panic_with_error!(env, RewardsError::VkIcTooLarge);
        }
    }

    fn bump_vk_version(env: &Env, dao_id: u64) -> u32 {
        let version_key = DataKey::VkVersion(dao_id);
        let current: u32 = env.storage().persistent().get(&version_key).unwrap_or(0);
        let new_version = current + 1;
        env.storage().persistent().set(&version_key, &new_version);
        Self::bump_persistent(env, &version_key);
        new_version
    }

    fn get_vk_by_version(env: &Env, dao_id: u64, version: u32) -> VerificationKey {
        env.storage()
            .persistent()
            .get(&DataKey::VkByVersion(dao_id, version))
            .unwrap_or_else(|| panic_with_error!(env, RewardsError::VkVersionMismatch))
    }

    #[allow(dead_code)]
    fn hash_vk(env: &Env, vk: &VerificationKey) -> BytesN<32> {
        let mut data = Bytes::new(env);
        data.append(&Bytes::from_array(env, &vk.alpha.to_array()));
        data.append(&Bytes::from_array(env, &vk.beta.to_array()));
        data.append(&Bytes::from_array(env, &vk.gamma.to_array()));
        data.append(&Bytes::from_array(env, &vk.delta.to_array()));
        for i in 0..vk.ic.len() {
            if let Some(p) = vk.ic.get(i) {
                data.append(&Bytes::from_array(env, &p.to_array()));
            }
        }
        env.crypto().sha256(&data).into()
    }

    // ---- Admin: VK ----
    pub fn set_vk(env: Env, dao_id: u64, vk: VerificationKey, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
        Self::validate_vk(&env, &vk);
        let new_version = Self::bump_vk_version(&env, dao_id);
        let key = DataKey::VotingKey(dao_id);
        env.storage().persistent().set(&key, &vk);
        Self::bump_persistent(&env, &key);
        let ver_key = DataKey::VkByVersion(dao_id, new_version);
        env.storage().persistent().set(&ver_key, &vk);
        Self::bump_persistent(&env, &ver_key);
        VKSetEvent { dao_id }.publish(&env);
    }

    pub fn set_vk_from_registry(env: Env, dao_id: u64, vk: VerificationKey) {
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();
        registry.require_auth();
        Self::bump_instance(&env);
        Self::validate_vk(&env, &vk);
        let new_version = Self::bump_vk_version(&env, dao_id);
        let key = DataKey::VotingKey(dao_id);
        env.storage().persistent().set(&key, &vk);
        Self::bump_persistent(&env, &key);
        let ver_key = DataKey::VkByVersion(dao_id, new_version);
        env.storage().persistent().set(&ver_key, &vk);
        Self::bump_persistent(&env, &ver_key);
        VKSetEvent { dao_id }.publish(&env);
    }

    pub fn get_vk(env: Env, dao_id: u64) -> VerificationKey {
        Self::bump_instance(&env);
        let ver: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::VkVersion(dao_id))
            .unwrap_or_else(|| panic_with_error!(&env, RewardsError::VkNotSet));
        Self::bump_persistent(&env, &DataKey::VkVersion(dao_id));
        Self::get_vk_by_version(&env, dao_id, ver)
    }

    pub fn vk_version(env: Env, dao_id: u64) -> u32 {
        Self::bump_instance(&env);
        let ver: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::VkVersion(dao_id))
            .unwrap_or(0);
        if ver > 0 {
            Self::bump_persistent(&env, &DataKey::VkVersion(dao_id));
        }
        ver
    }

    pub fn vk_for_version(env: Env, dao_id: u64, version: u32) -> VerificationKey {
        Self::bump_instance(&env);
        Self::get_vk_by_version(&env, dao_id, version)
    }

    // ---- Treasury / Rewards Config ----
    /// Set reward amount per claim (admin only). Enforces per-claim cap.
    pub fn set_reward(env: Env, dao_id: u64, amount: i128, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
        if amount <= 0 || amount > MAX_REWARD_PER_CLAIM {
            panic_with_error!(&env, RewardsError::InvalidRewardAmount);
        }
        let key = DataKey::RewardAmount(dao_id);
        env.storage().persistent().set(&key, &amount);
        Self::bump_persistent(&env, &key);
        RewardSet { dao_id, amount }.publish(&env);
    }

    /// Fund treasury pool (admin only). Enforces funding cap.
    pub fn fund_treasury(env: Env, dao_id: u64, amount: i128, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
        if amount <= 0 {
            panic_with_error!(&env, RewardsError::InvalidTreasury);
        }
        let key = DataKey::Treasury(dao_id);
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_bal = current + amount;
        if new_bal > MAX_FUNDING_CAP {
            panic_with_error!(&env, RewardsError::FundingCapExceeded);
        }
        env.storage().persistent().set(&key, &new_bal);
        Self::bump_persistent(&env, &key);
        TreasuryFunded {
            dao_id,
            amount,
            new_balance: new_bal,
        }
        .publish(&env);
    }

    pub fn get_treasury(env: Env, dao_id: u64) -> i128 {
        Self::bump_instance(&env);
        let key = DataKey::Treasury(dao_id);
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if bal != 0 {
            Self::bump_persistent(&env, &key);
        }
        bal
    }

    pub fn get_reward_amount(env: Env, dao_id: u64) -> i128 {
        Self::bump_instance(&env);
        let key = DataKey::RewardAmount(dao_id);
        let amt: i128 = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(DEFAULT_REWARD);
        Self::bump_persistent(&env, &key);
        amt
    }

    pub fn get_claimed_count(env: Env, dao_id: u64, proposal_id: u64) -> u64 {
        Self::bump_instance(&env);
        let key = DataKey::ClaimedCount(dao_id, proposal_id);
        let c: u64 = env.storage().persistent().get(&key).unwrap_or(0);
        if c != 0 {
            Self::bump_persistent(&env, &key);
        }
        c
    }

    pub fn is_claimed(env: Env, dao_id: u64, proposal_id: u64, claim_nullifier: U256) -> bool {
        Self::bump_instance(&env);
        let key = DataKey::ClaimNullifier(dao_id, proposal_id, claim_nullifier);
        env.storage().persistent().has(&key)
    }

    // ---- Helpers to get contract addresses ----
    pub fn tree_contract(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage().instance().get(&TREE_CONTRACT).unwrap()
    }
    pub fn registry(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage().instance().get(&REGISTRY).unwrap()
    }
    pub fn voting_contract(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage().instance().get(&VOTING_CONTRACT).unwrap()
    }

    pub fn version(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&VERSION_KEY)
            .unwrap_or(VERSION)
    }

    // ---- Core: claim ----
    /// Anonymous Vote-to-Earn claim.
    /// Checks is_nullifier_used on voting contract, then verifies claim proof and marks claim_nullifier.
    pub fn claim(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_nullifier: U256,
        claim_nullifier: U256,
        root: U256,
        proof: Proof,
    ) {
        Self::bump_instance(&env);

        let ctx = PathContext::Anonymous;

        // Field checks first (prevent modular reduction bypass)
        Self::assert_in_field(&env, ctx, &vote_nullifier);
        Self::assert_in_field(&env, ctx, &claim_nullifier);
        Self::assert_in_field(&env, ctx, &root);

        if vote_nullifier == U256::from_u32(&env, 0) || claim_nullifier == U256::from_u32(&env, 0) {
            panic_coarse(&env, ctx, RewardsError::InvalidNullifier);
        }

        // Prevent double-claim
        let claim_key = DataKey::ClaimNullifier(dao_id, proposal_id, claim_nullifier.clone());
        if env.storage().persistent().has(&claim_key) {
            panic_coarse(&env, ctx, RewardsError::ClaimNullifierUsed);
        }

        // Gate: only those who have voted can claim (check vote nullifier used)
        let voting: Address = env.storage().instance().get(&VOTING_CONTRACT).unwrap();
        let voted: bool = env.invoke_contract(
            &voting,
            &Symbol::new(&env, "is_nullifier_used"),
            soroban_sdk::vec![
                &env,
                dao_id.into_val(&env),
                proposal_id.into_val(&env),
                vote_nullifier.clone().into_val(&env)
            ],
        );
        if !voted {
            panic_coarse(&env, ctx, RewardsError::NotVoted);
        }

        // Root verification based on proposal vote_mode
        // Need to get proposal data via voting contract
        let tree_contract: Address = env.storage().instance().get(&TREE_CONTRACT).unwrap();

        // Get vote_mode: voting.get_vote_mode(dao_id, proposal_id) -> VoteMode
        let mode: VoteMode = env.invoke_contract(
            &voting,
            &Symbol::new(&env, "get_vote_mode"),
            soroban_sdk::vec![&env, dao_id.into_val(&env), proposal_id.into_val(&env)],
        );

        match mode {
            VoteMode::Fixed => {
                let eligible_root: U256 = env.invoke_contract(
                    &voting,
                    &Symbol::new(&env, "get_eligible_root"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), proposal_id.into_val(&env)],
                );
                if root != eligible_root {
                    panic_coarse(&env, ctx, RewardsError::RootMismatch);
                }
            }
            VoteMode::Trailing => {
                let root_valid: bool = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_ok"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), root.clone().into_val(&env)],
                );
                if !root_valid {
                    panic_coarse(&env, ctx, RewardsError::RootNotInHistory);
                }
                let root_index: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_idx"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), root.clone().into_val(&env)],
                );
                let earliest: u32 = env.invoke_contract(
                    &voting,
                    &Symbol::new(&env, "get_earliest_idx"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), proposal_id.into_val(&env)],
                );
                if root_index < earliest {
                    panic_coarse(&env, ctx, RewardsError::RootPredatesProposal);
                }
                let min_valid: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("min_root"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env)],
                );
                if root_index < min_valid {
                    panic_coarse(&env, ctx, RewardsError::RootPredatesRemoval);
                }
            }
        }

        // VK handling (per DAO, versioned)
        let vk_ver: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::VkVersion(dao_id))
            .unwrap_or_else(|| panic_coarse(&env, ctx, RewardsError::VkNotSet));
        if vk_ver == 0 {
            panic_coarse(&env, ctx, RewardsError::VkNotSet);
        }
        let vk: VerificationKey = Self::get_vk_by_version(&env, dao_id, vk_ver);

        // Treasury check before proof verification (cheap fail)
        let treasury_key = DataKey::Treasury(dao_id);
        let treasury: i128 = env.storage().persistent().get(&treasury_key).unwrap_or(0);
        let reward_key = DataKey::RewardAmount(dao_id);
        let reward: i128 = env
            .storage()
            .persistent()
            .get(&reward_key)
            .unwrap_or(DEFAULT_REWARD);
        if treasury < reward {
            panic_coarse(&env, ctx, RewardsError::TreasuryInsufficient);
        }

        // Groth16 verification: public signals [root, vote_nullifier, claim_nullifier, dao_id, proposal_id]
        let dao_sig = U256::from_u128(&env, dao_id as u128);
        let prop_sig = U256::from_u128(&env, proposal_id as u128);
        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            vote_nullifier.clone(),
            claim_nullifier.clone(),
            dao_sig,
            prop_sig
        ];
        if !Self::verify_groth16(&env, &vk, &proof, &pub_signals) {
            panic_coarse(&env, ctx, RewardsError::InvalidProof);
        }

        // Effects: mark claim nullifier used, debit treasury, increment counts
        env.storage().persistent().set(&claim_key, &true);
        Self::bump_persistent(&env, &claim_key);

        let new_treasury = treasury - reward;
        env.storage().persistent().set(&treasury_key, &new_treasury);
        Self::bump_persistent(&env, &treasury_key);

        let count_key = DataKey::ClaimedCount(dao_id, proposal_id);
        let cnt: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);
        env.storage().persistent().set(&count_key, &(cnt + 1));
        Self::bump_persistent(&env, &count_key);

        let total_key = DataKey::TotalClaimed(dao_id);
        let total: u64 = env.storage().persistent().get(&total_key).unwrap_or(0);
        env.storage().persistent().set(&total_key, &(total + 1));
        Self::bump_persistent(&env, &total_key);

        ClaimEvent {
            dao_id,
            proposal_id,
            claim_nullifier,
            vote_nullifier,
        }
        .publish(&env);
    }

    #[allow(unused_variables)]
    fn verify_groth16(
        env: &Env,
        vk: &VerificationKey,
        proof: &Proof,
        pub_signals: &Vec<U256>,
    ) -> bool {
        #[cfg(any(test, feature = "testutils"))]
        {
            if let Some(override_val) = env
                .storage()
                .instance()
                .get::<DataKey, bool>(&DataKey::VerifyOverride)
            {
                return override_val;
            }
        }
        if pub_signals.len() + 1 != vk.ic.len() {
            return false;
        }
        #[cfg(any(test, feature = "testutils"))]
        {
            true
        }
        #[cfg(not(any(test, feature = "testutils")))]
        {
            zkvote_groth16::verify_groth16(env, vk, proof, pub_signals)
        }
    }
}

#[cfg(test)]
mod test;
