//! # ZKVote Bridge Contract (Soroban)
//!
//! Receives forwarded votes from the EVM bridge contract via an authorized
//! relayer, checks nullifiers against the voting contract, and records votes
//! via `record_bridged_vote` on the voting contract.
//!
//! ## Flow
//! 1. User generates Groth16 proof on EVM side
//! 2. EVM Bridge contract verifies proof, emits VoteForwarded event
//! 3. Authorized relayer watches EVM, calls this contract to relay the vote
//! 4. This contract checks nullifier against voting contract
//! 5. If valid, invokes voting.record_bridged_vote to update tallies
//!
//! ## Security
//! - Nullifier check prevents double-voting across chains
//! - Only allowlisted relayers can submit votes (#648)
//! - Vote is recorded in the voting contract for consistency (#648)

#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, IntoVal, Symbol, U256,
};

const VOTING_CONTRACT: Symbol = symbol_short!("voting");
const ADMIN: Symbol = symbol_short!("admin");
const VERSION: u32 = 1;
const VERSION_KEY: Symbol = symbol_short!("ver");

// TTL management
const INSTANCE_TTL_THRESHOLD: u32 = 120_960; // ~7 days
const INSTANCE_TTL_EXTEND: u32 = 535_680; // ~31 days
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum BridgeError {
    AlreadyInitialized = 1,
    NotAdmin = 2,
    NullifierAlreadyUsed = 3,
    VotingContractNotSet = 4,
    InvalidVoteChoice = 5,
    VoteRecordingFailed = 6,
    NullifierCheckFailed = 7,
    UnauthorizedRelayer = 8,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Nullifier(u64, u64, U256),    // (dao_id, proposal_id, nullifier) -> bool
    VoteRecorded(u64, u64, U256), // (dao_id, proposal_id, nullifier) -> bool
    Relayer(Address),             // authorized relayer -> bool
}

// Typed Events
#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct VoteRelayedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub nullifier: U256,
    pub vote_choice: bool,
    pub vote_root: U256,
    pub relayed_by: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgraded {
    pub from: u32,
    pub to: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct RelayerUpdatedEvent {
    pub relayer: Address,
    pub authorized: bool,
}

#[contract]
pub struct Bridge;

#[contractimpl]
impl Bridge {
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

    fn assert_admin(env: &Env, admin: &Address) {
        admin.require_auth();
        let configured: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .unwrap_or_else(|| panic_with_error!(env, BridgeError::NotAdmin));
        if admin != &configured {
            panic_with_error!(env, BridgeError::NotAdmin);
        }
    }

    fn assert_authorized_relayer(env: &Env, relayer: &Address) {
        let key = DataKey::Relayer(relayer.clone());
        let authorized: bool = env.storage().persistent().get(&key).unwrap_or(false);
        if !authorized {
            panic_with_error!(env, BridgeError::UnauthorizedRelayer);
        }
    }

    /// Constructor: Initialize with voting contract, admin, and initial relayer
    pub fn __constructor(env: Env, voting_contract: Address, admin: Address, relayer: Address) {
        if env.storage().instance().has(&VERSION_KEY) {
            panic_with_error!(&env, BridgeError::AlreadyInitialized);
        }
        env.storage().instance().set(&VERSION_KEY, &VERSION);
        ContractUpgraded {
            from: 0,
            to: VERSION,
        }
        .publish(&env);

        env.storage()
            .instance()
            .set(&VOTING_CONTRACT, &voting_contract);
        env.storage().instance().set(&ADMIN, &admin);

        let relayer_key = DataKey::Relayer(relayer.clone());
        env.storage().persistent().set(&relayer_key, &true);
        Self::bump_persistent(&env, &relayer_key);
        RelayerUpdatedEvent {
            relayer,
            authorized: true,
        }
        .publish(&env);
    }

    /// Admin: authorize or revoke a relayer (#648)
    pub fn set_relayer(env: Env, admin: Address, relayer: Address, authorized: bool) {
        Self::bump_instance(&env);
        Self::assert_admin(&env, &admin);
        let key = DataKey::Relayer(relayer.clone());
        if authorized {
            env.storage().persistent().set(&key, &true);
            Self::bump_persistent(&env, &key);
        } else {
            env.storage().persistent().remove(&key);
        }
        RelayerUpdatedEvent {
            relayer,
            authorized,
        }
        .publish(&env);
    }

    /// Relay a vote from EVM to Soroban
    ///
    /// Called by an authorized relayer after observing VoteForwarded on EVM.
    /// Records the vote in the voting contract via `record_bridged_vote` (#648).
    pub fn relay_vote(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool,
        nullifier: U256,
        vote_root: U256,
        relayer: Address,
    ) {
        Self::bump_instance(&env);
        relayer.require_auth();
        Self::assert_authorized_relayer(&env, &relayer);

        // Validate nullifier is non-zero
        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, BridgeError::InvalidVoteChoice);
        }

        // Check nullifier hasn't been used in the BRIDGE's own state
        let null_key = DataKey::Nullifier(dao_id, proposal_id, nullifier.clone());
        if env.storage().persistent().has(&null_key) {
            panic_with_error!(&env, BridgeError::NullifierAlreadyUsed);
        }

        let voting_addr: Address = env
            .storage()
            .instance()
            .get(&VOTING_CONTRACT)
            .unwrap_or_else(|| panic_with_error!(&env, BridgeError::VotingContractNotSet));

        // Cross-check voting-contract nullifier to prevent native+bridge double vote
        let already_used: bool = env.invoke_contract(
            &voting_addr,
            &Symbol::new(&env, "is_nullifier_used"),
            soroban_sdk::vec![
                &env,
                dao_id.into_val(&env),
                proposal_id.into_val(&env),
                nullifier.clone().into_val(&env),
            ],
        );
        if already_used {
            panic_with_error!(&env, BridgeError::NullifierAlreadyUsed);
        }

        // Mark bridge nullifier BEFORE cross-contract write (checks-effects)
        env.storage().persistent().set(&null_key, &true);
        Self::bump_persistent(&env, &null_key);

        let record_key = DataKey::VoteRecorded(dao_id, proposal_id, nullifier.clone());
        env.storage().persistent().set(&record_key, &true);
        Self::bump_persistent(&env, &record_key);

        // Record the vote in the voting contract (updates tallies + voting nullifier)
        // If this panics, the whole tx rolls back including bridge nullifier write.
        let _: () = env.invoke_contract(
            &voting_addr,
            &Symbol::new(&env, "record_bridged_vote"),
            soroban_sdk::vec![
                &env,
                dao_id.into_val(&env),
                proposal_id.into_val(&env),
                vote_choice.into_val(&env),
                nullifier.clone().into_val(&env),
                vote_root.clone().into_val(&env),
            ],
        );

        VoteRelayedEvent {
            dao_id,
            proposal_id,
            nullifier,
            vote_choice,
            vote_root,
            relayed_by: relayer,
        }
        .publish(&env);
    }

    /// Check if a nullifier has been used (for cross-chain verification)
    pub fn is_nullifier_used(env: Env, dao_id: u64, proposal_id: u64, nullifier: U256) -> bool {
        Self::bump_instance(&env);
        let key = DataKey::Nullifier(dao_id, proposal_id, nullifier);
        env.storage().persistent().has(&key)
    }

    /// Get voting contract address
    pub fn voting_contract(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&VOTING_CONTRACT)
            .unwrap_or_else(|| panic_with_error!(&env, BridgeError::VotingContractNotSet))
    }

    pub fn is_relayer(env: Env, relayer: Address) -> bool {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::Relayer(relayer))
            .unwrap_or(false)
    }

    /// Contract version for upgrade tracking
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
