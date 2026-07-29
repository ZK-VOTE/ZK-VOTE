//! ZK Quadratic Voting with range proofs (issue #50).
//!
//! Adds a `VoteMode::Quadratic` proposal flow on top of the existing anonymous
//! voting contract. A member allocates voice credits across several proposals in
//! a single Groth16 proof produced by `circuits/quadratic_vote.circom`. The proof:
//!
//!   * proves Merkle membership (same commitment scheme as `vote`),
//!   * derives a domain-separated nullifier (one ballot per round),
//!   * reveals only the quadratic cost `sum(voiceCredits_i^2)` and a Poseidon
//!     commitment to the (hidden) per-proposal allocations, and
//!   * proves every allocation is in `[0, MAX_CREDITS]` (range proof) and the
//!     total is `<= MAX_BUDGET` — so overspending is impossible.
//!
//! Public signals (order must match the circuit `main`):
//!   [root, daoId, proposalId, nullifier, totalCreditsSpent, allocationsHash]
//!
//! ## Tally
//! Individual ballots keep their allocations private on-chain. The per-proposal
//! tally is aggregated **off-chain** (see `backend/src/routes/quadratic.ts`) and
//! the aggregate result is committed on-chain via `record_qv_tally`, which
//! verifies a single Groth16 tally proof against the DAO's registered QV-tally
//! verification key. The recursive tally *proving* circuit that binds each reveal
//! to its `allocationsHash` is intentionally deferred (see the PR description);
//! the on-chain verification and storage path is implemented here.

use soroban_sdk::{
    contractimpl, panic_with_error, symbol_short, Address, Env, IntoVal, String, Vec, U256,
};

use crate::{
    CurveId, DataKey, Proof, ProposalInfo, ProposalState, QvBallot, QvTallyEvent, QvVoteEvent,
    VerificationKey, VoteMode, Voting, VotingArgs, VotingClient, VotingError, MAX_CID_LEN,
    MAX_IC_LENGTH, MAX_QV_BUDGET, MAX_TITLE_LEN, QV_CIRCUIT_IC_LEN,
};

#[contractimpl]
impl Voting {
    // ---------------------------------------------------------------------
    // Verification-key management
    // ---------------------------------------------------------------------

    /// Set the quadratic-voting verification key for a DAO (admin only).
    ///
    /// The QV circuit has 6 public signals, so the VK's IC vector must have 7
    /// elements. Versioned independently from the plain-vote VK so a DAO can run
    /// both circuits.
    pub fn set_qv_vk(env: Env, dao_id: u64, vk: VerificationKey, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
        Self::validate_qv_vk(&env, &vk);

        let version_key = DataKey::QvVkVersion(dao_id);
        let current: u32 = env.storage().persistent().get(&version_key).unwrap_or(0);
        let new_version = current + 1;
        env.storage().persistent().set(&version_key, &new_version);
        Self::bump_persistent(&env, &version_key);

        let key = DataKey::QvVotingKey(dao_id);
        env.storage().persistent().set(&key, &vk);
        Self::bump_persistent(&env, &key);

        let ver_key = DataKey::QvVkByVersion(dao_id, new_version);
        env.storage().persistent().set(&ver_key, &vk);
        Self::bump_persistent(&env, &ver_key);
    }

    /// Set the quadratic-tally verification key for a DAO (admin only).
    ///
    /// The tally circuit's public-signal count depends on the number of
    /// proposals in a round, so only an upper bound on the IC length is checked
    /// here; the exact length is enforced per-round in `record_qv_tally`.
    pub fn set_qv_tally_vk(env: Env, dao_id: u64, vk: VerificationKey, admin: Address) {
        Self::bump_instance(&env);
        admin.require_auth();
        Self::assert_admin(&env, dao_id, &admin);
        if vk.ic.len() < 2 || vk.ic.len() > MAX_IC_LENGTH {
            panic_with_error!(&env, VotingError::VkIcTooLarge);
        }
        let key = DataKey::QvTallyKey(dao_id);
        env.storage().persistent().set(&key, &vk);
        Self::bump_persistent(&env, &key);
    }

    /// Current QV VK version for a DAO (0 = not set).
    pub fn qv_vk_version(env: Env, dao_id: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::QvVkVersion(dao_id))
            .unwrap_or(0)
    }

    fn validate_qv_vk(env: &Env, vk: &VerificationKey) {
        if vk.ic.len() != QV_CIRCUIT_IC_LEN {
            panic_with_error!(env, VotingError::VkIcLengthMismatch);
        }
    }

    fn get_qv_vk_by_version(env: &Env, dao_id: u64, version: u32) -> VerificationKey {
        env.storage()
            .persistent()
            .get(&DataKey::QvVkByVersion(dao_id, version))
            .unwrap_or_else(|| panic_with_error!(env, VotingError::QvVkNotSet))
    }

    // ---------------------------------------------------------------------
    // Proposal creation
    // ---------------------------------------------------------------------

    /// Create a quadratic-voting proposal (a "round" a member allocates across).
    ///
    /// Mirrors `create_proposal` (SBT membership + members-can-propose checks and
    /// a Merkle-root snapshot) but pins the QV verification key rather than the
    /// plain-vote VK, and marks the proposal `VoteMode::Quadratic`.
    pub fn create_qv_proposal(
        env: Env,
        dao_id: u64,
        title: String,
        content_cid: String,
        end_time: u64,
        creator: Address,
    ) -> u64 {
        Self::bump_instance(&env);
        creator.require_auth();

        if title.len() > MAX_TITLE_LEN {
            panic_with_error!(&env, VotingError::TitleTooLong);
        }
        if content_cid.len() > MAX_CID_LEN {
            panic_with_error!(&env, VotingError::InvalidContentCid);
        }

        // Resolve tree -> sbt -> registry and require SBT membership.
        let tree_contract: Address = Self::tree_contract(env.clone());
        let sbt_contract: Address = env.invoke_contract(
            &tree_contract,
            &symbol_short!("sbt_contr"),
            soroban_sdk::vec![&env],
        );
        let registry: Address = env.invoke_contract(
            &sbt_contract,
            &symbol_short!("registry"),
            soroban_sdk::vec![&env],
        );
        let has_sbt: bool = env.invoke_contract(
            &sbt_contract,
            &symbol_short!("has"),
            soroban_sdk::vec![&env, dao_id.into_val(&env), creator.clone().into_val(&env)],
        );
        if !has_sbt {
            panic_with_error!(&env, VotingError::NotDaoMember);
        }

        let members_can_propose: bool = env.invoke_contract(
            &registry,
            &soroban_sdk::Symbol::new(&env, "members_can_propose"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );
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
        if end_time != 0 && end_time <= now {
            panic_with_error!(&env, VotingError::EndTimeInvalid);
        }

        // Pin the current QV VK by version + hash.
        let qv_version: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::QvVkVersion(dao_id))
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::QvVkNotSet));
        if qv_version == 0 {
            panic_with_error!(&env, VotingError::QvVkNotSet);
        }
        let qv_vk = Self::get_qv_vk_by_version(&env, dao_id, qv_version);
        let vk_hash = Self::hash_vk(&env, &qv_vk);

        // Snapshot the eligible-voter Merkle root.
        let eligible_root: U256 = env.invoke_contract(
            &tree_contract,
            &symbol_short!("get_root"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );
        let earliest_root_index: u32 = env.invoke_contract(
            &tree_contract,
            &symbol_short!("curr_idx"),
            soroban_sdk::vec![&env, dao_id.into_val(&env)],
        );

        let proposal_id = Self::next_proposal_id(&env, dao_id);
        let proposal = ProposalInfo {
            id: proposal_id,
            dao_id,
            title,
            content_cid,
            yes_votes: 0,
            no_votes: 0,
            end_time,
            created_by: creator,
            created_at: now,
            state: ProposalState::Active,
            vk_hash,
            vk_version: qv_version,
            eligible_root,
            vote_mode: VoteMode::Quadratic,
            earliest_root_index,
            snapshot_ledger: env.ledger().sequence(),
        };

        let key = DataKey::Proposal(dao_id, proposal_id);
        env.storage().persistent().set(&key, &proposal);
        Self::bump_persistent(&env, &key);

        let curve_key = DataKey::ProposalCurve(dao_id, proposal_id);
        env.storage().persistent().set(&curve_key, &CurveId::Bn254);
        Self::bump_persistent(&env, &curve_key);

        proposal_id
    }

    // ---------------------------------------------------------------------
    // Casting a quadratic ballot
    // ---------------------------------------------------------------------

    /// Submit a quadratic-voting ballot with its ZK proof.
    ///
    /// `total_credits_spent` is the revealed quadratic cost `sum(voiceCredits^2)`
    /// and `allocations_hash` is the Poseidon commitment binding the (hidden)
    /// per-proposal allocations. The circuit already proves every allocation is
    /// in range and the total is within budget; the budget bound is re-checked
    /// here as defense in depth.
    pub fn cast_qv_vote(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        nullifier: U256,
        root: U256,
        total_credits_spent: u64,
        allocations_hash: U256,
        proof: Proof,
    ) {
        Self::bump_instance(&env);

        // Field-bounds validation on all field-element public signals.
        Self::assert_in_field(&env, &nullifier);
        Self::assert_in_field(&env, &root);
        Self::assert_in_field(&env, &allocations_hash);

        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        // Budget cap (also enforced in-circuit).
        if total_credits_spent > MAX_QV_BUDGET {
            panic_with_error!(&env, VotingError::QvBudgetExceeded);
        }

        // One ballot per (dao, round, nullifier).
        let ballot_key = DataKey::QvBallot(dao_id, proposal_id, nullifier.clone());
        if env.storage().persistent().has(&ballot_key) {
            panic_with_error!(&env, VotingError::NullifierUsed);
        }

        // Load proposal and check it is an active quadratic round.
        let prop_key = DataKey::Proposal(dao_id, proposal_id);
        let proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&prop_key)
            .expect("proposal not found");

        if proposal.vote_mode != VoteMode::Quadratic {
            panic_with_error!(&env, VotingError::NotQuadraticProposal);
        }
        let now = env.ledger().timestamp();
        if proposal.state != ProposalState::Active {
            panic_with_error!(&env, VotingError::VotingClosed);
        }
        if proposal.end_time != 0 && now > proposal.end_time {
            panic_with_error!(&env, VotingError::VotingClosed);
        }

        // Quadratic rounds use snapshot (Fixed) semantics for eligibility.
        if root != proposal.eligible_root {
            panic_with_error!(&env, VotingError::RootMismatch);
        }

        // Verify the QV VK pinned at proposal creation is unchanged.
        let vk = Self::get_qv_vk_by_version(&env, dao_id, proposal.vk_version);
        if Self::hash_vk(&env, &vk) != proposal.vk_hash {
            panic_with_error!(&env, VotingError::VkChanged);
        }

        // Public signals must match circuit order:
        // [root, daoId, proposalId, nullifier, totalCreditsSpent, allocationsHash]
        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            U256::from_u128(&env, dao_id as u128),
            U256::from_u128(&env, proposal_id as u128),
            nullifier.clone(),
            U256::from_u128(&env, total_credits_spent as u128),
            allocations_hash.clone(),
        ];

        if !Self::verify_groth16(&env, &vk, &proof, &pub_signals) {
            panic_with_error!(&env, VotingError::InvalidProof);
        }

        // Store the ballot commitment.
        let ballot = QvBallot {
            allocations_hash,
            total_credits_spent,
        };
        env.storage().persistent().set(&ballot_key, &ballot);
        Self::bump_persistent(&env, &ballot_key);

        // Increment ballot count and running credit total for the round.
        let count_key = DataKey::QvBallotCount(dao_id, proposal_id);
        let count: u64 = env.storage().persistent().get(&count_key).unwrap_or(0);
        env.storage().persistent().set(&count_key, &(count + 1));
        Self::bump_persistent(&env, &count_key);

        let credits_key = DataKey::QvCreditsTotal(dao_id, proposal_id);
        let credits: u128 = env.storage().persistent().get(&credits_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&credits_key, &(credits + total_credits_spent as u128));
        Self::bump_persistent(&env, &credits_key);

        QvVoteEvent {
            dao_id,
            proposal_id,
            nullifier,
            total_credits_spent,
        }
        .publish(&env);
    }

    // ---------------------------------------------------------------------
    // Tally
    // ---------------------------------------------------------------------

    /// Commit an off-chain-computed quadratic tally, verified on-chain.
    ///
    /// `proposal_ids[i]` receives `tallies[i]` total voice credits for the round
    /// `round_id`. A single Groth16 tally proof is verified against the DAO's
    /// registered QV-tally VK; its public signals are
    /// `[round_id, proposal_ids..., tallies...]`. On success the per-proposal
    /// totals are stored and the round is marked finalized.
    pub fn record_qv_tally(
        env: Env,
        dao_id: u64,
        round_id: u64,
        proposal_ids: Vec<u64>,
        tallies: Vec<u64>,
        tally_proof: Proof,
    ) {
        Self::bump_instance(&env);

        let n = proposal_ids.len();
        if n == 0 || n != tallies.len() {
            panic_with_error!(&env, VotingError::QvTallyLengthMismatch);
        }

        // The round must be an existing quadratic proposal.
        let proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(dao_id, round_id))
            .expect("proposal not found");
        if proposal.vote_mode != VoteMode::Quadratic {
            panic_with_error!(&env, VotingError::NotQuadraticProposal);
        }

        // Load the tally VK.
        let vk: VerificationKey = env
            .storage()
            .persistent()
            .get(&DataKey::QvTallyKey(dao_id))
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::QvTallyVkNotSet));

        // Build public signals: [round_id, proposal_ids..., tallies...].
        let mut pub_signals: Vec<U256> = soroban_sdk::vec![&env];
        pub_signals.push_back(U256::from_u128(&env, round_id as u128));
        for i in 0..n {
            let pid = proposal_ids.get(i).unwrap();
            pub_signals.push_back(U256::from_u128(&env, pid as u128));
        }
        for i in 0..n {
            let t = tallies.get(i).unwrap();
            pub_signals.push_back(U256::from_u128(&env, t as u128));
        }

        if !Self::verify_groth16(&env, &vk, &tally_proof, &pub_signals) {
            panic_with_error!(&env, VotingError::InvalidProof);
        }

        // Persist per-proposal tallies.
        for i in 0..n {
            let pid = proposal_ids.get(i).unwrap();
            let t = tallies.get(i).unwrap();
            let key = DataKey::QvTally(dao_id, round_id, pid);
            env.storage().persistent().set(&key, &t);
            Self::bump_persistent(&env, &key);
        }

        let fin_key = DataKey::QvTallyFinalized(dao_id, round_id);
        env.storage().persistent().set(&fin_key, &true);
        Self::bump_persistent(&env, &fin_key);

        QvTallyEvent {
            dao_id,
            round_id,
            ballots: Self::qv_ballot_count(env.clone(), dao_id, round_id),
        }
        .publish(&env);
    }

    // ---------------------------------------------------------------------
    // Getters
    // ---------------------------------------------------------------------

    /// Number of quadratic ballots cast in a round.
    pub fn qv_ballot_count(env: Env, dao_id: u64, round_id: u64) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::QvBallotCount(dao_id, round_id))
            .unwrap_or(0)
    }

    /// Sum of quadratic credits spent across all ballots in a round.
    pub fn qv_credits_total(env: Env, dao_id: u64, round_id: u64) -> u128 {
        env.storage()
            .persistent()
            .get(&DataKey::QvCreditsTotal(dao_id, round_id))
            .unwrap_or(0)
    }

    /// Whether a nullifier has already cast a ballot in a round.
    pub fn is_qv_nullifier_used(env: Env, dao_id: u64, round_id: u64, nullifier: U256) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::QvBallot(dao_id, round_id, nullifier))
    }

    /// Fetch a stored ballot commitment by its nullifier.
    pub fn get_qv_ballot(env: Env, dao_id: u64, round_id: u64, nullifier: U256) -> QvBallot {
        env.storage()
            .persistent()
            .get(&DataKey::QvBallot(dao_id, round_id, nullifier))
            .expect("ballot not found")
    }

    /// Final per-proposal credit tally for a round (0 if not tallied / no credits).
    pub fn get_qv_tally(env: Env, dao_id: u64, round_id: u64, proposal_id: u64) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::QvTally(dao_id, round_id, proposal_id))
            .unwrap_or(0)
    }

    /// Whether the tally for a round has been finalized on-chain.
    pub fn is_qv_tally_finalized(env: Env, dao_id: u64, round_id: u64) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::QvTallyFinalized(dao_id, round_id))
            .unwrap_or(false)
    }
}
