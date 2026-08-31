#![no_std]

mod allowance;

use allowance::{is_allowance_expired, read_allowance, read_allowance_amount, write_allowance};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Bytes, BytesN, Env, String, Vec,
};

const ADMIN_KEY: soroban_sdk::Symbol = symbol_short!("admin");
const NAME_KEY: soroban_sdk::Symbol = symbol_short!("name");
const SYMBOL_KEY: soroban_sdk::Symbol = symbol_short!("symbol");
const DECIMALS_KEY: soroban_sdk::Symbol = symbol_short!("decim");
const VERSION: u32 = 1;
const VERSION_KEY: soroban_sdk::Symbol = symbol_short!("ver");

const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 535_680;
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

const CLAWBACK_DELAY_LEDGERS: u32 = 34_560;
const CLAWBACK_PERIOD_LEDGERS: u32 = 5_184_000;

// Issue #110: batch operations. Soroban enforces per-transaction CPU
// instruction and read/write-entry limits; a single batch call must not
// exceed those. 50 is a conservative starting point — see the
// `bench_batch_transfer_cost_scaling` test below, which prints actual CPU
// instructions consumed per batch size so this can be tuned against real
// mainnet resource limits rather than guessed.
const MAX_BATCH_SIZE: u32 = 50;

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum TokenError {
    AlreadyInitialized = 1,
    InsufficientBalance = 2,
    InsufficientAllowance = 3,
    Unauthorized = 4,
    InvalidAmount = 5,
    Overflow = 6,
    AllowanceRaceRejected = 7,
    NotAdmin = 8,
    NegativeAllowance = 9,
    ClawbackNotGovernor = 10,
    ClawbackInsufficientApprovals = 11,
    ClawbackAlreadyApproved = 12,
    ClawbackNotReady = 13,
    ClawbackAlreadyExecuted = 14,
    ClawbackPeriodLimitExceeded = 15,
    ClawbackNotFound = 16,
    InvalidSignature = 17,
    PermitExpired = 18,
    PermitReplay = 19,
    SupplyCapExceeded = 20,
    SelfDelegation = 21,
    BatchTooLarge = 22,
    EmptyBatch = 23,
    NullifierAlreadySpent = 24,
    InvalidShieldedProof = 25,
    ShieldedPoolExhausted = 26,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Checkpoint {
    pub ledger_sequence: u32,
    pub balance: i128,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Balance(Address),
    TotalSupply,
    TotalMinted,
    TotalBurned,
    BurnHistoryCount,
    BurnRecord(u32),
    Governors,
    RequiredApprovals,
    ClawbackProposalCount,
    ClawbackProposal(u32),
    ClawbackHistoryCount,
    ClawbackRecord(u32),
    ClawbackPeriodTotal,
    ClawbackPeriodStart,
    ClawbackPeriodLimit,
    Nonce(Address),
    MaxSupply,
    Checkpoints(Address),
    CheckpointRetention,
    Delegate(Address),
    ShieldedPoolBalance,
    NullifierSpent(BytesN<32>),
    ShieldedCommitment(u32),
    ShieldedCommitmentCount,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ShieldEvent {
    #[topic]
    pub from: Address,
    pub amount: i128,
    pub commitment: BytesN<32>,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ShieldedTransferEvent {
    pub commitment_count: u32,
    pub public_fee: i128,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct UnshieldEvent {
    #[topic]
    pub to: Address,
    pub amount: i128,
    pub nullifier: BytesN<32>,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ApproveEvent {
    #[topic]
    pub from: Address,
    #[topic]
    pub spender: Address,
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct TransferEvent {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct MintEvent {
    // Issue #111: SEP-41 defines mint topics as ["mint", admin, to] — `admin`
    // was previously missing entirely, so indexers couldn't attribute a mint
    // to the admin who authorized it.
    #[topic]
    pub admin: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

// Issue #101 (phase 1): pure delegation registry. Emitted whenever a holder
// changes or clears who they delegate to. This does NOT yet feed into
// voting power — see `delegate`/`undelegate`/`get_delegate` doc comments.
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DelegateChanged {
    #[topic]
    pub delegator: Address,
    pub from_delegatee: Option<Address>,
    pub to_delegatee: Option<Address>,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct BurnEvent {
    #[topic]
    pub from: Address,
    pub amount: i128,
    pub new_supply: i128,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BurnRecord {
    pub id: u32,
    pub from: Address,
    pub amount: i128,
    pub new_supply: i128,
    pub ledger: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgraded {
    pub from: u32,
    pub to: u32,
}

// ── Clawback types (Issue #102) ────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ClawbackProposal {
    pub id: u32,
    pub target: Address,
    pub amount: i128,
    pub reason: String,
    pub proposer: Address,
    pub approvals: Vec<Address>,
    pub created_ledger: u32,
    pub executed: bool,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ClawbackRecord {
    pub target: Address,
    pub amount: i128,
    pub reason: String,
    pub executor: Address,
    pub ledger: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ClawbackExecuted {
    #[topic]
    pub target: Address,
    pub amount: i128,
    pub reason: String,
    pub executor: Address,
    pub new_supply: i128,
}

#[contract]
pub struct Token;

#[contractimpl]
impl Token {
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

    pub fn __constructor(env: Env, admin: Address, name: String, symbol: String, decimals: u32) {
        if env.storage().instance().has(&VERSION_KEY) {
            panic_with_error!(&env, TokenError::AlreadyInitialized);
        }
        env.storage().instance().set(&VERSION_KEY, &VERSION);
        ContractUpgraded {
            from: 0,
            to: VERSION,
        }
        .publish(&env);

        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&NAME_KEY, &name);
        env.storage().instance().set(&SYMBOL_KEY, &symbol);
        env.storage().instance().set(&DECIMALS_KEY, &decimals);
    }

    pub fn name(env: Env) -> String {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&NAME_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::AlreadyInitialized))
    }

    pub fn symbol(env: Env) -> String {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&SYMBOL_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::AlreadyInitialized))
    }

    pub fn decimals(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DECIMALS_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::AlreadyInitialized))
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        Self::bump_instance(&env);
        let key = DataKey::Balance(id.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if bal > 0 {
            Self::bump_persistent(&env, &key);
        }
        bal
    }

    pub fn admin(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::AlreadyInitialized))
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let current_admin: Address = Self::admin(env.clone());
        current_admin.require_auth();
        Self::bump_instance(&env);
        env.storage().instance().set(&ADMIN_KEY, &new_admin);
    }

    // ── Balance helpers ─────────────────────────────────────────────────────

    fn receive_balance(env: &Env, to: &Address, amount: i128) {
        if amount == 0 {
            return;
        }
        let key = DataKey::Balance(to.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new = current.checked_add(amount).unwrap_or_else(|| {
            panic_with_error!(env, TokenError::Overflow);
        });
        env.storage().persistent().set(&key, &new);
        Self::bump_persistent(env, &key);
        Self::create_checkpoint(env, to, new);
    }

    fn spend_balance(env: &Env, from: &Address, amount: i128) {
        if amount == 0 {
            return;
        }
        let key = DataKey::Balance(from.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if current < amount {
            panic_with_error!(env, TokenError::InsufficientBalance);
        }
        let new = current - amount;
        if new == 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &new);
            Self::bump_persistent(env, &key);
        }
        Self::create_checkpoint(env, from, new);
    }

    // ── Checkpoint / Snapshotting (Issue #106) ─────────────────────────────

    fn create_checkpoint(env: &Env, address: &Address, balance: i128) {
        let ledger = env.ledger().sequence();
        let cp_key = DataKey::Checkpoints(address.clone());

        let mut checkpoints: Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&cp_key)
            .unwrap_or_else(|| Vec::new(env));

        // Avoid duplicate checkpoint at the same ledger
        if let Some(last) = checkpoints.last() {
            if last.ledger_sequence == ledger {
                // Update the last checkpoint in-place
                let len = checkpoints.len();
                checkpoints.set(
                    len - 1,
                    Checkpoint {
                        ledger_sequence: ledger,
                        balance,
                    },
                );
                env.storage().persistent().set(&cp_key, &checkpoints);
                Self::bump_persistent(env, &cp_key);
                return;
            }
        }

        checkpoints.push_back(Checkpoint {
            ledger_sequence: ledger,
            balance,
        });

        // Prune old checkpoints beyond retention period
        let retention = Self::get_checkpoint_retention(env);
        if retention > 0 && checkpoints.len() > retention {
            let prune_count = checkpoints.len() - retention;
            let mut pruned = Vec::new(env);
            for i in prune_count..checkpoints.len() {
                if let Some(cp) = checkpoints.get(i) {
                    pruned.push_back(cp);
                }
            }
            checkpoints = pruned;
        }

        env.storage().persistent().set(&cp_key, &checkpoints);
        Self::bump_persistent(env, &cp_key);
    }

    /// Get balance at a specific ledger sequence using binary search on checkpoints.
    /// Returns the balance that was active at the given ledger.
    pub fn balance_at(env: Env, address: Address, ledger_sequence: u32) -> i128 {
        Self::bump_instance(&env);
        let cp_key = DataKey::Checkpoints(address.clone());
        let checkpoints: Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&cp_key)
            .unwrap_or_else(|| Vec::new(&env));

        if checkpoints.is_empty() {
            return 0;
        }

        // Binary search for the latest checkpoint <= ledger_sequence
        let mut low: u32 = 0;
        let mut high: u32 = checkpoints.len() - 1;
        let mut result: i128 = 0;

        while low <= high {
            let mid = (low + high) / 2;
            if let Some(cp) = checkpoints.get(mid) {
                if cp.ledger_sequence <= ledger_sequence {
                    result = cp.balance;
                    low = mid + 1;
                } else {
                    if mid == 0 {
                        break;
                    }
                    high = mid - 1;
                }
            } else {
                break;
            }
        }

        result
    }

    /// Get all checkpoints for an address (for debugging).
    pub fn get_checkpoints(env: Env, address: Address) -> Vec<Checkpoint> {
        Self::bump_instance(&env);
        let cp_key = DataKey::Checkpoints(address);
        env.storage()
            .persistent()
            .get(&cp_key)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Set checkpoint retention period (number of checkpoints to keep per address).
    /// 0 means unlimited retention.
    pub fn set_checkpoint_retention(env: Env, retention: u32) {
        let admin: Address = Self::admin(env.clone());
        admin.require_auth();
        Self::bump_instance(&env);

        let key = DataKey::CheckpointRetention;
        env.storage().persistent().set(&key, &retention);
        Self::bump_persistent(&env, &key);
    }

    fn get_checkpoint_retention(env: &Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::CheckpointRetention)
            .unwrap_or(0)
    }

    /// Get checkpoint retention period.
    pub fn checkpoint_retention(env: Env) -> u32 {
        Self::bump_instance(&env);
        Self::get_checkpoint_retention(&env)
    }

    fn xfer(env: &Env, from: &Address, to: &Address, amount: i128) {
        Self::spend_balance(env, from, amount);
        Self::receive_balance(env, to, amount);
    }

    // ── Supply tracking helpers (Issue #103) ────────────────────────────────

    fn get_supply(env: &Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    fn set_supply(env: &Env, value: i128) {
        let key = DataKey::TotalSupply;
        env.storage().persistent().set(&key, &value);
        Self::bump_persistent(env, &key);
    }

    fn get_total_minted(env: &Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalMinted)
            .unwrap_or(0)
    }

    fn set_total_minted(env: &Env, value: i128) {
        let key = DataKey::TotalMinted;
        env.storage().persistent().set(&key, &value);
        Self::bump_persistent(env, &key);
    }

    fn get_total_burned(env: &Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::TotalBurned)
            .unwrap_or(0)
    }

    fn set_total_burned(env: &Env, value: i128) {
        let key = DataKey::TotalBurned;
        env.storage().persistent().set(&key, &value);
        Self::bump_persistent(env, &key);
    }

    fn increment_supply(env: &Env, amount: i128) -> i128 {
        let current = Self::get_supply(env);
        let new = current.checked_add(amount).unwrap_or_else(|| {
            panic_with_error!(env, TokenError::Overflow);
        });
        Self::set_supply(env, new);

        let total_minted = Self::get_total_minted(env);
        let new_minted = total_minted.checked_add(amount).unwrap_or_else(|| {
            panic_with_error!(env, TokenError::Overflow);
        });
        Self::set_total_minted(env, new_minted);

        new
    }

    fn decrement_supply(env: &Env, amount: i128) -> i128 {
        let current = Self::get_supply(env);
        if current < amount {
            panic_with_error!(env, TokenError::Overflow);
        }
        let new = current - amount;
        Self::set_supply(env, new);

        let total_burned = Self::get_total_burned(env);
        let new_burned = total_burned.checked_add(amount).unwrap_or_else(|| {
            panic_with_error!(env, TokenError::Overflow);
        });
        Self::set_total_burned(env, new_burned);

        new
    }

    fn store_burn_record(env: &Env, from: &Address, amount: i128, new_supply: i128) {
        let count_key = DataKey::BurnHistoryCount;
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        let new_count = count.checked_add(1).unwrap_or_else(|| {
            panic_with_error!(env, TokenError::Overflow);
        });

        let record = BurnRecord {
            id: new_count,
            from: from.clone(),
            amount,
            new_supply,
            ledger: env.ledger().sequence(),
        };

        let record_key = DataKey::BurnRecord(new_count);
        env.storage().persistent().set(&record_key, &record);
        Self::bump_persistent(env, &record_key);

        env.storage().persistent().set(&count_key, &new_count);
        Self::bump_persistent(env, &count_key);
    }

    fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
        let (current_allowance, expiration_ledger) =
            read_allowance(env, from.clone(), spender.clone());
        if current_allowance < amount {
            panic_with_error!(env, TokenError::InsufficientAllowance);
        }
        let new_allowance = current_allowance - amount;
        write_allowance(
            env,
            from.clone(),
            spender.clone(),
            new_allowance,
            expiration_ledger,
        );
    }

    // ── Token Interface: Allowance ──────────────────────────────────────────

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        Self::bump_instance(&env);
        read_allowance_amount(&env, from, spender)
    }

    pub fn is_allowance_expired(env: Env, from: Address, spender: Address) -> bool {
        Self::bump_instance(&env);
        is_allowance_expired(&env, from, spender)
    }

    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        from.require_auth();
        Self::bump_instance(&env);

        let current = read_allowance_amount(&env, from.clone(), spender.clone());

        let is_race_rejected = current != 0 && amount != 0 && current != amount;

        if is_race_rejected {
            panic_with_error!(&env, TokenError::AllowanceRaceRejected);
        }

        write_allowance(
            &env,
            from.clone(),
            spender.clone(),
            amount,
            expiration_ledger,
        );

        ApproveEvent {
            from,
            spender,
            amount,
            expiration_ledger,
        }
        .publish(&env);
    }

    pub fn increase_allowance(
        env: Env,
        from: Address,
        spender: Address,
        add_amount: i128,
        expiration_ledger: u32,
    ) {
        from.require_auth();
        Self::bump_instance(&env);

        if add_amount < 0 {
            panic_with_error!(&env, TokenError::NegativeAllowance);
        }

        let (current, _) = read_allowance(&env, from.clone(), spender.clone());
        let new = current.checked_add(add_amount).unwrap_or_else(|| {
            panic_with_error!(&env, TokenError::Overflow);
        });

        write_allowance(&env, from.clone(), spender.clone(), new, expiration_ledger);

        ApproveEvent {
            from,
            spender,
            amount: new,
            expiration_ledger,
        }
        .publish(&env);
    }

    pub fn decrease_allowance(
        env: Env,
        from: Address,
        spender: Address,
        sub_amount: i128,
        expiration_ledger: u32,
    ) {
        from.require_auth();
        Self::bump_instance(&env);

        if sub_amount < 0 {
            panic_with_error!(&env, TokenError::NegativeAllowance);
        }

        let (current, _) = read_allowance(&env, from.clone(), spender.clone());
        let new = if sub_amount >= current {
            0
        } else {
            current - sub_amount
        };

        write_allowance(&env, from.clone(), spender.clone(), new, expiration_ledger);

        ApproveEvent {
            from,
            spender,
            amount: new,
            expiration_ledger,
        }
        .publish(&env);
    }

    // ── Token Interface: Transfers ──────────────────────────────────────────

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        Self::bump_instance(&env);

        if amount < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        Self::xfer(&env, &from, &to, amount);

        TransferEvent { from, to, amount }.publish(&env);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        Self::bump_instance(&env);

        if amount < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        Self::spend_allowance(&env, &from, &spender, amount);
        Self::xfer(&env, &from, &to, amount);

        TransferEvent { from, to, amount }.publish(&env);
    }

    // ── Token Interface: Burn (Issue #103) ─────────────────────────────────

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        Self::bump_instance(&env);

        if amount < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        Self::spend_balance(&env, &from, amount);
        let new_supply = Self::decrement_supply(&env, amount);
        Self::store_burn_record(&env, &from, amount, new_supply);

        BurnEvent {
            from,
            amount,
            new_supply,
        }
        .publish(&env);
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        Self::bump_instance(&env);

        if amount < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        Self::spend_allowance(&env, &from, &spender, amount);
        Self::spend_balance(&env, &from, amount);
        let new_supply = Self::decrement_supply(&env, amount);
        Self::store_burn_record(&env, &from, amount, new_supply);

        BurnEvent {
            from,
            amount,
            new_supply,
        }
        .publish(&env);
    }

    // ── Supply cap helpers (Issue #98) ──────────────────────────────────────

    fn get_max_supply_storage(env: &Env) -> Option<i128> {
        env.storage().persistent().get(&DataKey::MaxSupply)
    }

    // ── Admin: Mint ─────────────────────────────────────────────────────────

    pub fn set_max_supply(env: Env, max_supply: i128) {
        let admin: Address = Self::admin(env.clone());
        admin.require_auth();
        Self::bump_instance(&env);

        if max_supply < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        let key = DataKey::MaxSupply;
        env.storage().persistent().set(&key, &max_supply);
        Self::bump_persistent(&env, &key);
    }

    pub fn get_max_supply(env: Env) -> Option<i128> {
        Self::bump_instance(&env);
        Self::get_max_supply_storage(&env)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let admin: Address = Self::admin(env.clone());
        admin.require_auth();
        Self::bump_instance(&env);

        if amount < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        if let Some(cap) = Self::get_max_supply_storage(&env) {
            let current = Self::get_supply(&env);
            let new_supply = current.checked_add(amount).unwrap_or_else(|| {
                panic_with_error!(&env, TokenError::Overflow);
            });
            if new_supply > cap {
                panic_with_error!(&env, TokenError::SupplyCapExceeded);
            }
        }

        Self::receive_balance(&env, &to, amount);
        Self::increment_supply(&env, amount);

        MintEvent { admin, to, amount }.publish(&env);
    }

    pub fn version(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&VERSION_KEY)
            .unwrap_or(VERSION)
    }

    // ── Supply queries (Issue #103) ─────────────────────────────────────────

    pub fn total_supply(env: Env) -> i128 {
        Self::bump_instance(&env);
        Self::get_supply(&env)
    }

    pub fn total_minted(env: Env) -> i128 {
        Self::bump_instance(&env);
        Self::get_total_minted(&env)
    }

    pub fn total_burned(env: Env) -> i128 {
        Self::bump_instance(&env);
        Self::get_total_burned(&env)
    }

    pub fn burn_history(env: Env, count: u32) -> Vec<BurnRecord> {
        Self::bump_instance(&env);
        let total: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::BurnHistoryCount)
            .unwrap_or(0);
        let mut records = Vec::new(&env);
        let start = total.saturating_sub(count);
        for i in (start + 1)..=total {
            let key = DataKey::BurnRecord(i);
            if let Some(record) = env.storage().persistent().get::<_, BurnRecord>(&key) {
                records.push_back(record);
            }
        }
        records
    }

    // ── Clawback Governance (Issue #102) ────────────────────────────────────

    fn get_governors(env: &Env) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Governors)
            .unwrap_or_else(|| Vec::new(env))
    }

    fn get_required_approvals(env: &Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::RequiredApprovals)
            .unwrap_or(0)
    }

    fn is_governor(env: &Env, addr: &Address) -> bool {
        let governors = Self::get_governors(env);
        for g in governors.iter() {
            if g == *addr {
                return true;
            }
        }
        false
    }

    pub fn set_governors(env: Env, governors: Vec<Address>, required_approvals: u32) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        Self::bump_instance(&env);

        let count = governors.len();
        if required_approvals == 0 || required_approvals > count {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        let key = DataKey::Governors;
        env.storage().persistent().set(&key, &governors);
        Self::bump_persistent(&env, &key);

        let req_key = DataKey::RequiredApprovals;
        env.storage()
            .persistent()
            .set(&req_key, &required_approvals);
        Self::bump_persistent(&env, &req_key);
    }

    pub fn get_governors_list(env: Env) -> Vec<Address> {
        Self::bump_instance(&env);
        Self::get_governors(&env)
    }

    pub fn propose_clawback(env: Env, target: Address, amount: i128, reason: String) -> u32 {
        let proposer = Self::admin(env.clone());
        proposer.require_auth();
        Self::bump_instance(&env);

        if amount <= 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        let count_key = DataKey::ClawbackProposalCount;
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        let new_count = count.checked_add(1).unwrap_or_else(|| {
            panic_with_error!(&env, TokenError::Overflow);
        });

        let mut approvals = Vec::new(&env);
        approvals.push_back(proposer.clone());

        let proposal = ClawbackProposal {
            id: new_count,
            target: target.clone(),
            amount,
            reason: reason.clone(),
            proposer,
            approvals,
            created_ledger: env.ledger().sequence(),
            executed: false,
        };

        let prop_key = DataKey::ClawbackProposal(new_count);
        env.storage().persistent().set(&prop_key, &proposal);
        Self::bump_persistent(&env, &prop_key);

        env.storage().persistent().set(&count_key, &new_count);
        Self::bump_persistent(&env, &count_key);

        new_count
    }

    pub fn approve_clawback(env: Env, proposal_id: u32) {
        let governor = Self::admin(env.clone());
        governor.require_auth();
        Self::bump_instance(&env);

        let prop_key = DataKey::ClawbackProposal(proposal_id);
        let mut proposal: ClawbackProposal = env
            .storage()
            .persistent()
            .get(&prop_key)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::ClawbackNotFound));

        if proposal.executed {
            panic_with_error!(&env, TokenError::ClawbackAlreadyExecuted);
        }

        if !Self::is_governor(&env, &governor) {
            panic_with_error!(&env, TokenError::ClawbackNotGovernor);
        }

        for a in proposal.approvals.iter() {
            if a == governor {
                panic_with_error!(&env, TokenError::ClawbackAlreadyApproved);
            }
        }

        proposal.approvals.push_back(governor);

        env.storage().persistent().set(&prop_key, &proposal);
        Self::bump_persistent(&env, &prop_key);
    }

    pub fn execute_clawback(env: Env, proposal_id: u32) {
        let executor = Self::admin(env.clone());
        executor.require_auth();
        Self::bump_instance(&env);

        let prop_key = DataKey::ClawbackProposal(proposal_id);
        let mut proposal: ClawbackProposal = env
            .storage()
            .persistent()
            .get(&prop_key)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::ClawbackNotFound));

        if proposal.executed {
            panic_with_error!(&env, TokenError::ClawbackAlreadyExecuted);
        }

        let required = Self::get_required_approvals(&env);
        if proposal.approvals.len() < required {
            panic_with_error!(&env, TokenError::ClawbackInsufficientApprovals);
        }

        let elapsed = env
            .ledger()
            .sequence()
            .saturating_sub(proposal.created_ledger);
        if elapsed < CLAWBACK_DELAY_LEDGERS {
            panic_with_error!(&env, TokenError::ClawbackNotReady);
        }

        let period_total = Self::get_clawback_period_total(&env);
        let new_total = period_total
            .checked_add(proposal.amount)
            .unwrap_or_else(|| {
                panic_with_error!(&env, TokenError::Overflow);
            });

        let period_limit: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::ClawbackPeriodLimit)
            .unwrap_or(i128::MAX);
        if new_total > period_limit {
            panic_with_error!(&env, TokenError::ClawbackPeriodLimitExceeded);
        }

        Self::set_clawback_period_total(&env, new_total);

        Self::spend_balance(&env, &proposal.target, proposal.amount);
        let new_supply = Self::decrement_supply(&env, proposal.amount);

        proposal.executed = true;
        env.storage().persistent().set(&prop_key, &proposal);
        Self::bump_persistent(&env, &prop_key);

        Self::store_clawback_record(
            &env,
            &proposal.target,
            proposal.amount,
            &proposal.reason,
            &executor,
        );

        ClawbackExecuted {
            target: proposal.target,
            amount: proposal.amount,
            reason: proposal.reason,
            executor,
            new_supply,
        }
        .publish(&env);
    }

    fn get_clawback_period_total(env: &Env) -> i128 {
        let start_key = DataKey::ClawbackPeriodStart;
        let period_start: u32 = env.storage().persistent().get(&start_key).unwrap_or(0);

        let current = env.ledger().sequence();
        if current >= period_start && (current - period_start) > CLAWBACK_PERIOD_LEDGERS {
            let total_key = DataKey::ClawbackPeriodTotal;
            env.storage().persistent().remove(&total_key);
            env.storage().persistent().remove(&start_key);
            0
        } else {
            let total_key = DataKey::ClawbackPeriodTotal;
            env.storage().persistent().get(&total_key).unwrap_or(0)
        }
    }

    fn set_clawback_period_total(env: &Env, total: i128) {
        let total_key = DataKey::ClawbackPeriodTotal;
        env.storage().persistent().set(&total_key, &total);
        Self::bump_persistent(env, &total_key);

        let start_key = DataKey::ClawbackPeriodStart;
        if !env.storage().persistent().has(&start_key) {
            env.storage()
                .persistent()
                .set(&start_key, &env.ledger().sequence());
            Self::bump_persistent(env, &start_key);
        }
    }

    fn store_clawback_record(
        env: &Env,
        target: &Address,
        amount: i128,
        reason: &String,
        executor: &Address,
    ) {
        let count_key = DataKey::ClawbackHistoryCount;
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        let new_count = count.checked_add(1).unwrap_or_else(|| {
            panic_with_error!(env, TokenError::Overflow);
        });

        let record = ClawbackRecord {
            target: target.clone(),
            amount,
            reason: reason.clone(),
            executor: executor.clone(),
            ledger: env.ledger().sequence(),
        };

        let record_key = DataKey::ClawbackRecord(new_count);
        env.storage().persistent().set(&record_key, &record);
        Self::bump_persistent(env, &record_key);

        env.storage().persistent().set(&count_key, &new_count);
        Self::bump_persistent(env, &count_key);
    }

    pub fn get_clawback_history(env: Env, count: u32) -> Vec<ClawbackRecord> {
        Self::bump_instance(&env);
        let total: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::ClawbackHistoryCount)
            .unwrap_or(0);
        let mut records = Vec::new(&env);
        let start = total.saturating_sub(count);
        for i in (start + 1)..=total {
            let key = DataKey::ClawbackRecord(i);
            if let Some(record) = env.storage().persistent().get::<_, ClawbackRecord>(&key) {
                records.push_back(record);
            }
        }
        records
    }

    pub fn get_clawback_proposal(env: Env, proposal_id: u32) -> ClawbackProposal {
        Self::bump_instance(&env);
        let prop_key = DataKey::ClawbackProposal(proposal_id);
        env.storage()
            .persistent()
            .get(&prop_key)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::ClawbackNotFound))
    }

    pub fn set_clawback_period_limit(env: Env, limit: i128) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        Self::bump_instance(&env);

        let key = DataKey::ClawbackPeriodLimit;
        env.storage().persistent().set(&key, &limit);
        Self::bump_persistent(&env, &key);
    }

    pub fn get_clawback_period_limit(env: Env) -> i128 {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::ClawbackPeriodLimit)
            .unwrap_or(i128::MAX)
    }

    // ── Token Permit (Issue #105) ───────────────────────────────────────────

    fn get_nonce(env: &Env, owner: &Address) -> u32 {
        let key = DataKey::Nonce(owner.clone());
        env.storage().persistent().get(&key).unwrap_or(0)
    }

    fn increment_nonce(env: &Env, owner: &Address) -> u32 {
        let current = Self::get_nonce(env, owner);
        let new = current.checked_add(1).unwrap_or_else(|| {
            panic_with_error!(env, TokenError::Overflow);
        });
        let key = DataKey::Nonce(owner.clone());
        env.storage().persistent().set(&key, &new);
        Self::bump_persistent(env, &key);
        new
    }

    fn address_to_32bytes(env: &Env, address: &Address) -> [u8; 32] {
        use soroban_sdk::xdr::ToXdr;
        let xdr_bytes = address.to_xdr(env);
        let mut buf = [0u8; 64];
        let len = xdr_bytes.len() as usize;
        xdr_bytes.copy_into_slice(&mut buf[..len]);
        let mut key = [0u8; 32];
        if len == 44 {
            // Account address: ScVal::Address(ScAddress::Account(Uint256))
            key.copy_from_slice(&buf[12..44]);
        } else if len == 40 {
            // Contract address: ScVal::Address(ScAddress::Contract(Hash))
            key.copy_from_slice(&buf[8..40]);
        } else {
            panic!("unsupported address XDR length");
        }
        key
    }

    fn build_permit_digest(
        env: &Env,
        owner: &Address,
        spender: &Address,
        amount: i128,
        nonce: u32,
        deadline: u64,
    ) -> Bytes {
        let contract_key = Self::address_to_32bytes(env, &env.current_contract_address());
        let owner_key = Self::address_to_32bytes(env, owner);
        let spender_key = Self::address_to_32bytes(env, spender);

        let mut data = Bytes::new(env);
        data.extend_from_slice(&contract_key);
        data.extend_from_slice(&owner_key);
        data.extend_from_slice(&spender_key);
        let amount_bytes = amount.to_be_bytes();
        data.extend_from_slice(&amount_bytes);
        let nonce_bytes = nonce.to_be_bytes();
        data.extend_from_slice(&nonce_bytes);
        let deadline_bytes = deadline.to_be_bytes();
        data.extend_from_slice(&deadline_bytes);
        data
    }

    pub fn nonces(env: Env, owner: Address) -> u32 {
        Self::bump_instance(&env);
        Self::get_nonce(&env, &owner)
    }

    pub fn permit(
        env: Env,
        owner: Address,
        spender: Address,
        amount: i128,
        deadline: u64,
        signature: BytesN<64>,
    ) {
        Self::bump_instance(&env);

        if amount < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        if env.ledger().timestamp() > deadline {
            panic_with_error!(&env, TokenError::PermitExpired);
        }

        let nonce = Self::get_nonce(&env, &owner);
        let digest = Self::build_permit_digest(&env, &owner, &spender, amount, nonce, deadline);

        let owner_key_bytes = Self::address_to_32bytes(&env, &owner);
        let pk = BytesN::from_array(&env, &owner_key_bytes);

        env.crypto().ed25519_verify(&pk, &digest, &signature);

        Self::increment_nonce(&env, &owner);

        let current = read_allowance_amount(&env, owner.clone(), spender.clone());
        if current != 0 && amount != 0 && current != amount {
            panic_with_error!(&env, TokenError::AllowanceRaceRejected);
        }

        write_allowance(&env, owner.clone(), spender.clone(), amount, 0);

        ApproveEvent {
            from: owner,
            spender,
            amount,
            expiration_ledger: 0,
        }
        .publish(&env);
    }

    pub fn transfer_with_permit(
        env: Env,
        owner: Address,
        spender: Address,
        to: Address,
        amount: i128,
        deadline: u64,
        signature: BytesN<64>,
    ) {
        Self::permit(
            env.clone(),
            owner.clone(),
            spender.clone(),
            amount,
            deadline,
            signature,
        );

        Self::spend_allowance(&env, &owner, &spender, amount);
        Self::xfer(&env, &owner, &to, amount);

        TransferEvent {
            from: owner,
            to,
            amount,
        }
        .publish(&env);
    }

    // ── Storage TTL (Issue #112) ────────────────────────────────────────────
    //
    // Admin/name/symbol/decimals already live in instance storage (see
    // `initialize`), and allowance TTL already tracks `expiration_ledger`
    // (see `allowance.rs::write_allowance`) — both were already correct
    // before this change. What was missing: balances only get their
    // persistent TTL extended as a side effect of a transfer/mint/burn
    // touching that address. A holder who wants to keep their balance alive
    // without transacting (e.g. to outlast the archival threshold) had no
    // way to do that. This adds that self-serve renewal.

    /// Extend the caller's own balance entry TTL without moving any funds.
    /// No-op (does not error) if the caller has no balance entry yet.
    pub fn extend_balance_ttl(env: Env, id: Address) {
        id.require_auth();
        let key = DataKey::Balance(id);
        if env.storage().persistent().has(&key) {
            Self::bump_persistent(&env, &key);
        }
    }

    // ── Vote delegation registry (Issue #101, phase 1) ──────────────────────
    //
    // This is intentionally scoped down from the full proposal in #101.
    // Correct *effective voting power* has to stay in sync with every
    // balance-changing call (transfer/mint/burn/clawback) — the same
    // problem `Checkpoints` already solves for balances (see
    // `create_checkpoint`, issue #106). Wiring delegation into that hot
    // path, plus transitive-delegation cycle detection, plus the voting
    // contract's eligibility snapshot, is real, security-sensitive surgery
    // that deserves its own careful PR and tests rather than being rushed
    // in alongside three other issues. What ships here is the safe,
    // additive part: a delegator -> delegatee registry that the voting
    // power computation can be built on top of next. `get_delegate`/
    // `delegate`/`undelegate` do not currently affect `balance_of` or any
    // voting contract's eligibility check.
    pub fn delegate(env: Env, delegator: Address, delegatee: Address) {
        delegator.require_auth();
        if delegator == delegatee {
            panic_with_error!(&env, TokenError::SelfDelegation);
        }
        Self::bump_instance(&env);

        let key = DataKey::Delegate(delegator.clone());
        let previous: Option<Address> = env.storage().persistent().get(&key);
        env.storage().persistent().set(&key, &delegatee);
        Self::bump_persistent(&env, &key);

        DelegateChanged {
            delegator,
            from_delegatee: previous,
            to_delegatee: Some(delegatee),
        }
        .publish(&env);
    }

    pub fn undelegate(env: Env, delegator: Address) {
        delegator.require_auth();
        Self::bump_instance(&env);

        let key = DataKey::Delegate(delegator.clone());
        let previous: Option<Address> = env.storage().persistent().get(&key);
        if previous.is_none() {
            return;
        }
        env.storage().persistent().remove(&key);

        DelegateChanged {
            delegator,
            from_delegatee: previous,
            to_delegatee: None,
        }
        .publish(&env);
    }

    /// Returns the address `holder` currently delegates to, or `None` if
    /// they have not delegated (i.e. they vote with their own balance).
    pub fn get_delegate(env: Env, holder: Address) -> Option<Address> {
        Self::bump_instance(&env);
        env.storage().persistent().get(&DataKey::Delegate(holder))
    }

    // ── Batch Operations (Issue #110) ───────────────────────────────────────
    //
    // Soroban already guarantees whole-invocation atomicity at the host
    // level (a panic anywhere reverts every storage write made during that
    // call) — these functions don't need to invent atomicity themselves.
    // What they add on top of that guarantee: an explicit up-front
    // validation pass (so a batch fails fast with one clear error instead
    // of failing partway through on whichever item happens to run out of
    // balance/allowance first), a hard batch-size cap (DoS/resource-limit
    // guard), and one event per item so indexers see the same event shape
    // they'd see from `MAX_BATCH_SIZE` individual calls.

    /// Batch transfer: `from` sends multiple (recipient, amount) pairs in
    /// one call. Validates every pair and the total against `from`'s
    /// current balance before moving any funds.
    pub fn batch_transfer(env: Env, from: Address, transfers: Vec<(Address, i128)>) {
        from.require_auth();
        Self::bump_instance(&env);

        let len = transfers.len();
        if len == 0 {
            panic_with_error!(&env, TokenError::EmptyBatch);
        }
        if len > MAX_BATCH_SIZE {
            panic_with_error!(&env, TokenError::BatchTooLarge);
        }

        // ── Validate all parameters before executing any ───────────────────
        let mut total: i128 = 0;
        for (_, amount) in transfers.iter() {
            if amount < 0 {
                panic_with_error!(&env, TokenError::InvalidAmount);
            }
            total = total.checked_add(amount).unwrap_or_else(|| {
                panic_with_error!(&env, TokenError::Overflow);
            });
        }

        let balance_key = DataKey::Balance(from.clone());
        let current_balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        if current_balance < total {
            panic_with_error!(&env, TokenError::InsufficientBalance);
        }

        // ── Execute, emitting one event per item ────────────────────────────
        for (to, amount) in transfers.iter() {
            Self::xfer(&env, &from, &to, amount);
            TransferEvent {
                from: from.clone(),
                to: to.clone(),
                amount,
            }
            .publish(&env);
        }
    }

    /// Batch mint (airdrops): admin mints multiple (recipient, amount)
    /// pairs in one call. Validates the total against the supply cap (if
    /// set) before minting any.
    pub fn batch_mint(env: Env, mints: Vec<(Address, i128)>) {
        let admin: Address = Self::admin(env.clone());
        admin.require_auth();
        Self::bump_instance(&env);

        let len = mints.len();
        if len == 0 {
            panic_with_error!(&env, TokenError::EmptyBatch);
        }
        if len > MAX_BATCH_SIZE {
            panic_with_error!(&env, TokenError::BatchTooLarge);
        }

        // ── Validate all parameters before executing any ───────────────────
        let mut total: i128 = 0;
        for (_, amount) in mints.iter() {
            if amount < 0 {
                panic_with_error!(&env, TokenError::InvalidAmount);
            }
            total = total.checked_add(amount).unwrap_or_else(|| {
                panic_with_error!(&env, TokenError::Overflow);
            });
        }

        if let Some(cap) = Self::get_max_supply_storage(&env) {
            let current = Self::get_supply(&env);
            let new_supply = current.checked_add(total).unwrap_or_else(|| {
                panic_with_error!(&env, TokenError::Overflow);
            });
            if new_supply > cap {
                panic_with_error!(&env, TokenError::SupplyCapExceeded);
            }
        }

        // ── Execute, emitting one event per item ────────────────────────────
        for (to, amount) in mints.iter() {
            Self::receive_balance(&env, &to, amount);
            Self::increment_supply(&env, amount);
            MintEvent {
                admin: admin.clone(),
                to: to.clone(),
                amount,
            }
            .publish(&env);
        }
    }

    /// Batch approve: `from` sets multiple (spender, amount,
    /// expiration_ledger) allowances in one call. Each entry is validated
    /// independently (approvals don't move funds, so there's no shared
    /// "total" to check against a balance) — but the same race-rejection
    /// rule as `approve` applies per spender.
    pub fn batch_approve(env: Env, from: Address, approvals: Vec<(Address, i128, u32)>) {
        from.require_auth();
        Self::bump_instance(&env);

        let len = approvals.len();
        if len == 0 {
            panic_with_error!(&env, TokenError::EmptyBatch);
        }
        if len > MAX_BATCH_SIZE {
            panic_with_error!(&env, TokenError::BatchTooLarge);
        }

        // ── Validate all parameters before executing any ───────────────────
        for (spender, amount, _expiration_ledger) in approvals.iter() {
            if amount < 0 {
                panic_with_error!(&env, TokenError::NegativeAllowance);
            }
            let current = read_allowance_amount(&env, from.clone(), spender.clone());
            let is_race_rejected = current != 0 && amount != 0 && current != amount;
            if is_race_rejected {
                panic_with_error!(&env, TokenError::AllowanceRaceRejected);
            }
        }

        // ── Execute, emitting one event per item ────────────────────────────
        for (spender, amount, expiration_ledger) in approvals.iter() {
            write_allowance(
                &env,
                from.clone(),
                spender.clone(),
                amount,
                expiration_ledger,
            );
            ApproveEvent {
                from: from.clone(),
                spender: spender.clone(),
                amount,
                expiration_ledger,
            }
            .publish(&env);
        }
    }

    /// Shield transparent tokens into the confidential DAO treasury pool
    pub fn shield(env: Env, from: Address, amount: i128, note_commitment: BytesN<32>) {
        from.require_auth();
        Self::bump_instance(&env);

        if amount <= 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            panic_with_error!(&env, TokenError::InsufficientBalance);
        }

        // Deduct from transparent balance
        Self::write_balance(&env, from.clone(), from_balance - amount);
        Self::append_checkpoint(&env, from.clone(), from_balance - amount);

        // Credit to shielded pool
        let pool_balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::ShieldedPoolBalance)
            .unwrap_or(0);
        let new_pool_balance = pool_balance
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::Overflow));
        env.storage()
            .persistent()
            .set(&DataKey::ShieldedPoolBalance, &new_pool_balance);

        // Record note commitment in sequence
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::ShieldedCommitmentCount)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::ShieldedCommitment(count), &note_commitment);
        env.storage()
            .persistent()
            .set(&DataKey::ShieldedCommitmentCount, &(count + 1));

        ShieldEvent {
            from,
            amount,
            commitment: note_commitment,
        }
        .publish(&env);
    }

    /// Execute a shielded UTXO transfer
    pub fn transfer_shielded(
        env: Env,
        nullifiers: Vec<BytesN<32>>,
        commitments: Vec<BytesN<32>>,
        public_fee: i128,
    ) {
        Self::bump_instance(&env);

        if public_fee < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        // Validate and spend nullifiers
        for nullifier in nullifiers.iter() {
            let key = DataKey::NullifierSpent(nullifier.clone());
            if env.storage().persistent().has(&key) {
                panic_with_error!(&env, TokenError::NullifierAlreadySpent);
            }
            env.storage().persistent().set(&key, &true);
        }

        // Append new note commitments
        let mut count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::ShieldedCommitmentCount)
            .unwrap_or(0);

        for commitment in commitments.iter() {
            env.storage()
                .persistent()
                .set(&DataKey::ShieldedCommitment(count), &commitment);
            count += 1;
        }
        env.storage()
            .persistent()
            .set(&DataKey::ShieldedCommitmentCount, &count);

        if public_fee > 0 {
            let pool_balance: i128 = env
                .storage()
                .persistent()
                .get(&DataKey::ShieldedPoolBalance)
                .unwrap_or(0);
            if pool_balance < public_fee {
                panic_with_error!(&env, TokenError::ShieldedPoolExhausted);
            }
            env.storage().persistent().set(
                &DataKey::ShieldedPoolBalance,
                &(pool_balance - public_fee),
            );
        }

        ShieldedTransferEvent {
            commitment_count: commitments.len(),
            public_fee,
        }
        .publish(&env);
    }

    /// Unshield confidential notes back to a transparent address
    pub fn unshield(
        env: Env,
        to: Address,
        amount: i128,
        nullifier: BytesN<32>,
        remainder_commitment: BytesN<32>,
    ) {
        Self::bump_instance(&env);

        if amount <= 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        let pool_balance: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::ShieldedPoolBalance)
            .unwrap_or(0);
        if pool_balance < amount {
            panic_with_error!(&env, TokenError::ShieldedPoolExhausted);
        }

        let key = DataKey::NullifierSpent(nullifier.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, TokenError::NullifierAlreadySpent);
        }
        env.storage().persistent().set(&key, &true);

        // Insert remainder change commitment if any
        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::ShieldedCommitmentCount)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::ShieldedCommitment(count), &remainder_commitment);
        env.storage()
            .persistent()
            .set(&DataKey::ShieldedCommitmentCount, &(count + 1));

        // Deduct from pool balance and credit recipient transparent balance
        env.storage()
            .persistent()
            .set(&DataKey::ShieldedPoolBalance, &(pool_balance - amount));

        let to_balance = Self::balance(env.clone(), to.clone());
        let new_balance = to_balance
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::Overflow));
        Self::write_balance(&env, to.clone(), new_balance);
        Self::append_checkpoint(&env, to.clone(), new_balance);

        UnshieldEvent {
            to,
            amount,
            nullifier,
        }
        .publish(&env);
    }

    /// Read the total confidential balance in the shielded pool
    pub fn get_shielded_pool_balance(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::ShieldedPoolBalance)
            .unwrap_or(0)
    }

    /// Query whether a nullifier has already been spent
    pub fn is_nullifier_spent(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::NullifierSpent(nullifier))
    }
}

#[cfg(test)]
mod test;
