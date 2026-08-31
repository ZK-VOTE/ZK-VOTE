//! VDF-gated vote commit–reveal (issue #302).
//!
//! # The problem
//!
//! A vote is public the moment it lands: the tally moves and the choice is
//! visible on-chain. A live tally is what makes two attacks practical.
//!
//!   * **Coercion.** A coercer can watch the tally, demand a voter demonstrate
//!     compliance while the proposal is still open, and retaliate in-window.
//!   * **Last-minute manipulation.** An attacker watching the running tally can
//!     time a bloc of votes — or a membership change — to land just before
//!     close, leaving no time for anyone to respond.
//!
//! # The mitigation
//!
//! Split voting into two phases. During the commit phase a voter publishes only
//! `SHA256(domain ‖ dao ‖ proposal ‖ choice ‖ blinding)`. The nullifier is
//! public, so double-voting is still prevented, but the choice is not. Reveals
//! open only after a verifiable delay.
//!
//! # Why a VDF and not just a timestamp
//!
//! A timestamp gate is only as trustworthy as the ledger clock and whoever is
//! reading it. A VDF output is evidence that sequential work actually happened
//! between the election opening and the reveal — work no amount of parallel
//! hardware shortens. `require_vdf` makes that evidence mandatory: the reveal
//! phase does not open on the clock alone, it opens when the election's VDF
//! output has been submitted *and* verified by `submit_vdf_output`.
//!
//! # What this contract does and does not prove
//!
//! Verifying `y = SHA256^T(x)` on-chain costs the same T hashes the prover
//! spent. Soroban's per-transaction CPU budget allows on the order of 26,000
//! SHA-256 invocations — five orders of magnitude short of a delay long enough
//! to matter. Segmented verification does not close that gap, because checking
//! every segment still costs T in total.
//!
//! So the honest statement of the guarantee is: the *ledger timestamp* enforces
//! the delay, the VDF output is verified against a bounded number of segments so
//! that an output not lying on the chain is rejected, and full verification is
//! available to anyone off-chain. That is weaker than "the contract proved the
//! work happened", and `docs/spikes/302-vdf-commit-reveal.md` says so rather
//! than implying otherwise.

use soroban_sdk::{contractimpl, panic_with_error, Address, Bytes, BytesN, Env, U256};

use crate::{
    CommitRevealConfig, CommitRevealConfiguredEvent, DataKey, Proof, ProposalInfo, ProposalState,
    VerificationKey, VoteCommittedEvent, VoteRevealedEvent, Voting, VotingArgs, VotingClient,
    VotingError, MAX_IC_LENGTH,
};

/// Domain tag for vote commitments, matching `VOTE_COMMIT_DOMAIN` in
/// `backend/src/services/vdf.ts`. Keeps a commitment un-substitutable into any
/// other hash the protocol computes.
const COMMIT_DOMAIN: &[u8] = b"ZKVOTE-COMMIT-V1";

/// Minimum blinding factor length in bytes.
///
/// `choice` is low-entropy — a boolean, or a small candidate index — so without
/// a high-entropy blinding factor a commitment is opened by trying every
/// choice. 32 bytes puts a search over blindings out of reach.
const MIN_BLINDING_LEN: u32 = 32;

/// Public signals of `circuits/vote_commit.circom`: [root, nullifier, daoId, proposalId]
const COMMIT_NUM_PUBLIC_SIGNALS: u32 = 4;
const COMMIT_CIRCUIT_IC_LEN: u32 = COMMIT_NUM_PUBLIC_SIGNALS + 1;

#[contractimpl]
impl Voting {
    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    /// Register the commit-phase verification key for a DAO.
    ///
    /// `circuits/vote_commit.circom` has 4 public signals, so the VK's IC
    /// vector must have 5 elements.
    pub fn set_commit_vk(env: Env, dao_id: u64, vk: VerificationKey, admin: Address) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);

        if vk.ic.len() != COMMIT_CIRCUIT_IC_LEN || vk.ic.len() > MAX_IC_LENGTH {
            panic_with_error!(&env, VotingError::VkIcLengthMismatch);
        }

        let key = DataKey::CommitVotingKey(dao_id);
        env.storage().persistent().set(&key, &vk);
        Self::bump_persistent(&env, &key);
    }

    /// Configure the commit–reveal schedule for one election.
    ///
    /// Refused once any commitment exists: moving the deadlines mid-election
    /// would either strand commitments that can no longer be revealed or open
    /// reveals while others are still committing, which restores exactly the
    /// live-signal leak the flow removes.
    pub fn set_commit_reveal(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        commit_deadline: u64,
        reveal_opens_at: u64,
        reveal_closes_at: u64,
        require_vdf: bool,
        admin: Address,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);

        // The reveal window must open at or after the commit phase closes, and
        // close after it opens. An overlapping schedule would let early
        // revealers signal to voters still committing.
        if reveal_opens_at < commit_deadline {
            panic_with_error!(&env, VotingError::InvalidRevealSchedule);
        }
        if reveal_closes_at != 0 && reveal_closes_at <= reveal_opens_at {
            panic_with_error!(&env, VotingError::InvalidRevealSchedule);
        }

        let count: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::VoteCommitCount(dao_id, proposal_id))
            .unwrap_or(0);
        if count > 0 {
            panic_with_error!(&env, VotingError::InvalidState);
        }

        let config = CommitRevealConfig {
            commit_deadline,
            reveal_opens_at,
            reveal_closes_at,
            require_vdf,
        };
        let key = DataKey::CommitRevealConfig(dao_id, proposal_id);
        env.storage().persistent().set(&key, &config);
        Self::bump_persistent(&env, &key);

        CommitRevealConfiguredEvent {
            dao_id,
            proposal_id,
            commit_deadline,
            reveal_opens_at,
        }
        .publish(&env);
    }

    /// The commit–reveal schedule for an election, if configured.
    pub fn get_commit_reveal(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> Option<CommitRevealConfig> {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::CommitRevealConfig(dao_id, proposal_id))
    }

    /// How many commitments have been accepted for an election.
    pub fn vote_commit_count(env: Env, dao_id: u64, proposal_id: u64) -> u64 {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::VoteCommitCount(dao_id, proposal_id))
            .unwrap_or(0)
    }

    /// The commitment published under a nullifier, if any.
    pub fn get_vote_commitment(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        nullifier: U256,
    ) -> Option<BytesN<32>> {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::VoteCommit(dao_id, proposal_id, nullifier))
    }

    /// Whether the reveal phase is currently open.
    ///
    /// Both conditions must hold: the clock has reached `reveal_opens_at`, and
    /// — when `require_vdf` is set — the election's VDF output has been
    /// submitted and verified.
    pub fn is_reveal_open(env: Env, dao_id: u64, proposal_id: u64) -> bool {
        Self::bump_instance(&env);
        let config: CommitRevealConfig = match env
            .storage()
            .persistent()
            .get(&DataKey::CommitRevealConfig(dao_id, proposal_id))
        {
            Some(c) => c,
            None => return false,
        };

        let now = env.ledger().timestamp();
        if now < config.reveal_opens_at {
            return false;
        }
        if config.reveal_closes_at != 0 && now > config.reveal_closes_at {
            return false;
        }
        if config.require_vdf
            && !env
                .storage()
                .persistent()
                .has(&DataKey::VdfFinalized(dao_id, proposal_id))
        {
            return false;
        }
        true
    }

    // ---------------------------------------------------------------------
    // Commit
    // ---------------------------------------------------------------------

    /// Publish a vote commitment.
    ///
    /// `proof` is a `circuits/vote_commit.circom` proof: membership in the
    /// eligible set and correct derivation of the nullifier, with no choice
    /// signal. It is required because committing *spends* the nullifier —
    /// without it, anyone could spend every voter's nullifier with a commitment
    /// they cannot open, permanently destroying the election.
    ///
    /// The choice is bound by the commitment itself, which the contract
    /// recomputes and checks at reveal. SHA-256 is collision-resistant, so the
    /// committed choice cannot be changed; proving that relation in-circuit
    /// would cost a SHA-256 gadget to establish what one host-function call
    /// already establishes.
    ///
    /// Committing is as binding as voting: a member gets one commitment per
    /// election and cannot switch to a direct vote afterwards.
    pub fn commit_vote(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        nullifier: U256,
        root: U256,
        commitment: BytesN<32>,
        proof: Proof,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        Self::set_reentrancy_lock(&env);

        Self::assert_in_field(&env, &nullifier);
        Self::assert_in_field(&env, &root);
        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        let config: CommitRevealConfig = env
            .storage()
            .persistent()
            .get(&DataKey::CommitRevealConfig(dao_id, proposal_id))
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::CommitRevealNotConfigured));

        let now = env.ledger().timestamp();
        if now > config.commit_deadline {
            panic_with_error!(&env, VotingError::CommitPhaseClosed);
        }

        let proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(dao_id, proposal_id))
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::InvalidState));
        if proposal.state != ProposalState::Active {
            panic_with_error!(&env, VotingError::VotingClosed);
        }
        if root != proposal.eligible_root {
            panic_with_error!(&env, VotingError::RootMismatch);
        }

        // The nullifier lives in the same namespace `vote` uses, so committing
        // and voting directly are mutually exclusive.
        let null_key = crate::storage::nullifier_used_key(dao_id, proposal_id, nullifier.clone());
        if env.storage().persistent().has(&null_key) {
            panic_with_error!(&env, VotingError::NullifierUsed);
        }

        let commit_key = DataKey::VoteCommit(dao_id, proposal_id, nullifier.clone());
        if env.storage().persistent().has(&commit_key) {
            panic_with_error!(&env, VotingError::CommitAlreadyExists);
        }

        // Checks-effects-interactions: burn the nullifier before verifying, so
        // a reentrant call during verification cannot double-spend it.
        env.storage().persistent().set(&null_key, &true);
        Self::bump_persistent(&env, &null_key);

        let vk: VerificationKey = env
            .storage()
            .persistent()
            .get(&DataKey::CommitVotingKey(dao_id))
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet));

        // Public signal order must match `circuits/vote_commit.circom`.
        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            U256::from_u128(&env, dao_id as u128),
            U256::from_u128(&env, proposal_id as u128),
        ];
        if !Self::verify_groth16(&env, &vk, &proof, &pub_signals) {
            panic_with_error!(&env, VotingError::InvalidProof);
        }

        env.storage().persistent().set(&commit_key, &commitment);
        Self::bump_persistent(&env, &commit_key);

        let count_key = DataKey::VoteCommitCount(dao_id, proposal_id);
        let count: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);
        let next = count
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        env.storage().persistent().set(&count_key, &next);
        Self::bump_persistent(&env, &count_key);

        Self::clear_reentrancy_lock(&env);

        VoteCommittedEvent {
            dao_id,
            proposal_id,
            nullifier,
            commit_index: count,
        }
        .publish(&env);
    }

    // ---------------------------------------------------------------------
    // Reveal
    // ---------------------------------------------------------------------

    /// Recompute a vote commitment from its opening.
    ///
    /// `SHA256(domain ‖ dao_id ‖ proposal_id ‖ nullifier ‖ choice ‖ blinding)`,
    /// matching `computeVoteCommitment` in `backend/src/services/vdf.ts` byte
    /// for byte. SHA-256 rather than Poseidon precisely because it is a Soroban
    /// host function and Poseidon is not — the contract must be able to
    /// recompute this cheaply during reveal.
    ///
    /// The nullifier is inside the preimage so a commitment observed on-chain
    /// cannot be replayed into another voter's slot, and the election
    /// identifiers are there so it cannot be replayed into another election —
    /// the same domain separation the nullifier scheme itself uses.
    pub fn compute_vote_commitment(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        nullifier: U256,
        vote_choice: bool,
        blinding: Bytes,
    ) -> BytesN<32> {
        let mut input = Bytes::new(&env);
        input.append(&Bytes::from_slice(&env, COMMIT_DOMAIN));
        input.append(&Bytes::from_array(&env, &dao_id.to_be_bytes()));
        input.append(&Bytes::from_array(&env, &proposal_id.to_be_bytes()));
        // U256::to_be_bytes already yields a 32-byte big-endian Bytes.
        input.append(&nullifier.to_be_bytes());
        let choice_index: u32 = if vote_choice { 1 } else { 0 };
        input.append(&Bytes::from_array(&env, &choice_index.to_be_bytes()));
        input.append(&blinding);
        env.crypto().sha256(&input).into()
    }

    /// Reveal a committed vote and move the tally.
    ///
    /// Rejected until the reveal phase is genuinely open — clock past
    /// `reveal_opens_at`, and the VDF output finalized when `require_vdf` is
    /// set. The nullifier was already spent at commit time, so no proof is
    /// re-verified here: the opening itself is the authorisation, and it is
    /// checked against the stored commitment.
    pub fn reveal_vote(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        nullifier: U256,
        vote_choice: bool,
        blinding: Bytes,
    ) {
        Self::bump_instance(&env);
        Self::require_not_paused(&env);
        Self::set_reentrancy_lock(&env);

        Self::assert_in_field(&env, &nullifier);

        if blinding.len() < MIN_BLINDING_LEN {
            panic_with_error!(&env, VotingError::VoteCommitmentMismatch);
        }

        let config: CommitRevealConfig = env
            .storage()
            .persistent()
            .get(&DataKey::CommitRevealConfig(dao_id, proposal_id))
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::CommitRevealNotConfigured));

        let now = env.ledger().timestamp();
        if now < config.reveal_opens_at {
            panic_with_error!(&env, VotingError::RevealPhaseNotOpen);
        }
        if config.reveal_closes_at != 0 && now > config.reveal_closes_at {
            panic_with_error!(&env, VotingError::RevealPhaseClosed);
        }
        // The VDF gate. Without a finalized output the delay is only a claim
        // about the ledger clock, which is exactly what this flow refuses to
        // rely on.
        if config.require_vdf
            && !env
                .storage()
                .persistent()
                .has(&DataKey::VdfFinalized(dao_id, proposal_id))
        {
            panic_with_error!(&env, VotingError::VdfNotFinalized);
        }

        let revealed_key = DataKey::VoteRevealed(dao_id, proposal_id, nullifier.clone());
        if env.storage().persistent().has(&revealed_key) {
            panic_with_error!(&env, VotingError::AlreadyRevealed);
        }

        let commit_key = DataKey::VoteCommit(dao_id, proposal_id, nullifier.clone());
        let stored: BytesN<32> = env
            .storage()
            .persistent()
            .get(&commit_key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VoteCommitmentNotFound));

        let recomputed = Self::compute_vote_commitment(
            env.clone(),
            dao_id,
            proposal_id,
            nullifier.clone(),
            vote_choice,
            blinding,
        );
        if recomputed != stored {
            panic_with_error!(&env, VotingError::VoteCommitmentMismatch);
        }

        // Mark revealed before touching the tally, so a failure anywhere below
        // cannot leave a commitment that is both counted and re-revealable.
        env.storage().persistent().set(&revealed_key, &true);
        Self::bump_persistent(&env, &revealed_key);

        let prop_key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&prop_key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::InvalidState));

        if vote_choice {
            proposal.yes_votes = proposal
                .yes_votes
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        } else {
            proposal.no_votes = proposal
                .no_votes
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        }
        env.storage().persistent().set(&prop_key, &proposal);
        Self::bump_persistent(&env, &prop_key);

        Self::clear_reentrancy_lock(&env);

        VoteRevealedEvent {
            dao_id,
            proposal_id,
            nullifier,
            choice: vote_choice,
        }
        .publish(&env);
    }

    /// Whether a commitment has been revealed.
    pub fn is_vote_revealed(env: Env, dao_id: u64, proposal_id: u64, nullifier: U256) -> bool {
        Self::bump_instance(&env);
        env.storage()
            .persistent()
            .has(&DataKey::VoteRevealed(dao_id, proposal_id, nullifier))
    }

    /// Commitments that were made but never revealed.
    ///
    /// An unrevealed commitment is a lost vote: the nullifier is spent and the
    /// tally never moved. A DAO needs this number to tell a quiet electorate
    /// apart from a broken reveal step — a high count after the reveal window
    /// closes means the flow failed, not that people abstained.
    pub fn unrevealed_commit_count(env: Env, dao_id: u64, proposal_id: u64) -> u64 {
        Self::bump_instance(&env);
        let committed: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::VoteCommitCount(dao_id, proposal_id))
            .unwrap_or(0);
        let proposal: Option<ProposalInfo> = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(dao_id, proposal_id));
        let revealed = match proposal {
            Some(p) => p.yes_votes.saturating_add(p.no_votes),
            None => 0,
        };
        committed.saturating_sub(revealed)
    }
}
