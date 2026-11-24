//! # Anonymous DAO Voting Contract
//!
//! This contract implements anonymous voting for DAOs using Groth16 zero-knowledge proofs
//! on the BN254 elliptic curve (also known as alt_bn128).
//!
//! ## Cryptographic Primitives
//!
//! ### BN254 Curve (alt_bn128)
//! - **Definition**: y² = x³ + 3 over 𝔽_p where p = 21888242871839275222246405745257275088696311157297823662689037894645226208583
//! - **Order**: r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
//! - **Embedding degree**: 12
//! - **G1 cofactor**: 1 (prime order subgroup)
//! - **G2 cofactor**: 21888242871839275222246405745257275088844257914179612981679871602714643921549
//!
//! **Standards**:
//! - [EIP-196](https://eips.ethereum.org/EIPS/eip-196) - Precompiled contracts for addition and scalar multiplication on BN254 G1
//! - [EIP-197](https://eips.ethereum.org/EIPS/eip-197) - Precompiled contracts for pairing checks on BN254
//! - [BN254 For The Rest Of Us](https://hackmd.io/@jpw/bn254) - Technical deep dive
//!
//! ### Groth16 SNARK
//! - **Paper**: "On the Size of Pairing-based Non-interactive Arguments" by Jens Groth (2016)
//! - **DOI**: [10.1007/978-3-662-49896-5_11](https://doi.org/10.1007/978-3-662-49896-5_11)
//! - **Implementation**: Uses snarkjs for proof generation, Soroban BN254 host functions for verification
//!
//! ## Point Validation & Security
//!
//! See documentation in `set_vk()` for detailed point validation strategy.

#![no_std]
#![allow(clippy::too_many_arguments)]

mod storage;
use soroban_sdk::xdr::ToXdr;
mod stark_verifier;
#[allow(unused_imports)]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254G1Affine, Bn254G2Affine, Fr},
    panic_with_error, symbol_short, Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Vec,
    U256,
};

// Re-export shared Groth16 types and utilities
pub use zkvote_groth16::{
    Bls12381Curve, CurveId, Groth16Error, PathContext, Proof, ProofBls381, VerificationKey,
    VerificationKeyBls381,
};

// ZK quadratic voting with range proofs (issue #50)
mod quadratic;

// Sybil-resistance: SBT-age weighting + reputation score (issue #301)
mod sybil;

// VDF-gated vote commit–reveal (issue #302)
mod commit_reveal;

// Anonymous vote delegation / liquid democracy (issue #304) is declared in the
// tracker but has no implementation in this tree: `delegation.rs` has never
// existed on any branch and nothing references `delegation::`. The module
// declaration is left out until the implementation lands, so the crate builds.

// ── Module decomposition ─────────────────────────────────────────────────────
// Shared types, storage keys and error codes live in `types`; typed events in
// `events`. Both are re-exported at the crate root so every pre-existing path
// (`crate::VotingError`, `voting::DataKey`, ...) keeps resolving unchanged.
mod events;
mod types;
mod admin;
mod encrypted_tally;
mod migrations;
mod tally;
mod vote_submission;

#[cfg(test)]
mod storage_layout_test;

pub use crate::events::*;
pub use crate::types::*;

/// Panic with a coarse version of `err` on an anonymous path, or the specific
/// error on an admin path. Shorthand for
/// `panic_with_error!(env, err.to_coarse(ctx))`.
#[inline]
pub(crate) fn panic_coarse(env: &Env, ctx: PathContext, err: VotingError) -> ! {
    panic_with_error!(env, err.to_coarse(ctx));
}


#[contract]
pub struct Voting;

#[contractimpl]
impl Voting {

    pub(crate) fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    pub(crate) fn bump_persistent<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }

    pub(crate) fn bump_temporary<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
        env.storage().temporary().extend_ttl(
            key,
            TEMPORARY_TTL_THRESHOLD,
            TEMPORARY_TTL_EXTEND_BASE,
        );
    }

    /// Bump nullifier TTL with proposal-end-time-aware extend amount.
    /// Temporary storage lives until `end_time + NULLIFIER_GRACE_LEDGERS`.
    /// For proposals with no end_time (end_time=0) use the base 72h window.
    pub(crate) fn bump_nullifier_ttl<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(
        env: &Env,
        key: &K,
        dao_id: u64,
        proposal_id: u64,
    ) {
        let end_time = Self::get_proposal_end_time_internal(env, dao_id, proposal_id);
        let ledger_timestamp = env.ledger().timestamp();
        let ttl_extend: u32 = if end_time == 0 {
            TEMPORARY_TTL_EXTEND_BASE
        } else {
            let remaining_secs = end_time.saturating_sub(ledger_timestamp);
            let remaining_ledgers: u32 = (remaining_secs / 5).try_into().unwrap_or(u32::MAX);
            remaining_ledgers.saturating_add(NULLIFIER_GRACE_LEDGERS)
        };
        let ttl_extend = ttl_extend.max(TEMPORARY_TTL_EXTEND_BASE);
        env.storage()
            .temporary()
            .extend_ttl(key, TEMPORARY_TTL_THRESHOLD, ttl_extend);
    }

    /// Constructor: Initialize contract with MembershipTree address
    pub fn __constructor(env: Env, tree_contract: Address, registry: Address, guardian: Address) {
        crate::migrations::__constructor(env, tree_contract, registry, guardian);
    }


    pub(crate) fn require_guardian(env: &Env, guardian: &Address) {
        let configured: Address = env
            .storage()
            .instance()
            .get(&DataKey::Guardian)
            .unwrap_or_else(|| panic_with_error!(env, VotingError::NotGuardian));
        if &configured != guardian {
            panic_with_error!(env, VotingError::NotGuardian);
        }
    }

    pub(crate) fn require_registry(env: &Env) {
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();
        registry.require_auth();
    }

    pub(crate) fn require_not_paused(env: &Env) {
        if !env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            return;
        }

        let paused_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PausedAt)
            .unwrap_or(0);
        if env.ledger().timestamp() >= paused_at.saturating_add(MAX_PAUSE_DURATION) {
            env.storage().instance().set(&DataKey::Paused, &false);
            let guardian: Address = env.storage().instance().get(&DataKey::Guardian).unwrap();
            ContractUnpausedEvent { guardian }.publish(env);
            return;
        }
        panic_with_error!(env, VotingError::ContractPaused);
    }

    pub fn set_guardian(env: Env, current_guardian: Address, new_guardian: Address) {
        crate::admin::set_guardian(env, current_guardian, new_guardian);
    }


    pub fn guardian(env: Env) -> Address {
        crate::admin::guardian(env)
    }


    /// Current persistent storage layout version.
    pub fn storage_version(env: Env) -> u32 {
        crate::migrations::storage_version(env)
    }


    /// Version negotiation metadata for clients before submitting transactions.
    pub fn storage_layout(env: Env) -> StorageLayoutInfo {
        crate::migrations::storage_layout(env)
    }


    /// Return a migration record by upgraded contract version.
    pub fn migration_for_version(env: Env, version: u32) -> Option<ContractMigrationInfo> {
        crate::migrations::migration_for_version(env, version)
    }


    /// Registry-gated upgrade entrypoint.
    ///
    /// The registry enforces DAO-admin governance and the timelock. This hook
    /// verifies the expected current version, records storage migration
    /// metadata, then swaps this contract's Wasm.
    pub fn apply_upgrade_from_registry(
        env: Env,
        wasm_hash: BytesN<32>,
        from_version: u32,
        to_version: u32,
        storage_version: u32,
        migration_payload: Bytes,
    ) {
        crate::migrations::apply_upgrade_from_registry(env, wasm_hash, from_version, to_version, storage_version, migration_payload);
    }


    /// Registry-gated rollback entrypoint using a pre-approved rollback Wasm.
    pub fn rollback_upgrade_from_registry(
        env: Env,
        wasm_hash: BytesN<32>,
        from_version: u32,
        to_version: u32,
    ) {
        crate::migrations::rollback_upgrade_from_registry(env, wasm_hash, from_version, to_version);
    }


    pub fn pause(env: Env, guardian: Address) {
        crate::admin::pause(env, guardian);
    }


    pub fn unpause(env: Env, guardian: Address) {
        crate::admin::unpause(env, guardian);
    }


    pub fn is_paused(env: Env) -> bool {
        crate::admin::is_paused(env)
    }


    /// Validate that a U256 value is within the BN254 scalar field (< r).
    /// Panics with a coarse-mapped [`VotingError::SignalNotInField`] under
    /// [`PathContext::Anonymous`].
    pub(crate) fn assert_in_field(env: &Env, ctx: PathContext, value: &U256) {
        if zkvote_groth16::assert_in_field(env, value).is_err() {
            panic_coarse(env, ctx, VotingError::SignalNotInField);
        }
    }

    /// Validate that a U256 value is within the BLS12-381 scalar field.
    pub(crate) fn assert_in_field_bls381(env: &Env, ctx: PathContext, value: &U256) {
        if zkvote_groth16::assert_in_field_bls381(env, value).is_err() {
            panic_coarse(env, ctx, VotingError::SignalNotInField);
        }
    }

    /// Read the curve ID for a DAO (defaults to Bn254)
    pub(crate) fn get_curve_id(env: &Env, dao_id: u64) -> CurveId {
        env.storage()
            .persistent()
            .get(&DataKey::CurveId(dao_id))
            .unwrap_or(CurveId::Bn254)
    }

    /// Set verification key for a DAO (admin only)
    pub fn set_vk(env: Env, dao_id: u64, vk: VerificationKey, admin: Address) {
        crate::admin::set_vk(env, dao_id, vk, admin);
    }


    /// Set verification key with explicit MPC transcript hash attestation
    pub fn set_vk_with_transcript(
        env: Env,
        dao_id: u64,
        vk: VerificationKey,
        admin: Address,
        transcript_hash: BytesN<32>,
    ) {
        crate::admin::set_vk_with_transcript(env, dao_id, vk, admin, transcript_hash);
    }


    /// Set BLS12-381 verification key for a DAO (admin only)
    pub fn set_vk_bls381(env: Env, dao_id: u64, vk: VerificationKeyBls381, admin: Address) {
        crate::admin::set_vk_bls381(env, dao_id, vk, admin);
    }


    /// Set Nova/SuperNova recursive verification key for a DAO (admin only)
    pub fn set_recursive_vk(env: Env, dao_id: u64, vk_bytes: Bytes, admin: Address) {
        crate::admin::set_recursive_vk(env, dao_id, vk_bytes, admin);
    }


    /// Set the verification key for the tally SNARK circuit (admin only).
    pub fn set_tally_vk(env: Env, dao_id: u64, vk: VerificationKey, admin: Address) {
        crate::admin::set_tally_vk(env, dao_id, vk, admin);
    }


    /// Fetch recursive verification key for a DAO
    pub fn get_recursive_vk(env: Env, dao_id: u64) -> Option<Bytes> {
        crate::admin::get_recursive_vk(env, dao_id)
    }


    /// Submit single aggregated recursive proof attesting to N votes cast in an election
    pub fn submit_recursive_tally(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        num_votes: u64,
        yes_votes: u64,
        no_votes: u64,
        final_nullifier_acc: U256,
        proof: Proof,
    ) -> Result<(), VotingError> {
        crate::tally::submit_recursive_tally(env, dao_id, proposal_id, num_votes, yes_votes, no_votes, final_nullifier_acc, proof)
    }


    /// Fetch recursive tally info for a proposal
    pub fn get_recursive_tally(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> Option<RecursiveTallyInfo> {
        crate::tally::get_recursive_tally(env, dao_id, proposal_id)
    }


    /// Return the raw stored tally proof bytes without verification.
    pub fn get_tally_proof(env: Env, dao_id: u64, proposal_id: u64) -> Option<Bytes> {
        crate::tally::get_tally_proof(env, dao_id, proposal_id)
    }


    /// Return the current nullifier accumulator for an election.
    pub fn get_nullifier_accumulator(env: Env, dao_id: u64, proposal_id: u64) -> U256 {
        crate::tally::get_nullifier_accumulator(env, dao_id, proposal_id)
    }


    /// Update the election nullifier accumulator with a newly used nullifier.
    ///
    /// The accumulator is SHA256(prev_acc || nullifier); the tally SNARK must
    /// reproduce the same final value. This binds the tally proof to the
    /// on-chain nullifier set (issue #94).
    pub(crate) fn accumulate_nullifier(env: &Env, dao_id: u64, proposal_id: u64, nullifier: &U256) {
        let key = DataKey::NullifierAccumulator(dao_id, proposal_id);
        let current: U256 = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(U256::from_u32(env, 0));
        let mut data = Bytes::new(env);
        // Big-endian, matching how U256 is serialised everywhere else in this
        // contract; `to_bytes`/`from_bytes` are not soroban U256 methods.
        data.append(&current.to_be_bytes());
        data.append(&nullifier.to_be_bytes());
        let hash: BytesN<32> = env.crypto().sha256(&data).into();
        let next = U256::from_be_bytes(env, &hash.into());
        env.storage().persistent().set(&key, &next);
        Self::bump_persistent(env, &key);
    }

    /// Verify the tally SNARK proof for a finalized election.
    ///
    /// Recomputes the public signals from the on-chain proposal and recursive
    /// tally, then performs the Groth16 pairing check. A wrong tally, or a
    /// proof for a different election, is rejected with
    /// [`VotingError::TallyProofInvalid`].
    pub fn verify_tally_proof(env: Env, dao_id: u64, proposal_id: u64) -> Result<(), VotingError> {
        crate::tally::verify_tally_proof(env, dao_id, proposal_id)
    }


    pub(crate) fn verify_tally_proof_data(
        env: &Env,
        dao_id: u64,
        proposal_id: u64,
        proof: &Proof,
        num_votes: u64,
        yes_votes: u64,
        no_votes: u64,
        final_nullifier_acc: &U256,
    ) -> Result<(), VotingError> {
        let vk_key = DataKey::TallyVk(dao_id);
        let vk: VerificationKey = env
            .storage()
            .persistent()
            .get(&vk_key)
            .ok_or(VotingError::TallyVkNotSet)?;
        Self::bump_persistent(env, &vk_key);

        if vk.ic.len() != TALLY_CIRCUIT_IC_LEN {
            return Err(VotingError::VkIcLengthMismatch);
        }

        Self::assert_in_field(env, PathContext::Admin, final_nullifier_acc);

        let acc_key = DataKey::NullifierAccumulator(dao_id, proposal_id);
        let expected_acc: U256 = match env.storage().persistent().get(&acc_key) {
            Some(acc) => {
                Self::bump_persistent(env, &acc_key);
                acc
            }
            None => U256::from_u32(env, 0),
        };
        if &expected_acc != final_nullifier_acc {
            return Err(VotingError::TallyProofInvalid);
        }

        let dao_signal = U256::from_u128(env, dao_id as u128);
        let proposal_signal = U256::from_u128(env, proposal_id as u128);
        let num_votes_signal = U256::from_u128(env, num_votes as u128);
        let yes_signal = U256::from_u128(env, yes_votes as u128);
        let no_signal = U256::from_u128(env, no_votes as u128);

        let pub_signals = soroban_sdk::vec![
            env,
            dao_signal,
            proposal_signal,
            num_votes_signal,
            yes_signal,
            no_signal,
            final_nullifier_acc.clone(),
        ];

        if !Self::verify_groth16(env, &vk, proof, &pub_signals) {
            return Err(VotingError::TallyProofInvalid);
        }
        Ok(())
    }

    /// Internal helper to fetch a BN254 VK by version or fail with a clear error
    pub(crate) fn get_vk_by_version(env: &Env, dao_id: u64, version: u32) -> VerificationKey {
        env.storage()
            .persistent()
            .get(&DataKey::VkByVersion(dao_id, version))
            .unwrap_or_else(|| panic_with_error!(env, VotingError::VkVersionMismatch))
    }

    /// Internal helper to fetch a BLS12-381 VK by version or fail with a clear error
    pub(crate) fn get_vk_by_version_bls381(env: &Env, dao_id: u64, version: u32) -> VerificationKeyBls381 {
        env.storage()
            .persistent()
            .get(&DataKey::VkByVersionBls381(dao_id, version))
            .unwrap_or_else(|| panic_with_error!(env, VotingError::VkVersionMismatch))
    }

    pub(crate) fn assert_admin(env: &Env, dao_id: u64, admin: &Address) {
        // Use cached registry address (set at constructor) - only 1 cross-contract call
        let registry: Address = env.storage().instance().get(&REGISTRY).unwrap();

        let dao_admin: Address = env.invoke_contract(
            &registry,
            &symbol_short!("get_admin"),
            soroban_sdk::vec![env, dao_id.into_val(env)],
        );

        if &dao_admin != admin {
            panic_with_error!(env, VotingError::NotAdmin);
        }
    }

    pub(crate) fn validate_vk(env: &Env, vk: &VerificationKey) {
        if vk.ic.len() != VOTE_CIRCUIT_IC_LEN {
            panic_with_error!(env, VotingError::VkIcLengthMismatch);
        }
        if vk.ic.len() > MAX_IC_LENGTH {
            panic_with_error!(env, VotingError::VkIcTooLarge);
        }
    }

    pub(crate) fn validate_vk_bls381(env: &Env, vk: &VerificationKeyBls381) {
        if vk.ic.len() != VOTE_CIRCUIT_IC_LEN {
            panic_with_error!(env, VotingError::VkIcLengthMismatch);
        }
        if vk.ic.len() > MAX_IC_LENGTH {
            panic_with_error!(env, VotingError::VkIcTooLarge);
        }
    }

    pub(crate) fn bump_vk_version(env: &Env, dao_id: u64) -> u32 {
        let version_key = DataKey::VkVersion(dao_id);
        let current_version: u32 = env.storage().persistent().get(&version_key).unwrap_or(0);
        let new_version = current_version + 1;
        env.storage().persistent().set(&version_key, &new_version);
        Self::bump_persistent(env, &version_key);
        new_version
    }

    pub(crate) fn assert_weight_in_range(env: &Env, ctx: PathContext, weight: u32) {
        if weight < MIN_WEIGHT || weight > MAX_WEIGHT {
            panic_coarse(env, ctx, VotingError::WeightOutOfRange);
        }
    }

    pub(crate) fn assert_domain_tag_valid(env: &Env, ctx: PathContext, domain_tag: u32) {
        if domain_tag != DOMAIN_TAG_WEIGHTED {
            panic_coarse(env, ctx, VotingError::InvalidDomainTag);
        }
    }

    /// Set verification key from registry during DAO initialization
    /// This function is called by the registry contract during create_and_init_dao
    /// to avoid re-entrancy issues. The registry is a trusted system contract.
    ///
    /// CRIT-3 fix (2026-05-24): require the registry contract's auth — the
    /// previous code documented "registry is a trusted system contract" but
    /// did NOT enforce it. Sibling `init_tree_from_registry`/`register_from_registry`
    /// already do this; this one was missed in the original audit pass.
    pub fn set_vk_from_registry(env: Env, dao_id: u64, vk: VerificationKey) {
        crate::migrations::set_vk_from_registry(env, dao_id, vk);
    }


    /// Set BLS12-381 verification key from registry during DAO initialization
    pub fn set_vk_from_registry_bls381(env: Env, dao_id: u64, vk: VerificationKeyBls381) {
        crate::migrations::set_vk_from_registry_bls381(env, dao_id, vk);
    }


    /// Create a new proposal for a DAO
    /// Voting starts immediately upon creation (Merkle root snapshot taken now)
    /// title: Short display title (max 100 bytes)
    /// content_cid: IPFS CID pointing to rich content (or legacy plain text description)
    /// end_time: Unix timestamp for when voting closes (must be in the future, or 0 for no deadline)
    pub fn create_proposal(
        env: Env,
        dao_id: u64,
        title: String,
        content_cid: String,
        end_time: u64,
        creator: Address,
        vote_mode: VoteMode,
    ) -> u64 {
        crate::vote_submission::create_proposal(env, dao_id, title, content_cid, end_time, creator, vote_mode)
    }


    /// Create a proposal initialized in Registration phase for Merkle root commitment window
    pub fn create_proposal_in_registration(
        env: Env,
        dao_id: u64,
        title: String,
        content_cid: String,
        end_time: u64,
        creator: Address,
        vote_mode: VoteMode,
    ) -> u64 {
        crate::vote_submission::create_proposal_in_registration(env, dao_id, title, content_cid, end_time, creator, vote_mode)
    }


    /// Create proposal with a specific VK version (must be <= current and exist)
    pub fn create_proposal_with_vk_version(
        env: Env,
        dao_id: u64,
        title: String,
        content_cid: String,
        end_time: u64,
        creator: Address,
        vote_mode: VoteMode,
        vk_version: u32,
    ) -> u64 {
        crate::vote_submission::create_proposal_with_vk_version(env, dao_id, title, content_cid, end_time, creator, vote_mode, vk_version)
    }


    pub(crate) fn create_proposal_with_version(
        env: Env,
        dao_id: u64,
        title: String,
        content_cid: String,
        end_time: u64,
        creator: Address,
        vote_mode: VoteMode,
        vk_version: Option<u32>,
    ) -> u64 {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        creator.require_auth();

        // Validate title length to prevent DoS
        if title.len() > MAX_TITLE_LEN {
            panic_with_error!(&env, VotingError::TitleTooLong);
        }

        // Validate content_cid length and format
        if content_cid.len() > MAX_CID_LEN {
            panic_with_error!(&env, VotingError::InvalidContentCid);
        }
        // Allow empty content_cid for proposals with title-only
        // If not empty, validate CID format (starts with "Qm" for CIDv0 or "bafy"/"bafk" for CIDv1)
        // Also allow plain text for backwards compatibility (doesn't start with CID prefixes)
        // The frontend handles interpreting the content_cid field

        // Get tree and sbt contracts
        let tree_contract: Address = Self::tree_contract(env.clone());
        let sbt_contract: Address = env.invoke_contract(
            &tree_contract,
            &symbol_short!("sbt_contr"),
            soroban_sdk::vec![&env],
        );

        // Get registry from SBT contract
        let registry: Address = env.invoke_contract(
            &sbt_contract,
            &symbol_short!("registry"),
            soroban_sdk::vec![&env],
        );

        // Always require SBT membership to create proposals (regardless of membership_open)
        let has_sbt: bool = env.invoke_contract(
            &sbt_contract,
            &symbol_short!("has"),
            soroban_sdk::vec![&env, dao_id.into_val(&env), creator.clone().into_val(&env)],
        );

        if !has_sbt {
            panic_with_error!(&env, VotingError::NotDaoMember);
        }

        // Check if members are allowed to create proposals
        let members_can_propose: bool = env.invoke_contract(
            &registry,
            &Symbol::new(&env, "members_can_propose"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );

        // If members cannot propose, only admin can create proposals
        if !members_can_propose {
            let dao_admin: Address = env.invoke_contract(
                &registry,
                &symbol_short!("get_admin"),
                soroban_sdk::vec![&env, dao_id.into_val(&env)],
            );

            if creator != dao_admin {
                panic_with_error!(&env, VotingError::OnlyAdminCanPropose);
            }
        }

        let now = env.ledger().timestamp();

        // Validate end_time: 0 = no deadline, otherwise must be in the future
        if end_time != 0 && end_time <= now {
            panic_with_error!(&env, VotingError::EndTimeInvalid);
        }

        // Resolve VK version to use (curve-aware)
        let curve_id = Self::get_curve_id(&env, dao_id);
        let current_version: u32 = match curve_id {
            CurveId::Bls12381 => env
                .storage()
                .persistent()
                .get(&DataKey::VkVersionBls381(dao_id))
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet)),
            CurveId::Bn254 => env
                .storage()
                .persistent()
                .get(&DataKey::VkVersion(dao_id))
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet)),
        };
        let selected_version = vk_version.unwrap_or(current_version);
        if selected_version == 0 || selected_version > current_version {
            panic_with_error!(&env, VotingError::VkNotSet);
        }

        // Snapshot VK by version and compute hash (curve-aware)
        let vk_hash = match curve_id {
            CurveId::Bls12381 => {
                let vk = Self::get_vk_by_version_bls381(&env, dao_id, selected_version);
                Self::hash_vk_bls381(&env, &vk)
            }
            CurveId::Bn254 => {
                let vk = Self::get_vk_by_version(&env, dao_id, selected_version);
                Self::hash_vk(&env, &vk)
            }
        };

        // Snapshot current Merkle root - defines the eligible voter set
        let eligible_root: U256 = env.invoke_contract(
            &tree_contract,
            &symbol_short!("get_root"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );

        // Get current root index for Open mode validation
        let earliest_root_index: u32 = env.invoke_contract(
            &tree_contract,
            &symbol_short!("curr_idx"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );

        let snapshot_ledger = env.ledger().sequence();

        let proposal_id = Self::next_proposal_id(&env, dao_id);

        let proposal = ProposalInfo {
            id: proposal_id,
            dao_id,
            title: title.clone(),
            content_cid: content_cid.clone(),
            yes_votes: 0,
            no_votes: 0,
            end_time,
            created_by: creator.clone(),
            created_at: now,
            state: ProposalState::Active,
            vk_hash,
            vk_version: selected_version,
            eligible_root,
            vote_mode,
            earliest_root_index,
            snapshot_ledger,
        };

        let key = DataKey::Proposal(dao_id, proposal_id);
        env.storage().persistent().set(&key, &proposal);
        Self::bump_persistent(&env, &key);

        // Store proposal curve for proof format dispatch
        let curve_key = DataKey::ProposalCurve(dao_id, proposal_id);
        env.storage().persistent().set(&curve_key, &curve_id);
        Self::bump_persistent(&env, &curve_key);

        // Cache end_time for Temporary nullifier TTL computation
        // Stored in Persistent (immutable after creation) so ttl.ts can look it up
        let end_time_key = DataKey::ProposalEndTime(dao_id, proposal_id);
        env.storage().persistent().set(&end_time_key, &end_time);
        Self::bump_persistent(&env, &end_time_key);

        ProposalEvent {
            dao_id,
            proposal_id,
            title,
            content_cid,
            creator,
        }
        .publish(&env);

        proposal_id
    }

    /// Compute SHA256 hash of verification key for immutability tracking
    pub(crate) fn hash_vk(env: &Env, vk: &VerificationKey) -> BytesN<32> {
        // Serialize VK components into bytes
        let mut data = Bytes::new(env);

        // Add alpha (64 bytes)
        data.append(&Bytes::from_array(env, &vk.alpha.to_array()));
        // Add beta (128 bytes)
        data.append(&Bytes::from_array(env, &vk.beta.to_array()));
        // Add gamma (128 bytes)
        data.append(&Bytes::from_array(env, &vk.gamma.to_array()));
        // Add delta (128 bytes)
        data.append(&Bytes::from_array(env, &vk.delta.to_array()));
        // Add IC points
        for i in 0..vk.ic.len() {
            if let Some(ic_point) = vk.ic.get(i) {
                data.append(&Bytes::from_array(env, &ic_point.to_array()));
            }
        }

        env.crypto().sha256(&data).into()
    }

    /// Compute SHA256 hash of BLS12-381 verification key
    pub(crate) fn hash_vk_bls381(env: &Env, vk: &VerificationKeyBls381) -> BytesN<32> {
        let mut data = Bytes::new(env);

        data.append(&Bytes::from_array(env, &vk.alpha.to_array()));
        data.append(&Bytes::from_array(env, &vk.beta.to_array()));
        data.append(&Bytes::from_array(env, &vk.gamma.to_array()));
        data.append(&Bytes::from_array(env, &vk.delta.to_array()));
        for i in 0..vk.ic.len() {
            if let Some(ic_point) = vk.ic.get(i) {
                data.append(&Bytes::from_array(env, &ic_point.to_array()));
            }
        }

        env.crypto().sha256(&data).into()
    }

    /// Set the reentrancy lock. Panics if already locked (reentrant call detected).
    pub(crate) fn set_reentrancy_lock(env: &Env) {
        let lock_key = DataKey::ReentrancyLock;
        if env.storage().instance().has(&lock_key) {
            panic_with_error!(env, VotingError::ReentrantCall);
        }
        env.storage().instance().set(&lock_key, &true);
    }

    /// Clear the reentrancy lock after successful execution.
    pub(crate) fn clear_reentrancy_lock(env: &Env) {
        env.storage().instance().remove(&DataKey::ReentrancyLock);
    }

    /// Submit a vote with ZK proof
    ///
    /// REENTRANCY MODEL:
    /// This function follows the checks-effects-interactions pattern with a
    /// contract-level reentrancy lock for defense-in-depth:
    ///
    ///   Checks:  validate inputs, verify proposal is Active, nullifier unused,
    ///            root is valid for vote mode
    ///   Effects: mark nullifier as used (BEFORE any external calls)
    ///   Interactions: verify Groth16 proof, cross-contract tree lookups
    ///
    /// The nullifier is domain-separated by (dao_id, proposal_id), so the same
    /// secret produces different nullifiers across DAOs and proposals.
    ///
    /// Privacy-preserving: commitment is NOT a public parameter.
    /// Revocation is enforced by zeroing leaves in the Merkle tree.
    pub fn vote(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool, // true = yes, false = no
        nullifier: U256,
        root: U256,
        proof: Proof,
    ) {
        crate::vote_submission::vote(env, dao_id, proposal_id, vote_choice, nullifier, root, proof);
    }


    /// Weighted vote with weight bounds and domain tag (for ZK-013 weighted governance)
    /// Constraint review: weight is bounded [MIN_WEIGHT, MAX_WEIGHT] via range proof in circuit (128 bits)
    /// Domain tag prevents cross-circuit replay (weighted vs standard vote)
    /// KAT: compared against vote_v2 nullifier domain separation
    pub fn vote_weighted(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool,
        nullifier: U256,
        root: U256,
        proof: Proof,
        weight: u32,
        domain_tag: u32,
    ) {
        crate::vote_submission::vote_weighted(env, dao_id, proposal_id, vote_choice, nullifier, root, proof, weight, domain_tag);
    }


    /// Cast a BLS12-381-backed anonymous vote.
    pub fn vote_bls381(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool,
        nullifier: U256,
        root: U256,
        proof: ProofBls381,
    ) {
        crate::vote_submission::vote_bls381(env, dao_id, proposal_id, vote_choice, nullifier, root, proof);
    }


    /// Registers the verification key for a Merkle depth.
    ///
    /// `vote.circom` fixes the tree depth at 18, so every proof carries 18 path
    /// elements no matter how small the electorate is. Compiling the circuit at
    /// other depths produces different verification keys, and this is where a
    /// DAO admin registers them.
    ///
    /// Registering a key for a depth an election has already declared changes
    /// what that election verifies against, so the pinned hash check in
    /// `resolve_election_vk` rejects in-flight proofs with `VkChanged` — the
    /// same protection the version-pinned default key has.
    pub fn set_vk_for_depth(
        env: Env,
        dao_id: u64,
        merkle_depth: u32,
        vk: VerificationKey,
        admin: Address,
    ) {
        crate::admin::set_vk_for_depth(env, dao_id, merkle_depth, vk, admin);
    }


    /// Returns the verification key registered for a Merkle depth, if any.
    pub fn get_vk_for_depth(env: Env, dao_id: u64, merkle_depth: u32) -> Option<VerificationKey> {
        crate::admin::get_vk_for_depth(env, dao_id, merkle_depth)
    }


    /// Sets the election configuration and the Merkle depth its proofs use.
    ///
    /// A depth of 0 keeps the default circuit and the DAO's version-pinned key.
    /// A non-zero depth requires a key registered by `set_vk_for_depth`, and
    /// pins that key's hash to the proposal so a later re-registration cannot
    /// change what in-flight votes are checked against.
    pub fn set_election_config_with_depth(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        min_balance: i128,
        twab_window: u64,
        num_candidates: u32,
        merkle_depth: u32,
    ) {
        crate::admin::set_election_config_with_depth(env, dao_id, proposal_id, min_balance, twab_window, num_candidates, merkle_depth);
    }


    /// The Merkle depth an election's proofs are built against.
    ///
    /// 0 means the default depth-18 circuit. Clients use this to pick which
    /// circuit artifacts to download and which key to verify against.
    pub fn get_merkle_depth(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
        crate::admin::get_merkle_depth(env, dao_id, proposal_id)
    }


    /// Resolves the verification key an election's proofs must satisfy, and
    /// checks it still hashes to what was pinned when the election was set up.
    ///
    /// Elections at the default depth keep using the DAO's version-pinned key,
    /// so nothing changes for them.
    pub(crate) fn resolve_election_vk(
        env: &Env,
        ctx: PathContext,
        dao_id: u64,
        proposal_id: u64,
        proposal: &ProposalInfo,
        merkle_depth: u32,
    ) -> VerificationKey {
        if merkle_depth == 0 {
            let vk = Self::get_vk_by_version(env, dao_id, proposal.vk_version);
            if Self::hash_vk(env, &vk) != proposal.vk_hash {
                panic_coarse(env, ctx, VotingError::VkChanged);
            }
            return vk;
        }

        let vk = env
            .storage()
            .persistent()
            .get::<_, VerificationKey>(&DataKey::DepthVk(dao_id, merkle_depth))
            .unwrap_or_else(|| panic_coarse(env, ctx, VotingError::InvalidMerkleDepth));

        let pinned: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::ProposalDepthVkHash(dao_id, proposal_id))
            .unwrap_or_else(|| panic_coarse(env, ctx, VotingError::VkNotSet));
        if Self::hash_vk(env, &vk) != pinned {
            panic_coarse(env, ctx, VotingError::VkChanged);
        }
        vk
    }

    /// Casts several votes in one transaction, verified with a single batched
    /// pairing check.
    ///
    /// Every vote is validated exactly as `vote` validates it — field bounds,
    /// non-zero and unused nullifier, root eligibility for the proposal's vote
    /// mode, candidate bound — and each proof is still checked against its own
    /// public signals. What changes is only the verification: instead of four
    /// pairings per proof, the batch is combined into `N + 3` pairings, which
    /// measures at roughly 1.9x cheaper for four votes and 2.9x for sixty-four.
    ///
    /// The batch is all-or-nothing. One bad proof rejects the whole
    /// transaction, and the failure does not say which proof was bad, so a
    /// relayer that hits `InvalidProof` should re-submit the votes singly (or
    /// bisect) to find the culprit rather than dropping them all.
    ///
    /// Returns the number of votes recorded.
    pub fn cast_votes(env: Env, dao_id: u64, proposal_id: u64, votes: Vec<BatchVote>) -> u32 {
        crate::vote_submission::cast_votes(env, dao_id, proposal_id, votes)
    }


    /// Root eligibility for a proposal, shared by `vote` and `cast_votes`.
    ///
    /// Fixed mode requires the exact snapshot root. Trailing mode accepts any
    /// root in the tree's history that neither predates the proposal nor a
    /// member removal, so late joiners can vote but revoked members cannot.
    pub(crate) fn assert_root_eligible(
        env: &Env,
        ctx: PathContext,
        dao_id: u64,
        proposal: &ProposalInfo,
        root: &U256,
    ) {
        match proposal.vote_mode {
            VoteMode::Fixed => {
                if root != &proposal.eligible_root {
                    panic_coarse(env, ctx, VotingError::RootMismatch);
                }
            }
            VoteMode::Trailing => {
                let tree_contract: Address = Self::tree_contract(env.clone());

                let root_valid: bool = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_ok"),
                    soroban_sdk::vec![env, dao_id.into_val(env), root.clone().into_val(env)],
                );
                if !root_valid {
                    panic_coarse(env, ctx, VotingError::RootNotInHistory);
                }

                let root_index: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_idx"),
                    soroban_sdk::vec![env, dao_id.into_val(env), root.clone().into_val(env)],
                );
                if root_index < proposal.earliest_root_index {
                    panic_coarse(env, ctx, VotingError::RootPredatesProposal);
                }

                let min_valid_root: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("min_root"),
                    soroban_sdk::vec![env, dao_id.into_val(env)],
                );
                if root_index < min_valid_root {
                    panic_coarse(env, ctx, VotingError::RootPredatesRemoval);
                }
            }
            VoteMode::Quadratic => {
                panic_coarse(env, ctx, VotingError::NotQuadraticProposal);
            }
        }
    }
    /// Get proposal info
    pub fn get_proposal(env: Env, dao_id: u64, proposal_id: u64) -> ProposalInfo {
        crate::vote_submission::get_proposal(env, dao_id, proposal_id)
    }


    /// Get vote mode for a proposal
    /// Returns VoteMode enum directly for type safety
    /// Used by comments contract for eligibility checks
    pub fn get_vote_mode(env: Env, dao_id: u64, proposal_id: u64) -> VoteMode {
        crate::vote_submission::get_vote_mode(env, dao_id, proposal_id)
    }


    /// Get eligible root for a proposal (merkle root at snapshot)
    /// Used by comments contract for Fixed mode eligibility checks
    pub fn get_eligible_root(env: Env, dao_id: u64, proposal_id: u64) -> U256 {
        crate::vote_submission::get_eligible_root(env, dao_id, proposal_id)
    }


    /// Get earliest root index for a proposal (for Trailing mode)
    /// Used by comments contract for Trailing mode eligibility checks
    pub fn get_earliest_idx(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
        crate::vote_submission::get_earliest_idx(env, dao_id, proposal_id)
    }


    /// Get proposal count for a DAO
    pub fn proposal_count(env: Env, dao_id: u64) -> u64 {
        crate::vote_submission::proposal_count(env, dao_id)
    }


    /// Cross-contract query: return true if `candidate_root` is the eligible_root
    /// of any Active Fixed-mode proposal. Used by membership-tree to block FIFO
    /// root eviction when a Fixed snapshot is still being voted against.
    pub fn root_pin(env: Env, dao_id: u64, candidate_root: U256) -> bool {
        crate::vote_submission::root_pin(env, dao_id, candidate_root)
    }


    /// Cross-contract hook: emit [`AtRiskVoterAlert`] events for every Active
    /// Trailing-mode proposal whose earliest_root_index allows the candidate
    /// root (i.e. voters with proofs against this root could still cast valid
    /// votes). Called by membership-tree right before FIFO eviction.
    pub fn chk_risk(env: Env, dao_id: u64, candidate_root: U256) {
        crate::vote_submission::chk_risk(env, dao_id, candidate_root);
    }


    /// Read proposal end_time from cache (written at proposal creation).
    /// Returns 0 if proposal has no end_time (never closes) or is unknown.
    /// TTL-aware backend helpers use this to skip renewal of Temporary
    /// nullifier records whose proposal voting window has closed + grace elapsed.
    pub fn get_proposal_end_time(env: Env, dao_id: u64, proposal_id: u64) -> u64 {
        crate::vote_submission::get_proposal_end_time(env, dao_id, proposal_id)
    }


    /// Internal version of get_proposal_end_time (avoids double bump_instance).
    #[inline(always)]
    pub(crate) fn get_proposal_end_time_internal(env: &Env, dao_id: u64, proposal_id: u64) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::ProposalEndTime(dao_id, proposal_id))
            .unwrap_or(0)
    }

    /// Check if a nullifier has been used for a specific election.
    ///
    /// Requires election identity `(dao_id, proposal_id)` — never queries a
    /// global nullifier namespace (issue #64).
    pub fn is_nullifier_used(env: Env, dao_id: u64, proposal_id: u64, nullifier: U256) -> bool {
        crate::tally::is_nullifier_used(env, dao_id, proposal_id, nullifier)
    }


    /// Verify a voter receipt by checking if the nullifier was recorded
    /// (used for Individual Verifiability of votes without revealing the choice)
    pub fn verify_receipt(env: Env, dao_id: u64, proposal_id: u64, nullifier: U256) -> bool {
        crate::tally::verify_receipt(env, dao_id, proposal_id, nullifier)
    }


    /// Alias for [`Self::is_nullifier_used`] matching the issue #64 naming.
    pub fn has_nullifier_been_used(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        nullifier: U256,
    ) -> bool {
        crate::tally::has_nullifier_been_used(env, dao_id, proposal_id, nullifier)
    }


    /// Migrate a legacy globally-scoped nullifier into election-scoped storage.
    ///
    /// Moves `LegacyNullifierUsed(nullifier)` → `Nullifier(dao_id, proposal_id, nullifier)`
    /// and deletes the legacy entry. Returns `true` if a legacy entry was migrated.
    pub fn migrate_nullifier(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        nullifier: U256,
        admin: Address,
    ) -> bool {
        crate::tally::migrate_nullifier(env, dao_id, proposal_id, nullifier, admin)
    }


    /// Convert a Stellar address to a U256 field element
    /// Hashes the address using Blake2-256 and converts to U256
    pub(crate) fn address_to_u256(env: &Env, address: &Address) -> U256 {
        let address_bytes = address.to_xdr(env);
        let hash: BytesN<32> = env.crypto().sha256(&address_bytes).into();
        let bytes = Bytes::from_array(env, &hash.to_array());
        U256::from_be_bytes(env, &bytes)
    }

    /// Get tree contract address
    pub fn tree_contract(env: Env) -> Address {
        crate::vote_submission::tree_contract(env)
    }


    /// Get registry contract address (cached at construction)
    pub fn registry(env: Env) -> Address {
        crate::vote_submission::registry(env)
    }


    /// Get results for a proposal (yes_votes, no_votes)
    pub fn get_results(env: Env, dao_id: u64, proposal_id: u64) -> (u64, u64) {
        crate::tally::get_results(env, dao_id, proposal_id)
    }


    /// Close a proposal explicitly (idempotent). End time still enforced in vote.
    pub fn close_proposal(env: Env, dao_id: u64, proposal_id: u64, admin: Address) {
        crate::tally::close_proposal(env, dao_id, proposal_id, admin);
    }


    /// Archive a proposal (idempotent). Prevents further votes and signals off-chain cleanup.
    pub fn archive_proposal(env: Env, dao_id: u64, proposal_id: u64, admin: Address) {
        crate::tally::archive_proposal(env, dao_id, proposal_id, admin);
    }


    /// Contract version for upgrade tracking.
    pub fn version(env: Env) -> u32 {
        crate::migrations::version(env)
    }


    /// Get current VK version for a DAO
    pub fn vk_version(env: Env, dao_id: u64) -> u32 {
        crate::admin::vk_version(env, dao_id)
    }


    /// Get the current VK for a DAO (used by other contracts like comments)
    pub fn get_vk(env: Env, dao_id: u64) -> VerificationKey {
        crate::admin::get_vk(env, dao_id)
    }


    /// Get a specific VK version for observability/off-chain verification
    pub fn vk_for_version(env: Env, dao_id: u64, version: u32) -> VerificationKey {
        crate::admin::vk_for_version(env, dao_id, version)
    }


    /// Get the current BLS12-381 VK for a DAO
    pub fn get_vk_bls381(env: Env, dao_id: u64) -> VerificationKeyBls381 {
        crate::admin::get_vk_bls381(env, dao_id)
    }


    /// Get a specific BLS12-381 VK version
    pub fn vk_for_version_bls381(env: Env, dao_id: u64, version: u32) -> VerificationKeyBls381 {
        crate::admin::vk_for_version_bls381(env, dao_id, version)
    }

    pub(crate) fn next_proposal_id(env: &Env, dao_id: u64) -> u64 {
        let count_key = DataKey::ProposalCount(dao_id);
        let count: u64 = env.storage().instance().get(&count_key).unwrap_or(0);
        let new_id = count + 1;
        env.storage().instance().set(&count_key, &new_id);
        new_id
    }

    /// Verify Groth16 proof using shared verification library.
    /// In test mode, checks for VerifyOverride flag to allow testing error paths.
    #[allow(unused_variables)]
    pub(crate) fn verify_groth16(
        env: &Env,
        vk: &VerificationKey,
        proof: &Proof,
        pub_signals: &Vec<U256>,
    ) -> bool {
        // In test mode, check for override flag first
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

        // Delegate to shared Groth16 verification
        zkvote_groth16::verify_groth16(env, vk, proof, pub_signals)
    }

    /// Verify BLS12-381 Groth16 proof using shared verification library.
    #[allow(unused_variables)]
    pub(crate) fn verify_groth16_bls381(
        env: &Env,
        vk: &VerificationKeyBls381,
        proof: &ProofBls381,
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

        zkvote_groth16::verify_groth16_bls381(env, vk, proof, pub_signals)
    }

    pub fn set_circuit_registry(env: Env, circuit_registry: Address) {
        crate::migrations::set_circuit_registry(env, circuit_registry);
    }


    pub fn set_transcript_registry(env: Env, transcript_registry: Address) {
        crate::migrations::set_transcript_registry(env, transcript_registry);
    }


    pub fn get_transcript_registry(env: Env) -> Option<Address> {
        crate::migrations::get_transcript_registry(env)
    }


    pub fn set_dao_current_circuit(
        env: Env,
        dao_id: u64,
        circuit_id: String,
        _circuit_type: CircuitType,
    ) {
        crate::migrations::set_dao_current_circuit(env, dao_id, circuit_id, _circuit_type);
    }


    pub fn get_dao_current_circuit(env: Env, dao_id: u64) -> String {
        crate::migrations::get_dao_current_circuit(env, dao_id)
    }


    pub fn set_migration(
        env: Env,
        dao_id: u64,
        old_circuit_id: String,
        new_circuit_id: String,
        deadline: u64,
    ) {
        crate::migrations::set_migration(env, dao_id, old_circuit_id, new_circuit_id, deadline);
    }


    pub fn get_migration(env: Env, dao_id: u64) -> MigrationInfo {
        crate::migrations::get_migration(env, dao_id)
    }


    pub(crate) fn load_vk_from_registry(
        env: &Env,
        circuit_id: &String,
        circuit_type: &CircuitType,
    ) -> VerificationKey {
        let circuit_registry: Address = env
            .storage()
            .instance()
            .get(&CIRCUIT_REGISTRY)
            .unwrap_or_else(|| {
                panic_with_error!(env, VotingError::VkNotSet);
            });
        let result: CircuitVKResult = env.invoke_contract(
            &circuit_registry,
            &Symbol::new(env, "get_vk"),
            soroban_sdk::vec![
                env,
                circuit_id.clone().into_val(env),
                circuit_type.clone().into_val(env),
            ],
        );
        result.vk
    }

    /// Check if there is a pending VK upgrade proposal for this DAO in the circuit-registry.
    /// Returns Some(proposal_id) if pending, None otherwise.
    pub fn get_pending_vk_proposal(env: Env, dao_id: u64) -> Option<u32> {
        crate::migrations::get_pending_vk_proposal(env, dao_id)
    }


    /// Check if a VK proposal has met its timelock and quorum.
    /// Returns true if the proposal is ready to be executed.
    pub fn is_vk_proposal_ready(env: Env, proposal_id: u32) -> bool {
        crate::migrations::is_vk_proposal_ready(env, proposal_id)
    }


    pub(crate) fn check_migration_window(env: &Env, dao_id: u64) -> Option<(String, String)> {
        let migration_key = DataKey::DaoMigration(dao_id);
        if !env.storage().persistent().has(&migration_key) {
            return None;
        }
        let migration: MigrationInfo = env.storage().persistent().get(&migration_key).unwrap();
        let now = env.ledger().timestamp();
        if now < migration.deadline {
            Some((migration.old_circuit_id, migration.new_circuit_id))
        } else {
            None
        }
    }

    pub fn vote_with_circuit(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool,
        nullifier: U256,
        root: U256,
        proof: Proof,
        circuit_id: String,
    ) {
        crate::vote_submission::vote_with_circuit(env, dao_id, proposal_id, vote_choice, nullifier, root, proof, circuit_id);
    }


    /// Create or update election configuration with token-gating parameters.
    /// Sets the minimum balance required to vote, snapshot ledger, TWAB window,
    /// and the number of valid candidates (bound into the ZK proof).
    /// Only callable during proposal creation or by DAO admin.
    pub fn set_election_config(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        min_balance: i128,
        twab_window: u64,
        num_candidates: u32,
    ) {
        crate::admin::set_election_config(env, dao_id, proposal_id, min_balance, twab_window, num_candidates);
    }


    /// Get election configuration for a proposal.
    pub fn get_election_config(env: Env, dao_id: u64, proposal_id: u64) -> Option<ElectionConfig> {
        crate::admin::get_election_config(env, dao_id, proposal_id)
    }


    /// Set commitment window for Merkle root updates during registration.
    pub fn set_commitment_window(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        commitment_window: u64,
        admin: Address,
    ) {
        crate::admin::set_commitment_window(env, dao_id, proposal_id, commitment_window, admin);
    }


    /// Sets/updates the Merkle root during the Registration phase within the commitment window.
    /// Performs cross-contract verification against the Tree contract.
    /// Stores root history for auditability and emits an ElectionStatusChangedEvent.
    pub fn set_merkle_root(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        new_root: U256,
        admin: Address,
    ) {
        crate::admin::set_merkle_root(env, dao_id, proposal_id, new_root, admin);
    }


    /// Transitions proposal state from Registration to Active, permanently locking the Merkle root.
    pub fn activate_proposal(env: Env, dao_id: u64, proposal_id: u64, caller: Address) {
        crate::admin::activate_proposal(env, dao_id, proposal_id, caller);
    }


    /// Returns the audit history of Merkle root updates for an election.
    pub fn get_merkle_root_history(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> Vec<MerkleRootRecord> {
        crate::admin::get_merkle_root_history(env, dao_id, proposal_id)
    }


    /// Get the number of valid candidates for a proposal's election.
    /// Returns 0 if no election config is set (backward-compatible default).
    pub fn get_num_candidates(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
        crate::admin::get_num_candidates(env, dao_id, proposal_id)
    }


    /// Get the snapshot ledger for a proposal (from ProposalInfo).
    pub fn get_snapshot_ledger(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
        crate::admin::get_snapshot_ledger(env, dao_id, proposal_id)
    }


    /// Record a balance checkpoint for time-weighted average balance computation.
    /// Called by the token contract when a voter's balance changes.
    /// Stores (dao_id, address, ledger) -> balance for TWAB calculation.
    pub fn record_balance_checkpoint(env: Env, dao_id: u64, voter: Address, balance: i128) {
        crate::vote_submission::record_balance_checkpoint(env, dao_id, voter, balance);
    }


    /// Compute time-weighted average balance for a voter between a start and end ledger.
    /// Uses stored balance checkpoints to compute the average balance over the window.
    /// Returns None if no checkpoints are available.
    pub fn get_twab(
        env: Env,
        dao_id: u64,
        voter: Address,
        start_ledger: u32,
        end_ledger: u32,
    ) -> Option<i128> {
        crate::vote_submission::get_twab(env, dao_id, voter, start_ledger, end_ledger)
    }


    /// Set a transfer cooldown for a voter during an active election.
    /// Prevents the voter from transferring tokens until the cooldown expires.
    /// Called automatically when a voter registers or votes in a token-gated election.
    pub fn set_voter_cooldown(env: Env, dao_id: u64, voter: Address) {
        crate::vote_submission::set_voter_cooldown(env, dao_id, voter);
    }


    /// Clear a voter's transfer cooldown after an election ends.
    pub fn clear_voter_cooldown(env: Env, dao_id: u64, voter: Address) {
        crate::vote_submission::clear_voter_cooldown(env, dao_id, voter);
    }


    /// Check if a voter is in transfer cooldown (cannot transfer tokens).
    /// Returns true if cooldown is active, false otherwise.
    /// This function is intended to be called by token contracts before transfers.
    pub fn is_in_transfer_cooldown(env: Env, dao_id: u64, voter: Address) -> bool {
        crate::vote_submission::is_in_transfer_cooldown(env, dao_id, voter)
    }


    /// Create a balance snapshot for a proposal (records current token balances).
    /// Stores the snapshot ledger and timestamp for future eligibility checks.
    /// Called during proposal creation when token-gating is configured.
    pub fn create_balance_snapshot(env: Env, dao_id: u64, proposal_id: u64) {
        crate::vote_submission::create_balance_snapshot(env, dao_id, proposal_id);
    }


    /// Get the balance snapshot for a proposal.
    pub fn get_balance_snapshot(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> Option<BalanceSnapshotInfo> {
        crate::vote_submission::get_balance_snapshot(env, dao_id, proposal_id)
    }


    /// Check if a voter's balance at snapshot time meets the minimum requirement.
    /// For token-gated proposals, this verifies the voter held sufficient tokens
    /// at the time the proposal was created (preventing flash loan attacks).
    /// This is a view function that token contracts should call before allowing votes.
    /// Returns true if the voter's snapshot balance meets the minimum, or if no
    /// token-gating is configured for this proposal.
    #[allow(unused_variables)]
    pub fn check_voter_eligibility(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        voter: Address,
        current_balance: i128,
        balance_at_snapshot: i128,
    ) -> bool {
        crate::vote_submission::check_voter_eligibility(env, dao_id, proposal_id, voter, current_balance, balance_at_snapshot)
    }


    pub(crate) fn randomness_deadlines(env: &Env, dao_id: u64, proposal_id: u64) -> (u64, u64) {
        let proposal = Self::get_proposal(env.clone(), dao_id, proposal_id);
        let commit_end = proposal.created_at.saturating_add(RANDOMNESS_COMMIT_WINDOW);
        (
            commit_end,
            commit_end.saturating_add(RANDOMNESS_REVEAL_WINDOW),
        )
    }

    pub(crate) fn require_dao_member(env: &Env, dao_id: u64, participant: &Address) {
        let tree = Self::tree_contract(env.clone());
        let sbt: Address =
            env.invoke_contract(&tree, &symbol_short!("sbt_contr"), soroban_sdk::vec![env]);
        let is_member: bool = env.invoke_contract(
            &sbt,
            &symbol_short!("has"),
            soroban_sdk::vec![env, dao_id.into_val(env), participant.clone().into_val(env)],
        );
        if !is_member {
            panic_with_error!(env, VotingError::NotDaoMember);
        }
    }

    pub fn randomness_commitment(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        participant: Address,
        value: BytesN<32>,
    ) -> BytesN<32> {
        crate::encrypted_tally::randomness_commitment(env, dao_id, proposal_id, participant, value)
    }


    pub fn commit_randomness(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        commitment: BytesN<32>,
        participant: Address,
    ) {
        crate::encrypted_tally::commit_randomness(env, dao_id, proposal_id, commitment, participant);
    }


    pub fn reveal_randomness(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        value: BytesN<32>,
        participant: Address,
    ) {
        crate::encrypted_tally::reveal_randomness(env, dao_id, proposal_id, value, participant);
    }


    pub fn finalize_candidate_seed(env: Env, dao_id: u64, proposal_id: u64) -> BytesN<32> {
        crate::encrypted_tally::finalize_candidate_seed(env, dao_id, proposal_id)
    }


    pub fn get_candidate_seed(env: Env, dao_id: u64, proposal_id: u64) -> Option<BytesN<32>> {
        crate::encrypted_tally::get_candidate_seed(env, dao_id, proposal_id)
    }


    pub fn candidate_order_key(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        candidate: BytesN<32>,
    ) -> BytesN<32> {
        crate::encrypted_tally::candidate_order_key(env, dao_id, proposal_id, candidate)
    }


    /// Set the VDF delay parameter for an election.
    ///
    /// This configures the number of SHA256 iterations required for the VDF.
    /// A higher delay provides stronger unpredictability guarantees.
    /// Must be set before VDF output can be submitted.
    ///
    /// # Arguments
    ///
    /// * `dao_id` - DAO identifier
    /// * `proposal_id` - Proposal identifier
    /// * `delay` - Number of SHA256 iterations (VDF delay parameter)
    /// * `admin` - DAO admin address (required for auth)
    pub fn set_vdf_delay(env: Env, dao_id: u64, proposal_id: u64, delay: u64, admin: Address) {
        crate::encrypted_tally::set_vdf_delay(env, dao_id, proposal_id, delay, admin);
    }


    /// Submit VDF output and proof for an election.
    ///
    /// Anyone can submit the VDF output once the delay period is complete.
    /// The output is verified on-chain using the provided checkpoints.
    ///
    /// # Arguments
    ///
    /// * `dao_id` - DAO identifier
    /// * `proposal_id` - Proposal identifier
    /// * `vdf_output` - The VDF output `y = SHA256^T(x)` (32 bytes)
    /// * `checkpoints` - Intermediate hash values for on-chain verification
    /// * `proposal_creation_time` - Timestamp when the proposal was created (used to verify delay elapsed)
    pub fn submit_vdf_output(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vdf_output: BytesN<32>,
        checkpoints: soroban_sdk::Vec<BytesN<32>>,
        proposal_creation_time: u64,
    ) {
        crate::encrypted_tally::submit_vdf_output(env, dao_id, proposal_id, vdf_output, checkpoints, proposal_creation_time);
    }


    /// Get the VDF output for an election, if submitted.
    pub fn get_vdf_output(env: Env, dao_id: u64, proposal_id: u64) -> Option<BytesN<32>> {
        crate::encrypted_tally::get_vdf_output(env, dao_id, proposal_id)
    }


    /// Get the VDF delay parameter for an election.
    pub fn get_vdf_delay(env: Env, dao_id: u64, proposal_id: u64) -> u64 {
        crate::encrypted_tally::get_vdf_delay(env, dao_id, proposal_id)
    }


    /// Get the VDF input seed for an election.
    pub fn get_vdf_input(env: Env, dao_id: u64, proposal_id: u64) -> Option<BytesN<32>> {
        crate::encrypted_tally::get_vdf_input(env, dao_id, proposal_id)
    }


    /// Check if VDF has been finalized for an election.
    pub fn is_vdf_finalized(env: Env, dao_id: u64, proposal_id: u64) -> bool {
        crate::encrypted_tally::is_vdf_finalized(env, dao_id, proposal_id)
    }


    /// Finalize the candidate seed using the VDF output.
    ///
    /// If VDF output is available, it is used directly as the candidate seed.
    /// This provides verified randomness that was unpredictable before the
    /// delay period elapsed.
    ///
    /// If VDF output is not available, falls back to the commit-reveal seed.
    ///
    /// # Returns
    ///
    /// The finalized candidate seed (32 bytes)
    pub fn finalize_with_vdf(env: Env, dao_id: u64, proposal_id: u64) -> BytesN<32> {
        crate::encrypted_tally::finalize_with_vdf(env, dao_id, proposal_id)
    }

}

#[cfg(test)]
mod test;
