//! Sybil-resistance layer: SBT-age weighting + reputation score (issue #301).
//!
//! # The problem
//!
//! Vote-to-Earn pays a flat reward per voter and quadratic voting hands every
//! member the same credit budget. Both are Sybil-vulnerable in the same way:
//! influence scales linearly with the number of identities, and minting an
//! identity in an open DAO costs nothing. THREAT_MODEL §"Sybil bounds" bounds
//! the *reward* exposure with funding caps, but the *voting* exposure is
//! unbounded.
//!
//! # The mitigation
//!
//! Weight each identity by two things an attacker cannot mint on demand:
//!
//!   * how long its membership SBT has existed, and
//!   * how much reputation it has accrued through governance participation.
//!
//! ```text
//! weight = min(MAX_SYBIL_WEIGHT, BASE_WEIGHT + age_points + reputation_points)
//! ```
//!
//! with both point terms as step functions (one point per crossed threshold).
//! `contracts/membership-sbt` owns the curve and the underlying data; this
//! module is the voting side — it enforces a per-election cap and keeps a
//! weighted tally.
//!
//! # Why the weight must be in the proof
//!
//! Voting is anonymous, so at tally time there is no address to look an SBT age
//! up for. If the voter merely *asserted* a weight, the bound would be
//! advisory. `circuits/sybil_weighted_vote.circom` therefore computes the
//! weight from an SBT-issued attestation inside the proof, and the contract
//! verifies the proof against a public `vote_weight` signal.
//!
//! The on-chain cap here is defense in depth, not the primary control: it
//! catches a mis-generated verification key or a circuit/contract parameter
//! drift, where the proof would otherwise verify against a weight the DAO never
//! intended.

use soroban_sdk::{contractimpl, panic_with_error, Address, Env, U256};

use crate::{
    DataKey, ElectionConfig, Proof, ProposalInfo, ProposalState, SybilWeightCapSetEvent,
    VerificationKey, Voting, VotingArgs, VotingClient, VotingError, WeightedTally,
    WeightedVoteEvent, MAX_IC_LENGTH,
};

/// Hard ceiling on any per-election cap, mirroring `MAX_SYBIL_WEIGHT` in
/// `contracts/membership-sbt/src/lib.rs`. A DAO may configure a *lower* cap,
/// never a higher one — the circuit will not produce a weight above this, so a
/// higher cap would be unenforceable and therefore misleading.
pub const MAX_SYBIL_WEIGHT: u32 = 10;

/// Weight every member carries. Matches `BASE_WEIGHT` in membership-sbt.
pub const BASE_SYBIL_WEIGHT: u32 = 1;

/// Public signals of `circuits/sybil_weighted_vote.circom`:
/// [root, nullifier, daoId, proposalId, voteChoice, numCandidates,
///  snapshotTime, attestationCommitment, voteWeight]
const SYBIL_NUM_PUBLIC_SIGNALS: u32 = 9;
const SYBIL_CIRCUIT_IC_LEN: u32 = SYBIL_NUM_PUBLIC_SIGNALS + 1;

#[contractimpl]
impl Voting {
    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    /// Register the Sybil-weighted vote verification key for a DAO.
    ///
    /// Versioned separately from the plain-vote VK so a DAO can run both
    /// circuits — a proposal opts into weighting, it is not a DAO-wide switch.
    pub fn set_sybil_vk(env: Env, dao_id: u64, vk: VerificationKey, admin: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);

        if vk.ic.len() != SYBIL_CIRCUIT_IC_LEN || vk.ic.len() > MAX_IC_LENGTH {
            panic_with_error!(&env, VotingError::VkIcLengthMismatch);
        }

        let key = DataKey::SybilVotingKey(dao_id);
        env.storage().persistent().set(&key, &vk);
        Self::bump_persistent(&env, &key);
    }

    /// Enable Sybil-weighted voting for one election and set its weight cap.
    ///
    /// `cap` may be lower than [`MAX_SYBIL_WEIGHT`] — a DAO that wants
    /// weighting to matter less can flatten the curve without redeploying the
    /// circuit — but never higher, since the circuit cannot produce more.
    ///
    /// Setting a cap after votes have been cast is refused: changing the cap
    /// mid-election would silently reweight the ballots already in the tally.
    pub fn set_sybil_weight_cap(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        cap: u32,
        admin: Address,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);

        if cap < BASE_SYBIL_WEIGHT || cap > MAX_SYBIL_WEIGHT {
            panic_with_error!(&env, VotingError::WeightOutOfRange);
        }

        let tally_key = DataKey::WeightedTally(dao_id, proposal_id);
        if let Some(tally) = env
            .storage()
            .persistent()
            .get::<DataKey, WeightedTally>(&tally_key)
        {
            if tally.yes_ballots > 0 || tally.no_ballots > 0 {
                panic_with_error!(&env, VotingError::InvalidState);
            }
        }

        let key = DataKey::SybilWeightCap(dao_id, proposal_id);
        env.storage().persistent().set(&key, &cap);
        Self::bump_persistent(&env, &key);

        SybilWeightCapSetEvent {
            dao_id,
            proposal_id,
            cap,
        }
        .publish(&env);
    }

    /// Anchor the eligibility-attestation root the weighted circuit proves
    /// against.
    ///
    /// The SBT contract issues per-member attestations binding `(mintedAt,
    /// reputation)`; this is the commitment the proof must open against. It is
    /// the on-chain link that stops a voter from claiming an age and reputation
    /// the DAO never attested to.
    pub fn set_attestation_root(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        root: U256,
        admin: Address,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
        Self::assert_in_field(&env, &root);

        let key = DataKey::AttestationRoot(dao_id, proposal_id);
        env.storage().persistent().set(&key, &root);
        Self::bump_persistent(&env, &key);
    }

    /// The configured weight cap, or [`MAX_SYBIL_WEIGHT`] when unset.
    pub fn sybil_weight_cap(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::SybilWeightCap(dao_id, proposal_id))
            .unwrap_or(MAX_SYBIL_WEIGHT)
    }

    /// The weighted tally for an election.
    pub fn weighted_tally(env: Env, dao_id: u64, proposal_id: u64) -> WeightedTally {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::WeightedTally(dao_id, proposal_id))
            .unwrap_or(WeightedTally {
                yes_weight: 0,
                no_weight: 0,
                yes_ballots: 0,
                no_ballots: 0,
            })
    }

    // ---------------------------------------------------------------------
    // Voting
    // ---------------------------------------------------------------------

    /// Cast a Sybil-weighted anonymous vote.
    ///
    /// Unlike [`Voting::vote_weighted`], which validates bounds and then falls
    /// through to a plain one-member-one-vote tally, this records the weight:
    /// the proof binds `vote_weight` to the member's attested SBT age and
    /// reputation, so a weight in the tally is a weight the circuit derived.
    ///
    /// The nullifier is the same one `vote` consumes, so a member cannot cast
    /// both a weighted and an unweighted ballot in the same election.
    pub fn vote_sybil_weighted(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool,
        nullifier: U256,
        root: U256,
        attestation_commitment: U256,
        snapshot_time: u64,
        vote_weight: u32,
        proof: Proof,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        Self::set_reentrancy_lock(&env);

        Self::assert_in_field(&env, &nullifier);
        Self::assert_in_field(&env, &root);
        Self::assert_in_field(&env, &attestation_commitment);

        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        // Weight bound, checked before anything else touches storage. This is
        // the defense-in-depth check: the circuit already caps the weight, so
        // reaching here means a VK or parameter mismatch, and continuing would
        // put an unintended weight into the tally.
        let cap = Self::sybil_weight_cap(env.clone(), dao_id, proposal_id);
        if vote_weight < BASE_SYBIL_WEIGHT {
            panic_with_error!(&env, VotingError::WeightOutOfRange);
        }
        if vote_weight > cap {
            panic_with_error!(&env, VotingError::WeightAboveSybilCap);
        }

        // Shared nullifier namespace with `vote` — one ballot per member per
        // election, whichever circuit produced it.
        let null_key = crate::storage::nullifier_used_key(dao_id, proposal_id, nullifier.clone());
        if env.storage().persistent().has(&null_key) {
            panic_with_error!(&env, VotingError::NullifierUsed);
        }

        let prop_key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&prop_key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::InvalidState));

        if proposal.state != ProposalState::Active {
            panic_with_error!(&env, VotingError::VotingClosed);
        }
        let now = env.ledger().timestamp();
        if proposal.end_time != 0 && now > proposal.end_time {
            panic_with_error!(&env, VotingError::VotingClosed);
        }
        if root != proposal.eligible_root {
            panic_with_error!(&env, VotingError::RootMismatch);
        }

        // Checks-effects-interactions: burn the nullifier before verifying.
        env.storage().persistent().set(&null_key, &true);
        Self::bump_persistent(&env, &null_key);

        let vk: VerificationKey = env
            .storage()
            .persistent()
            .get(&DataKey::SybilVotingKey(dao_id))
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet));

        // Mirrors `vote`: an election without an explicit config is treated as
        // unbounded in candidate count rather than rejected, so enabling
        // weighting does not require backfilling configs on old proposals.
        let election_config: ElectionConfig = env
            .storage()
            .persistent()
            .get(&DataKey::ElectionConfig(dao_id, proposal_id))
            .unwrap_or(ElectionConfig {
                snapshot_ledger: 0,
                min_balance: 0,
                twab_window: 0,
                candidate_seed: None,
                num_candidates: 0,
                vdf_output: None,
                vdf_delay: 0,
                max_revotes: 0,
                merkle_root_set_at: None,
                commitment_window: 0,
            });

        let vote_choice_index: u32 = if vote_choice { 1 } else { 0 };
        if election_config.num_candidates > 0 && vote_choice_index >= election_config.num_candidates
        {
            panic_with_error!(&env, VotingError::InvalidCandidateIndex);
        }

        // Public signal order must match `circuits/sybil_weighted_vote.circom`.
        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            U256::from_u128(&env, dao_id as u128),
            U256::from_u128(&env, proposal_id as u128),
            U256::from_u32(&env, vote_choice_index),
            U256::from_u32(&env, election_config.num_candidates),
            U256::from_u128(&env, snapshot_time as u128),
            attestation_commitment,
            U256::from_u32(&env, vote_weight),
        ];

        if !Self::verify_groth16(&env, &vk, &proof, &pub_signals) {
            panic_with_error!(&env, VotingError::InvalidProof);
        }

        // Weighted tally, kept alongside the head-count so a DAO can see both
        // what the weighting decided and whether it changed the outcome.
        let tally_key = DataKey::WeightedTally(dao_id, proposal_id);
        let mut tally: WeightedTally =
            env.storage()
                .persistent()
                .get(&tally_key)
                .unwrap_or(WeightedTally {
                    yes_weight: 0,
                    no_weight: 0,
                    yes_ballots: 0,
                    no_ballots: 0,
                });

        if vote_choice {
            tally.yes_weight = tally
                .yes_weight
                .checked_add(vote_weight as u64)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
            tally.yes_ballots = tally
                .yes_ballots
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
            proposal.yes_votes = proposal
                .yes_votes
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        } else {
            tally.no_weight = tally
                .no_weight
                .checked_add(vote_weight as u64)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
            tally.no_ballots = tally
                .no_ballots
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
            proposal.no_votes = proposal
                .no_votes
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        }

        env.storage().persistent().set(&tally_key, &tally);
        Self::bump_persistent(&env, &tally_key);
        env.storage().persistent().set(&prop_key, &proposal);
        Self::bump_persistent(&env, &prop_key);

        Self::clear_reentrancy_lock(&env);

        WeightedVoteEvent {
            dao_id,
            proposal_id,
            choice: vote_choice,
            weight: vote_weight,
            nullifier,
        }
        .publish(&env);
    }
}
