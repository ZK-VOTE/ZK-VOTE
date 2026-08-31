#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, IntoVal, Symbol,
};

const REGISTRY: Symbol = symbol_short!("registry");
const VERSION: u32 = 1;
const VERSION_KEY: Symbol = symbol_short!("ver");

// TTL management: bump on every interaction to keep contract alive
const INSTANCE_TTL_THRESHOLD: u32 = 120_960; // ~7 days
const INSTANCE_TTL_EXTEND: u32 = 535_680; // ~31 days
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

// ── Sybil-resistance parameters (#301) ─────────────────────────────────────
//
// The weight a member carries is
//
//     weight = min(MAX_SYBIL_WEIGHT, BASE_WEIGHT + age_weight + rep_weight)
//
// where `age_weight` and `rep_weight` are *step* functions: one point per
// threshold crossed. Two properties matter and both fall out of that shape:
//
//   1. **Bounded.** Every identity, however old or well-regarded, is worth at
//      most MAX_SYBIL_WEIGHT. A fresh identity is worth BASE_WEIGHT. So the
//      most an attacker gains per Sybil relative to an honest member is a
//      fixed ratio (MAX_SYBIL_WEIGHT : BASE_WEIGHT), never unbounded.
//   2. **Concave.** Thresholds widen as they go (7 → 30 → 90 → 180 → 365
//      days), so the marginal value of waiting falls. Farming age is a losing
//      strategy well before the cap.
//
// The thresholds are duplicated in exactly three places, and all three MUST
// agree or a proof will verify against a weight the chain disagrees with:
//   * here (on-chain enforcement / the queryable source of truth),
//   * `circuits/weighted_vote.circom` (in-proof enforcement),
//   * `backend/src/services/sybil.ts` (the API the UI reads).
// `backend/test/sybil.test.ts` asserts the TypeScript mirror matches these.

/// Age thresholds in days. Crossing each one adds a point of weight.
pub const AGE_THRESHOLD_DAYS: [u64; 5] = [7, 30, 90, 180, 365];
/// Reputation thresholds. Crossing each one adds a point of weight.
pub const REPUTATION_THRESHOLDS: [u32; 5] = [1, 5, 15, 40, 100];
/// Weight every non-revoked member carries — one member, one vote as a floor.
pub const BASE_WEIGHT: u32 = 1;
/// Hard cap on any single identity's weight.
pub const MAX_SYBIL_WEIGHT: u32 = 10;
/// Upper bound on a stored reputation score, so accrual cannot overflow.
pub const MAX_REPUTATION: u32 = 10_000;
/// Seconds per day, for age bucketing.
pub const SECONDS_PER_DAY: u64 = 86_400;

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum SbtError {
    NotDaoAdmin = 1,
    AlreadyMinted = 2,
    NotMember = 3,
    NotOpenMembership = 4,
    AlreadyInitialized = 5,
    CooldownActive = 6,
    /// Raised by transfer/transfer_from/approve: membership SBTs are
    /// soulbound and can never change hands (#357).
    TransferAttempted = 7,
    /// Reputation accrual/slash would overflow or underflow the u32 score (#301).
    ReputationOutOfRange = 8,
    /// Caller is not an accredited reputation attestor for this DAO (#301).
    NotReputationAttestor = 9,
    /// Reputation weight parameters are not monotonically increasing (#301).
    InvalidWeightCurve = 10,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Member(u64, Address),    // (dao_id, address)
    Alias(u64, Address),     // (dao_id, address) -> encrypted alias
    Revoked(u64, Address),   // (dao_id, address) -> bool (revocation flag)
    MemberCount(u64),        // dao_id -> total member count
    MemberAtIndex(u64, u64), // (dao_id, index) -> Address
    /// Cooldown timestamp: prevents member from leaving/re-joining during active election
    TransferCooldown(u64, Address), // (dao_id, address) -> u64 (cooldown end timestamp)
    /// Election participation flag: true if member is registered in an active election
    InActiveElection(u64, Address), // (dao_id, address) -> bool

    // ── Sybil-resistance layer (#301) ──────────────────────────────────────
    // Appended at the end so existing storage discriminants stay stable.
    /// Ledger timestamp the member's SBT was first minted. This is the anchor
    /// for SBT-age weighting — it is set once on first mint and deliberately
    /// NOT reset by revoke/re-mint or leave/re-join, so churning an identity
    /// cannot be used to reset (or preserve) age.
    MintedAt(u64, Address), // (dao_id, address) -> u64 (unix seconds)
    /// Accrued reputation score for a member within a DAO.
    Reputation(u64, Address), // (dao_id, address) -> u32
    /// Addresses permitted to accrue/slash reputation for a DAO (the voting
    /// contract, plus any DAO-nominated attestor).
    ReputationAttestor(u64, Address), // (dao_id, address) -> bool
}

// Typed Events
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct SbtMintEvent {
    #[topic]
    pub dao_id: u64,
    pub to: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct SbtRevokeEvent {
    #[topic]
    pub dao_id: u64,
    pub member: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct SbtLeaveEvent {
    #[topic]
    pub dao_id: u64,
    pub member: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ReputationChangedEvent {
    #[topic]
    pub dao_id: u64,
    pub member: Address,
    pub old_score: u32,
    pub new_score: u32,
    pub reason: soroban_sdk::Symbol,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgraded {
    pub from: u32,
    pub to: u32,
}

#[contract]
pub struct MembershipSbt;

#[contractimpl]
impl MembershipSbt {
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

    /// Record the first-ever mint time for a member (#301).
    ///
    /// Written once and never overwritten. Age is the scarce resource the
    /// Sybil bound rests on, so it must survive a revoke/re-mint cycle — but it
    /// must equally not be *reset* by one, which would let an attacker recycle
    /// a burned identity into a fresh-looking one. Both directions are handled
    /// by simply refusing to write twice.
    fn record_mint_time(env: &Env, dao_id: u64, member: &Address) {
        let key = DataKey::MintedAt(dao_id, member.clone());
        if env.storage().persistent().has(&key) {
            Self::bump_persistent(env, &key);
            return;
        }
        let now = env.ledger().timestamp();
        env.storage().persistent().set(&key, &now);
        Self::bump_persistent(env, &key);
    }

    /// Constructor: Initialize contract with DAO Registry address
    pub fn __constructor(env: Env, registry: Address) {
        if env.storage().instance().has(&VERSION_KEY) {
            panic_with_error!(&env, SbtError::AlreadyInitialized);
        }
        env.storage().instance().set(&VERSION_KEY, &VERSION);
        ContractUpgraded {
            from: 0,
            to: VERSION,
        }
        .publish(&env);

        env.storage().instance().set(&REGISTRY, &registry);
    }

    fn registry_addr(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&REGISTRY)
            .unwrap_or_else(|| panic_with_error!(env, SbtError::NotDaoAdmin))
    }

    /// Helper: Add member to enumeration list
    fn add_member_to_list(env: &Env, dao_id: u64, member: &Address) {
        let count_key = DataKey::MemberCount(dao_id);
        let current_count: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);

        // Add member at current index
        let index_key = DataKey::MemberAtIndex(dao_id, current_count);
        env.storage().persistent().set(&index_key, member);
        Self::bump_persistent(env, &index_key);

        // Increment count
        let new_count = current_count + 1;
        env.storage().persistent().set(&count_key, &new_count);
        Self::bump_persistent(env, &count_key);
    }

    /// Mint SBT to address for a specific DAO
    /// Only DAO admin can mint (verified via registry)
    /// Optionally stores an encrypted alias for the member
    /// Can re-mint to previously revoked members
    pub fn mint(
        env: Env,
        dao_id: u64,
        to: Address,
        admin: Address,
        encrypted_alias: Option<soroban_sdk::String>,
    ) {
        Self::bump_instance(&env);
        // Verify admin authorization
        admin.require_auth();

        // Verify this admin owns the DAO (cross-contract call to registry)
        let registry: Address = Self::registry_addr(&env);
        let dao_admin: Address = env.invoke_contract(
            &registry,
            &symbol_short!("get_admin"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );

        if dao_admin != admin {
            panic_with_error!(&env, SbtError::NotDaoAdmin);
        }

        // Check if already has active SBT (not revoked)
        if Self::has(env.clone(), dao_id, to.clone()) {
            panic_with_error!(&env, SbtError::AlreadyMinted);
        }

        let member_key = DataKey::Member(dao_id, to.clone());
        let revoked_key = DataKey::Revoked(dao_id, to.clone());

        // Check if this is a new member (not just re-minting)
        let is_new_member = !env.storage().persistent().has(&member_key);

        // Set member
        env.storage().persistent().set(&member_key, &true);
        Self::bump_persistent(&env, &member_key);

        // Clear revoked flag if it exists (allows re-minting)
        if env.storage().persistent().has(&revoked_key) {
            env.storage().persistent().remove(&revoked_key);
        }

        // Store encrypted alias if provided
        if let Some(alias) = encrypted_alias {
            let alias_key = DataKey::Alias(dao_id, to.clone());
            env.storage().persistent().set(&alias_key, &alias);
            Self::bump_persistent(&env, &alias_key);
        }

        // Add to enumeration list if new member
        if is_new_member {
            Self::add_member_to_list(&env, dao_id, &to);
        }

        // Anchor SBT age on first mint (#301)
        Self::record_mint_time(&env, dao_id, &to);

        SbtMintEvent { dao_id, to }.publish(&env);
    }

    /// Mint SBT from registry during DAO initialization
    /// This function is called by the registry contract during create_and_init_dao
    /// to avoid re-entrancy issues. The registry is a trusted system contract.
    ///
    /// CRIT-1 fix (2026-05-24): require the registry contract's auth — the
    /// previous code documented "registry is a trusted system contract" but
    /// did NOT enforce it, letting anyone mint themselves an SBT in any DAO.
    pub fn mint_from_registry(env: Env, dao_id: u64, to: Address) {
        let registry = Self::registry_addr(&env);
        registry.require_auth();
        Self::bump_instance(&env);
        // Check not already minted
        if Self::has(env.clone(), dao_id, to.clone()) {
            panic_with_error!(&env, SbtError::AlreadyMinted);
        }

        let key = DataKey::Member(dao_id, to.clone());
        env.storage().persistent().set(&key, &true);
        Self::bump_persistent(&env, &key);

        // Add to enumeration list
        Self::add_member_to_list(&env, dao_id, &to);

        // Anchor SBT age on first mint (#301)
        Self::record_mint_time(&env, dao_id, &to);

        SbtMintEvent { dao_id, to }.publish(&env);
    }

    /// Check if address has SBT for a specific DAO (and is not revoked)
    pub fn has(env: Env, dao_id: u64, of: Address) -> bool {
        Self::bump_instance(&env);
        let member_key = DataKey::Member(dao_id, of.clone());
        let revoked_key = DataKey::Revoked(dao_id, of);

        // Must have SBT AND not be revoked
        let has_sbt: bool = env.storage().persistent().get(&member_key).unwrap_or(false);
        if has_sbt {
            Self::bump_persistent(&env, &member_key);
        }
        let is_revoked: bool = env
            .storage()
            .persistent()
            .get(&revoked_key)
            .unwrap_or(false);

        has_sbt && !is_revoked
    }

    /// Get registry address
    pub fn registry(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&REGISTRY)
            .unwrap_or_else(|| panic_with_error!(&env, SbtError::NotDaoAdmin))
    }

    /// Get encrypted alias for a member (if set)
    pub fn get_alias(env: Env, dao_id: u64, member: Address) -> Option<soroban_sdk::String> {
        Self::bump_instance(&env);
        let key = DataKey::Alias(dao_id, member);
        let result: Option<soroban_sdk::String> = env.storage().persistent().get(&key);
        if result.is_some() {
            Self::bump_persistent(&env, &key);
        }
        result
    }

    /// Revoke an SBT (admin only)
    /// Sets revocation flag, keeping member entry and alias intact
    pub fn revoke(env: Env, dao_id: u64, member: Address, admin: Address) {
        Self::bump_instance(&env);
        // Verify admin authorization
        admin.require_auth();

        // Verify this admin owns the DAO (cross-contract call to registry)
        let registry: Address = Self::registry_addr(&env);
        let dao_admin: Address = env.invoke_contract(
            &registry,
            &symbol_short!("get_admin"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );

        if dao_admin != admin {
            panic_with_error!(&env, SbtError::NotDaoAdmin);
        }

        // Member must exist
        let member_key = DataKey::Member(dao_id, member.clone());
        if !env.storage().persistent().has(&member_key) {
            panic_with_error!(&env, SbtError::NotMember);
        }

        // Set revoked flag
        let revoked_key = DataKey::Revoked(dao_id, member.clone());
        env.storage().persistent().set(&revoked_key, &true);
        Self::bump_persistent(&env, &revoked_key);

        SbtRevokeEvent { dao_id, member }.publish(&env);
    }

    /// Leave DAO voluntarily (member self-revokes)
    /// Sets revocation flag, keeping member entry and alias intact
    /// Prevents leaving if member is in an active election cooldown
    pub fn leave(env: Env, dao_id: u64, member: Address) {
        Self::bump_instance(&env);
        // Member must authorize their own departure
        member.require_auth();

        // Check cooldown: cannot leave during active election
        let cooldown_key = DataKey::TransferCooldown(dao_id, member.clone());
        let cooldown_end: Option<u64> = env.storage().persistent().get(&cooldown_key);
        if let Some(end) = cooldown_end {
            if env.ledger().timestamp() < end {
                panic_with_error!(&env, SbtError::CooldownActive);
            }
        }

        // Member must exist
        let member_key = DataKey::Member(dao_id, member.clone());
        if !env.storage().persistent().has(&member_key) {
            panic_with_error!(&env, SbtError::NotMember);
        }

        // Set revoked flag
        let revoked_key = DataKey::Revoked(dao_id, member.clone());
        env.storage().persistent().set(&revoked_key, &true);
        Self::bump_persistent(&env, &revoked_key);

        SbtLeaveEvent { dao_id, member }.publish(&env);
    }

    /// Self-join a DAO with open membership
    /// Allows users to mint their own SBT if the DAO allows open membership
    pub fn self_join(
        env: Env,
        dao_id: u64,
        member: Address,
        encrypted_alias: Option<soroban_sdk::String>,
    ) {
        Self::bump_instance(&env);
        // Member must authorize
        member.require_auth();

        // Check with registry if this DAO has open membership
        let registry: Address = Self::registry_addr(&env);
        let membership_open: bool = env.invoke_contract(
            &registry,
            &Symbol::new(&env, "is_membership_open"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );

        if !membership_open {
            panic_with_error!(&env, SbtError::NotOpenMembership);
        }

        // Check if already has active SBT (not revoked)
        if Self::has(env.clone(), dao_id, member.clone()) {
            panic_with_error!(&env, SbtError::AlreadyMinted);
        }

        let member_key = DataKey::Member(dao_id, member.clone());
        let revoked_key = DataKey::Revoked(dao_id, member.clone());

        // Check if this is a new member (not just re-minting)
        let is_new_member = !env.storage().persistent().has(&member_key);

        // Set member
        env.storage().persistent().set(&member_key, &true);
        Self::bump_persistent(&env, &member_key);

        // Clear revoked flag if it exists (allows re-joining)
        if env.storage().persistent().has(&revoked_key) {
            env.storage().persistent().remove(&revoked_key);
        }

        // Store encrypted alias if provided
        if let Some(alias) = encrypted_alias {
            let alias_key = DataKey::Alias(dao_id, member.clone());
            env.storage().persistent().set(&alias_key, &alias);
            Self::bump_persistent(&env, &alias_key);
        }

        // Add to enumeration list if new member
        if is_new_member {
            Self::add_member_to_list(&env, dao_id, &member);
        }

        // Anchor SBT age on first mint (#301)
        Self::record_mint_time(&env, dao_id, &member);

        SbtMintEvent { dao_id, to: member }.publish(&env);
    }

    /// Update encrypted alias for a member (admin only)
    pub fn update_alias(
        env: Env,
        dao_id: u64,
        member: Address,
        admin: Address,
        new_encrypted_alias: soroban_sdk::String,
    ) {
        Self::bump_instance(&env);
        // Verify admin authorization
        admin.require_auth();

        // Verify this admin owns the DAO (cross-contract call to registry)
        let registry: Address = Self::registry_addr(&env);
        let dao_admin: Address = env.invoke_contract(
            &registry,
            &symbol_short!("get_admin"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );

        if dao_admin != admin {
            panic_with_error!(&env, SbtError::NotDaoAdmin);
        }

        // Member must exist
        let member_key = DataKey::Member(dao_id, member.clone());
        if !env.storage().persistent().has(&member_key) {
            panic_with_error!(&env, SbtError::NotMember);
        }

        // Update alias
        let alias_key = DataKey::Alias(dao_id, member);
        env.storage()
            .persistent()
            .set(&alias_key, &new_encrypted_alias);
        Self::bump_persistent(&env, &alias_key);
    }

    /// Get total member count for a DAO
    pub fn get_member_count(env: Env, dao_id: u64) -> u64 {
        Self::bump_instance(&env);
        let count_key = DataKey::MemberCount(dao_id);
        let count: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);
        if count > 0 {
            Self::bump_persistent(&env, &count_key);
        }
        count
    }

    /// Get member address at a specific index
    pub fn get_member_at_index(env: Env, dao_id: u64, index: u64) -> Option<Address> {
        Self::bump_instance(&env);
        let index_key = DataKey::MemberAtIndex(dao_id, index);
        let result: Option<Address> = env.storage().persistent().get(&index_key);
        if result.is_some() {
            Self::bump_persistent(&env, &index_key);
        }
        result
    }

    /// Get a batch of members for a DAO
    /// Returns addresses from offset to offset+limit (or end of list)
    pub fn get_members(
        env: Env,
        dao_id: u64,
        offset: u64,
        limit: u64,
    ) -> soroban_sdk::Vec<Address> {
        Self::bump_instance(&env);
        let mut members = soroban_sdk::Vec::new(&env);
        let count = Self::get_member_count(env.clone(), dao_id);

        let start = offset;
        let end = core::cmp::min(offset + limit, count);

        for i in start..end {
            if let Some(member) = Self::get_member_at_index(env.clone(), dao_id, i) {
                members.push_back(member);
            }
        }

        members
    }

    // ── Anti-Flash Loan: Transfer Cooldown ──────────────────────────────────

    /// Set a member's transfer cooldown during an active election.
    /// Prevents the member from leaving or having their SBT revoked while voting.
    pub fn set_election_cooldown(env: Env, dao_id: u64, member: Address, cooldown_end: u64) {
        Self::bump_instance(&env);
        let key = DataKey::TransferCooldown(dao_id, member);
        env.storage().persistent().set(&key, &cooldown_end);
        Self::bump_persistent(&env, &key);
    }

    /// Clear a member's transfer cooldown after an election ends.
    pub fn clear_election_cooldown(env: Env, dao_id: u64, member: Address) {
        Self::bump_instance(&env);
        let key = DataKey::TransferCooldown(dao_id, member);
        env.storage().persistent().remove(&key);
    }

    /// Check if a member is in transfer cooldown.
    /// Returns true if cooldown is active (cannot leave DAO during active election).
    pub fn is_in_cooldown(env: Env, dao_id: u64, member: Address) -> bool {
        Self::bump_instance(&env);
        let key = DataKey::TransferCooldown(dao_id, member);
        let cooldown_end: Option<u64> = env.storage().persistent().get(&key);
        match cooldown_end {
            Some(end) => env.ledger().timestamp() < end,
            None => false,
        }
    }

    /// Mark a member as participating in an active election.
    pub fn set_in_active_election(env: Env, dao_id: u64, member: Address, active: bool) {
        Self::bump_instance(&env);
        let key = DataKey::InActiveElection(dao_id, member);
        env.storage().persistent().set(&key, &active);
        Self::bump_persistent(&env, &key);
    }

    /// Check if a member is participating in an active election.
    pub fn is_in_active_election(env: Env, dao_id: u64, member: Address) -> bool {
        Self::bump_instance(&env);
        let key = DataKey::InActiveElection(dao_id, member);
        env.storage().persistent().get(&key).unwrap_or(false)
    }

    /// Contract version for upgrade tracking.
    pub fn version(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&VERSION_KEY)
            .unwrap_or(VERSION)
    }

    // ── Sybil-resistance layer: SBT age + reputation (#301) ────────────────
    //
    // THREAT_MODEL §"Sybil bounds" requires that Vote-to-Earn and quadratic
    // voting cannot be drained by minting identities. Flat per-identity rewards
    // are Sybil-vulnerable by construction; the mitigation is to make an
    // identity's *weight* a function of two things an attacker cannot mint:
    // elapsed time and accrued reputation.

    /// Age of a member's SBT in whole days, measured from first mint.
    ///
    /// Returns 0 for a non-member and for anyone whose mint time predates
    /// nothing (i.e. was never recorded), so an unrecorded member can never
    /// accidentally read as ancient.
    pub fn member_age_days(env: Env, dao_id: u64, member: Address) -> u64 {
        Self::bump_instance(&env);
        let key = DataKey::MintedAt(dao_id, member);
        let minted_at: u64 = match env.storage().persistent().get(&key) {
            Some(t) => t,
            None => return 0,
        };
        let now = env.ledger().timestamp();
        now.saturating_sub(minted_at) / SECONDS_PER_DAY
    }

    /// Raw stored reputation score for a member.
    pub fn reputation(env: Env, dao_id: u64, member: Address) -> u32 {
        Self::bump_instance(&env);
        let key = DataKey::Reputation(dao_id, member);
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    /// Points contributed by SBT age: one per threshold in
    /// [`AGE_THRESHOLD_DAYS`] that the member has crossed.
    pub fn age_weight(env: Env, dao_id: u64, member: Address) -> u32 {
        let age_days = Self::member_age_days(env, dao_id, member);
        let mut points = 0u32;
        for threshold in AGE_THRESHOLD_DAYS.iter() {
            if age_days >= *threshold {
                points += 1;
            }
        }
        points
    }

    /// Points contributed by reputation: one per threshold in
    /// [`REPUTATION_THRESHOLDS`] that the member has crossed.
    pub fn reputation_weight(env: Env, dao_id: u64, member: Address) -> u32 {
        let score = Self::reputation(env, dao_id, member);
        let mut points = 0u32;
        for threshold in REPUTATION_THRESHOLDS.iter() {
            if score >= *threshold {
                points += 1;
            }
        }
        points
    }

    /// The Sybil-bounded voting weight for a member.
    ///
    /// A revoked or non-existent member is worth 0 — not BASE_WEIGHT — so
    /// revocation genuinely removes influence rather than merely capping it.
    pub fn sybil_weight(env: Env, dao_id: u64, member: Address) -> u32 {
        if !Self::has(env.clone(), dao_id, member.clone()) {
            return 0;
        }
        let age = Self::age_weight(env.clone(), dao_id, member.clone());
        let rep = Self::reputation_weight(env, dao_id, member);
        let raw = BASE_WEIGHT + age + rep;
        if raw > MAX_SYBIL_WEIGHT {
            MAX_SYBIL_WEIGHT
        } else {
            raw
        }
    }

    /// Nominate an address that may accrue or slash reputation for a DAO.
    ///
    /// Typically the voting contract (so participation credits are awarded by
    /// the same code that verified the vote) plus whatever attestor the DAO
    /// chooses. Reputation is deliberately *not* self-serve: an identity that
    /// could credit itself would defeat the whole layer.
    pub fn set_reputation_attestor(
        env: Env,
        dao_id: u64,
        attestor: Address,
        allowed: bool,
        admin: Address,
    ) {
        Self::bump_instance(&env);
        admin.require_auth();

        let registry: Address = Self::registry_addr(&env);
        let dao_admin: Address = env.invoke_contract(
            &registry,
            &symbol_short!("get_admin"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );
        if dao_admin != admin {
            panic_with_error!(&env, SbtError::NotDaoAdmin);
        }

        let key = DataKey::ReputationAttestor(dao_id, attestor);
        if allowed {
            env.storage().persistent().set(&key, &true);
            Self::bump_persistent(&env, &key);
        } else {
            env.storage().persistent().remove(&key);
        }
    }

    /// Whether an address may accrue/slash reputation for a DAO.
    pub fn is_reputation_attestor(env: Env, dao_id: u64, who: Address) -> bool {
        Self::bump_instance(&env);
        let key = DataKey::ReputationAttestor(dao_id, who);
        env.storage().persistent().get(&key).unwrap_or(false)
    }

    fn assert_attestor(env: &Env, dao_id: u64, attestor: &Address) {
        attestor.require_auth();
        let key = DataKey::ReputationAttestor(dao_id, attestor.clone());
        let allowed: bool = env.storage().persistent().get(&key).unwrap_or(false);
        if !allowed {
            panic_with_error!(env, SbtError::NotReputationAttestor);
        }
    }

    /// Credit reputation to a member for a governance action.
    ///
    /// Saturates at [`MAX_REPUTATION`] rather than wrapping, and rejects a
    /// credit for a non-member outright so reputation cannot be parked on an
    /// address before it joins.
    pub fn accrue_reputation(
        env: Env,
        dao_id: u64,
        member: Address,
        amount: u32,
        attestor: Address,
        reason: Symbol,
    ) -> u32 {
        Self::bump_instance(&env);
        Self::assert_attestor(&env, dao_id, &attestor);

        if !Self::has(env.clone(), dao_id, member.clone()) {
            panic_with_error!(&env, SbtError::NotMember);
        }
        if amount > MAX_REPUTATION {
            panic_with_error!(&env, SbtError::ReputationOutOfRange);
        }

        let key = DataKey::Reputation(dao_id, member.clone());
        let old_score: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_score = old_score.saturating_add(amount).min(MAX_REPUTATION);

        env.storage().persistent().set(&key, &new_score);
        Self::bump_persistent(&env, &key);

        ReputationChangedEvent {
            dao_id,
            member,
            old_score,
            new_score,
            reason,
        }
        .publish(&env);

        new_score
    }

    /// Debit reputation from a member — the abuse response.
    ///
    /// Saturates at 0. Slashing is what makes reputation cost something to
    /// misuse: without it, an attacker who farms reputation keeps it forever
    /// and the score is only ever a one-way ratchet.
    pub fn slash_reputation(
        env: Env,
        dao_id: u64,
        member: Address,
        amount: u32,
        attestor: Address,
        reason: Symbol,
    ) -> u32 {
        Self::bump_instance(&env);
        Self::assert_attestor(&env, dao_id, &attestor);

        let key = DataKey::Reputation(dao_id, member.clone());
        let old_score: u32 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_score = old_score.saturating_sub(amount);

        env.storage().persistent().set(&key, &new_score);
        Self::bump_persistent(&env, &key);

        ReputationChangedEvent {
            dao_id,
            member,
            old_score,
            new_score,
            reason,
        }
        .publish(&env);

        new_score
    }

    /// The weight-curve parameters, so the circuit build and the backend can
    /// read the on-chain source of truth instead of hardcoding a second copy.
    ///
    /// Returned as a flat vector: [BASE_WEIGHT, MAX_SYBIL_WEIGHT,
    /// MAX_REPUTATION, age thresholds…, reputation thresholds…].
    pub fn weight_curve_params(env: Env) -> soroban_sdk::Vec<u32> {
        Self::bump_instance(&env);
        let mut out = soroban_sdk::Vec::new(&env);
        out.push_back(BASE_WEIGHT);
        out.push_back(MAX_SYBIL_WEIGHT);
        out.push_back(MAX_REPUTATION);
        for t in AGE_THRESHOLD_DAYS.iter() {
            out.push_back(*t as u32);
        }
        for t in REPUTATION_THRESHOLDS.iter() {
            out.push_back(*t);
        }
        out
    }

    // ── Soulbound guarantee: reject transfer/approval attempts (#357) ───────
    //
    // Membership SBTs are non-transferable by design: this contract never
    // implemented `transfer`/`transfer_from`/`approve` in the first place, so
    // Soroban already rejects any attempt to call them with a generic
    // "function not found" trap. These explicit stubs exist so that a caller
    // gets a specific, typed `TransferAttempted` error instead of an opaque
    // host-level failure, and so the attempt is observable off-chain.
    //
    // `dao_id` is placed first (ahead of the familiar SEP-41 parameter order)
    // so a fixed argument position reliably identifies which DAO an attempt
    // targeted, for every guarded function, without per-function decoding
    // rules on the indexing side.
    //
    // These functions always panic, which means Soroban rolls back every
    // storage write *and* every event published earlier in the same
    // invocation — so there is no way to also emit an on-chain event here to
    // signal the attempt; a panicking call leaves no trace once the ledger
    // closes. Detection instead happens off-chain in
    // `backend/src/services/sbt-guard.ts`, which inspects the *attempted*
    // invocation recorded in the transaction envelope (present whether the
    // call succeeded or failed) rather than waiting for a committed event.

    /// Always rejects: membership SBTs cannot be transferred.
    pub fn transfer(env: Env, dao_id: u64, from: Address, to: Address, amount: i128) {
        let _ = (dao_id, to, amount);
        from.require_auth();
        panic_with_error!(&env, SbtError::TransferAttempted);
    }

    /// Always rejects: membership SBTs cannot be transferred by a delegate.
    pub fn transfer_from(
        env: Env,
        dao_id: u64,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) {
        let _ = (dao_id, from, to, amount);
        spender.require_auth();
        panic_with_error!(&env, SbtError::TransferAttempted);
    }

    /// Always rejects: membership SBTs cannot be approved for transfer.
    pub fn approve(
        env: Env,
        dao_id: u64,
        from: Address,
        spender: Address,
        amount: i128,
        live_until_ledger: u32,
    ) {
        let _ = (dao_id, spender, amount, live_until_ledger);
        from.require_auth();
        panic_with_error!(&env, SbtError::TransferAttempted);
    }
}

#[cfg(test)]
mod test;
