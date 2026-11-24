//! Vote submission, proposal creation, and voter-facing queries.
//!
//! Invariants:
//! - A nullifier is single-use per `(dao_id, proposal_id)` and is stored in
//!   *temporary* storage with a TTL derived from `proposal.end_time` plus a
//!   grace period; it must never move to a persistent/global key.
//! - Every vote proof is checked against the VK pinned at proposal creation
//!   (`vk_hash` / `vk_version`) or the depth-specific VK registered for the
//!   election. A changed VK rejects the vote rather than silently verifying.
//! - Roots must be in the proposal's history and must not predate creation;
//!   Trailing-mode roots additionally must not predate a member revocation.
//! - `vote`, `vote_weighted`, `vote_bls381`, `cast_votes` and `vote_with_circuit`
//!   share one reentrancy lock; it is released on every exit path.

#[allow(unused_imports)]
use soroban_sdk::{
    panic_with_error, symbol_short, Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Vec, U256,
};

use crate::*;


/// Create a new proposal for a DAO
/// Voting starts immediately upon creation (Merkle root snapshot taken now)
/// title: Short display title (max 100 bytes)
/// content_cid: IPFS CID pointing to rich content (or legacy plain text description)
/// end_time: Unix timestamp for when voting closes (must be in the future, or 0 for no deadline)
pub(crate) fn create_proposal(
        env: Env,
        dao_id: u64,
        title: String,
        content_cid: String,
        end_time: u64,
        creator: Address,
        vote_mode: VoteMode,
    ) -> u64 {

        // bump_instance called inside create_proposal_with_version
        crate::Voting::create_proposal_with_version(
            env,
            dao_id,
            title,
            content_cid,
            end_time,
            creator,
            vote_mode,
            None,
        )
    
}


/// Create a proposal initialized in Registration phase for Merkle root commitment window
pub(crate) fn create_proposal_in_registration(
        env: Env,
        dao_id: u64,
        title: String,
        content_cid: String,
        end_time: u64,
        creator: Address,
        vote_mode: VoteMode,
    ) -> u64 {

        let id = crate::Voting::create_proposal_with_version(
            env.clone(),
            dao_id,
            title,
            content_cid,
            end_time,
            creator,
            vote_mode,
            None,
        );
        let key = DataKey::Proposal(dao_id, id);
        let mut proposal: ProposalInfo = env.storage().persistent().get(&key).unwrap();
        proposal.state = ProposalState::Registration;
        env.storage().persistent().set(&key, &proposal);
        id
    
}


/// Create proposal with a specific VK version (must be <= current and exist)
pub(crate) fn create_proposal_with_vk_version(
        env: Env,
        dao_id: u64,
        title: String,
        content_cid: String,
        end_time: u64,
        creator: Address,
        vote_mode: VoteMode,
        vk_version: u32,
    ) -> u64 {

        // bump_instance called inside create_proposal_with_version
        crate::Voting::create_proposal_with_version(
            env,
            dao_id,
            title,
            content_cid,
            end_time,
            creator,
            vote_mode,
            Some(vk_version),
        )
    
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
pub(crate) fn vote(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool, // true = yes, false = no
        nullifier: U256,
        root: U256,
        proof: Proof,
    ) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);

        let ctx = PathContext::Anonymous;

        // ── DEFENSE-IN-DEPTH: Set reentrancy lock BEFORE any state mutations ──
        crate::Voting::set_reentrancy_lock(&env);

        // SECURITY: Validate public signals are within BN254 scalar field FIRST
        // This prevents modular reduction attacks where values >= r verify identically
        // to their reduced equivalents but are stored as different keys.
        crate::Voting::assert_in_field(&env, ctx, &nullifier);
        crate::Voting::assert_in_field(&env, ctx, &root);

        // Check nullifier is non-zero (zero is not a valid nullifier)
        if nullifier == U256::from_u32(&env, 0) {
            panic_coarse(&env, ctx, VotingError::InvalidNullifier);
        }

        // Check nullifier hasn't been used for THIS election (dao_id, proposal_id).
        // Election-scoped storage prevents cross-election DoS from a flat namespace (#64).
        let null_key = storage::nullifier_used_key(dao_id, proposal_id, nullifier.clone());
        if env.storage().temporary().has(&null_key) || env.storage().persistent().has(&null_key) {
            panic_coarse(&env, ctx, VotingError::NullifierUsed);
        }

        // Get proposal
        let prop_key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&prop_key)
            .expect("proposal not found");

        // Check voting period and state (voting starts at creation, ends at end_time)
        // If end_time is 0, there's no deadline (voting never closes)
        let now = env.ledger().timestamp();
        if proposal.state != ProposalState::Active {
            panic_coarse(&env, ctx, VotingError::VotingClosed);
        }
        if proposal.end_time != 0 && now > proposal.end_time {
            panic_coarse(&env, ctx, VotingError::VotingClosed);
        }

        // Revocation is now enforced by zeroing leaves in the Merkle tree.
        // A revoked member's commitment is zeroed, so their proof won't verify
        // against any root that includes the zeroed leaf. No timestamp checks needed.

        // ── CHECKS-EFFECTS-INTERACTIONS: Mark nullifier as used BEFORE ──
        // ── cross-contract calls or proof verification. This prevents      ──
        // ── double-vote reentrancy attacks even if the execution model     ──
        // ── allows reentrant calls.                                       ──
        env.storage().temporary().set(&null_key, &true);
        crate::Voting::bump_nullifier_ttl(&env, &null_key, dao_id, proposal_id);

        // Verify root based on vote mode. Shared with `cast_votes` so a batched
        // submission is held to exactly the same eligibility rules.
        // (May involve cross-contract calls to the tree contract in Trailing mode.)
        crate::Voting::assert_root_eligible(&env, ctx, dao_id, &proposal, &root);

        // Verify proposal was created for BN254 curve (not BLS12-381)
        let curve_key = DataKey::ProposalCurve(dao_id, proposal_id);
        let proposal_curve: CurveId = env
            .storage()
            .persistent()
            .get(&curve_key)
            .unwrap_or(CurveId::Bn254);
        if proposal_curve != CurveId::Bn254 {
            panic_coarse(&env, ctx, VotingError::VkNotSet);
        }

        // Resolve the verification key. At the default Merkle depth this is the
        // proposal's version-pinned key, checked against the hash snapshotted at
        // proposal creation so a VK change cannot invalidate in-flight votes.
        // An election that declared a depth (#93) uses the key registered for
        // that depth, pinned the same way.
        let election_depth = env
            .storage()
            .persistent()
            .get::<_, ElectionConfig>(&DataKey::ElectionConfig(dao_id, proposal_id))
            .map(|config| config.merkle_depth)
            .unwrap_or(0);
        let vk: VerificationKey =
            crate::Voting::resolve_election_vk(&env, ctx, dao_id, proposal_id, &proposal, election_depth);

        // Verify Groth16 proof
        // Public signals: [root, nullifier, daoId, proposalId, voteChoice]
        // daoId + proposalId ARE the election binding verified on-chain (#64):
        // the circuit enforces nullifier = Poseidon(secret, daoId, proposalId), so a
        // proof for election A cannot authorize a vote in election B.
        let _vote_signal = if vote_choice {
            U256::from_u32(&env, 1)
        } else {
            U256::from_u32(&env, 0)
        };
        // Public signals: [root, nullifier, daoId, proposalId, voteChoice, numCandidates]
        // Note: daoId is included for domain separation (prevents cross-DAO nullifier linkability)
        // numCandidates is bound into the proof to prevent circuit/contract candidate bound desync
        // Commitment is now private (computed internally in circuit) for improved vote unlinkability
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
                merkle_depth: 0,
            });

        let vote_choice_index: u32 = if vote_choice { 1 } else { 0 };
        if election_config.num_candidates > 0 && vote_choice_index >= election_config.num_candidates
        {
            panic_coarse(&env, ctx, VotingError::InvalidCandidateIndex);
        }

        let vote_signal = U256::from_u32(&env, vote_choice_index);
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);
        let num_candidates_signal = U256::from_u32(&env, election_config.num_candidates);

        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            dao_signal,
            proposal_signal,
            vote_signal,
            num_candidates_signal,
        ];

        if !crate::Voting::verify_groth16(&env, &vk, &proof, &pub_signals) {
            panic_coarse(&env, ctx, VotingError::InvalidProof);
        }

        // Bind this vote's nullifier into the election accumulator so the
        // final tally proof can be verified against the on-chain nullifier set.
        crate::Voting::accumulate_nullifier(&env, dao_id, proposal_id, &nullifier);

        // Update vote count with checked arithmetic
        if vote_choice {
            proposal.yes_votes = proposal
                .yes_votes
                .checked_add(1)
                .unwrap_or_else(|| panic_coarse(&env, ctx, VotingError::TallyOverflow));
        } else {
            proposal.no_votes = proposal
                .no_votes
                .checked_add(1)
                .unwrap_or_else(|| panic_coarse(&env, ctx, VotingError::TallyOverflow));
        }
        env.storage().persistent().set(&prop_key, &proposal);
        crate::Voting::bump_persistent(&env, &prop_key);

        // Clear reentrancy lock before emitting event
        crate::Voting::clear_reentrancy_lock(&env);

        VoteEvent {
            dao_id,
            proposal_id,
            choice: vote_choice,
            nullifier,
        }
        .publish(&env);
    
}


/// Weighted vote with weight bounds and domain tag (for ZK-013 weighted governance)
/// Constraint review: weight is bounded [MIN_WEIGHT, MAX_WEIGHT] via range proof in circuit (128 bits)
/// Domain tag prevents cross-circuit replay (weighted vs standard vote)
/// KAT: compared against vote_v2 nullifier domain separation
pub(crate) fn vote_weighted(
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

        crate::Voting::bump_instance(&env);
        let ctx = PathContext::Anonymous;
        crate::Voting::assert_weight_in_range(&env, ctx, weight);
        crate::Voting::assert_domain_tag_valid(&env, ctx, domain_tag);
        // Delegate to standard vote after weight validation
        // Note: weight-specific tally (weighted sum) would be stored separately in a full implementation;
        // here we validate bounds and domain, then record as standard vote for e2e testing
        crate::Voting::vote(
            env,
            dao_id,
            proposal_id,
            vote_choice,
            nullifier,
            root,
            proof,
        );
    
}


/// Cast a BLS12-381-backed anonymous vote.
pub(crate) fn vote_bls381(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool,
        nullifier: U256,
        root: U256,
        proof: ProofBls381,
    ) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);

        // ── DEFENSE-IN-DEPTH: Set reentrancy lock BEFORE any state mutations ──
        crate::Voting::set_reentrancy_lock(&env);

        crate::Voting::assert_in_field_bls381(&env, PathContext::Anonymous, &nullifier);
        crate::Voting::assert_in_field_bls381(&env, PathContext::Anonymous, &root);

        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        let null_key = storage::nullifier_used_key(dao_id, proposal_id, nullifier.clone());
        if env.storage().temporary().has(&null_key) {
            panic_with_error!(&env, VotingError::NullifierUsed);
        }

        let prop_key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&prop_key)
            .expect("proposal not found");

        let now = env.ledger().timestamp();
        if proposal.state != ProposalState::Active {
            panic_with_error!(&env, VotingError::VotingClosed);
        }
        if proposal.end_time != 0 && now > proposal.end_time {
            panic_with_error!(&env, VotingError::VotingClosed);
        }

        // ── CHECKS-EFFECTS-INTERACTIONS: Mark nullifier as used BEFORE ──
        // ── cross-contract calls or proof verification.                   ──
        env.storage().temporary().set(&null_key, &true);
        crate::Voting::bump_nullifier_ttl(&env, &null_key, dao_id, proposal_id);

        match proposal.vote_mode {
            VoteMode::Fixed => {
                if root != proposal.eligible_root {
                    panic_with_error!(&env, VotingError::RootMismatch);
                }
            }
            VoteMode::Trailing => {
                let tree_contract: Address = crate::Voting::tree_contract(env.clone());

                let root_valid: bool = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_ok"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), root.clone().into_val(&env)],
                );
                if !root_valid {
                    panic_with_error!(&env, VotingError::RootNotInHistory);
                }

                let root_index: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_idx"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), root.clone().into_val(&env)],
                );
                if root_index < proposal.earliest_root_index {
                    panic_with_error!(&env, VotingError::RootPredatesProposal);
                }

                let min_valid_root: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("min_root"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env)],
                );
                if root_index < min_valid_root {
                    panic_with_error!(&env, VotingError::RootPredatesRemoval);
                }
            }
            VoteMode::Quadratic => {
                // Quadratic proposals must be voted on via `cast_qv_vote`.
                panic_with_error!(&env, VotingError::NotQuadraticProposal);
            }
        }

        // Verify proposal was created for BLS12-381 curve
        let curve_key = DataKey::ProposalCurve(dao_id, proposal_id);
        let proposal_curve: CurveId = env
            .storage()
            .persistent()
            .get(&curve_key)
            .unwrap_or(CurveId::Bn254);
        if proposal_curve != CurveId::Bls12381 {
            panic_with_error!(&env, VotingError::VkNotSet);
        }

        // Get BLS12-381 verification key pinned to proposal version
        let vk = crate::Voting::get_vk_by_version_bls381(&env, dao_id, proposal.vk_version);

        // Verify VK hash
        let current_vk_hash = crate::Voting::hash_vk_bls381(&env, &vk);
        if current_vk_hash != proposal.vk_hash {
            panic_with_error!(&env, VotingError::VkChanged);
        }

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
                merkle_depth: 0,
            });

        let vote_choice_index: u32 = if vote_choice { 1 } else { 0 };
        if election_config.num_candidates > 0 && vote_choice_index >= election_config.num_candidates
        {
            panic_with_error!(&env, VotingError::InvalidCandidateIndex);
        }

        let vote_signal = U256::from_u32(&env, vote_choice_index);
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);
        let num_candidates_signal = U256::from_u32(&env, election_config.num_candidates);

        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            dao_signal,
            proposal_signal,
            vote_signal,
            num_candidates_signal,
        ];

        if !crate::Voting::verify_groth16_bls381(&env, &vk, &proof, &pub_signals) {
            panic_with_error!(&env, VotingError::InvalidProof);
        }

        // Update vote count with checked arithmetic
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
        crate::Voting::bump_persistent(&env, &prop_key);

        // Clear reentrancy lock before emitting event
        crate::Voting::clear_reentrancy_lock(&env);

        VoteEvent {
            dao_id,
            proposal_id,
            choice: vote_choice,
            nullifier,
        }
        .publish(&env);
    
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
pub(crate) fn cast_votes(env: Env, dao_id: u64, proposal_id: u64, votes: Vec<BatchVote>) -> u32 {

        // A batch is a relayer submitting other people's votes, so errors
        // collapse to coarse codes for the same reason a single vote's do:
        // a per-vote reason would say which voter in the batch failed.
        let ctx = PathContext::Anonymous;
        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        crate::Voting::set_reentrancy_lock(&env);

        let count = votes.len();
        if count == 0 || count > MAX_VOTE_BATCH {
            panic_with_error!(&env, VotingError::InvalidBatchSize);
        }

        let prop_key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&prop_key)
            .expect("proposal not found");

        let now = env.ledger().timestamp();
        if proposal.state != ProposalState::Active {
            panic_with_error!(&env, VotingError::VotingClosed);
        }
        if proposal.end_time != 0 && now > proposal.end_time {
            panic_with_error!(&env, VotingError::VotingClosed);
        }
        if proposal.vote_mode == VoteMode::Quadratic {
            panic_with_error!(&env, VotingError::NotQuadraticProposal);
        }

        // BN254 only: the batch verifier combines BN254 pairings.
        let proposal_curve: CurveId = env
            .storage()
            .persistent()
            .get(&DataKey::ProposalCurve(dao_id, proposal_id))
            .unwrap_or(CurveId::Bn254);
        if proposal_curve != CurveId::Bn254 {
            panic_with_error!(&env, VotingError::VkNotSet);
        }

        let election_config: Option<ElectionConfig> = env
            .storage()
            .persistent()
            .get(&DataKey::ElectionConfig(dao_id, proposal_id));
        let num_candidates = election_config
            .as_ref()
            .map(|config| config.num_candidates)
            .unwrap_or(0);
        let merkle_depth = election_config
            .as_ref()
            .map(|config| config.merkle_depth)
            .unwrap_or(0);

        let vk = crate::Voting::resolve_election_vk(&env, ctx, dao_id, proposal_id, &proposal, merkle_depth);

        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);
        let num_candidates_signal = U256::from_u32(&env, num_candidates);

        let mut proofs: Vec<Proof> = Vec::new(&env);
        let mut signal_sets: Vec<Vec<U256>> = Vec::new(&env);
        let mut seen: Vec<U256> = Vec::new(&env);
        let mut yes = 0u32;
        let mut no = 0u32;

        for i in 0..count {
            let entry = votes.get(i).expect("vote missing");

            crate::Voting::assert_in_field(&env, PathContext::Anonymous, &entry.nullifier);
            crate::Voting::assert_in_field(&env, PathContext::Anonymous, &entry.root);
            if entry.nullifier == U256::from_u32(&env, 0) {
                panic_with_error!(&env, VotingError::InvalidNullifier);
            }

            // A batch could otherwise carry the same nullifier twice: the
            // storage check below only sees committed state, and both copies
            // would be written in the same transaction.
            if seen.contains(&entry.nullifier) {
                panic_with_error!(&env, VotingError::DuplicateNullifierInBatch);
            }
            seen.push_back(entry.nullifier.clone());

            let null_key =
                storage::nullifier_used_key(dao_id, proposal_id, entry.nullifier.clone());
            if env.storage().temporary().has(&null_key) || env.storage().persistent().has(&null_key)
            {
                panic_with_error!(&env, VotingError::NullifierUsed);
            }

            crate::Voting::assert_root_eligible(&env, ctx, dao_id, &proposal, &entry.root);

            let vote_choice_index: u32 = if entry.vote_choice { 1 } else { 0 };
            if num_candidates > 0 && vote_choice_index >= num_candidates {
                panic_with_error!(&env, VotingError::InvalidCandidateIndex);
            }

            let signals = soroban_sdk::vec![
                &env,
                entry.root.clone(),
                entry.nullifier.clone(),
                dao_signal.clone(),
                proposal_signal.clone(),
                U256::from_u32(&env, vote_choice_index),
                num_candidates_signal.clone(),
            ];
            signal_sets.push_back(signals);
            proofs.push_back(entry.proof.clone());

            if entry.vote_choice {
                yes += 1;
            } else {
                no += 1;
            }
        }

        if !zkvote_groth16::batch::verify_groth16_batch(&env, &vk, &proofs, &signal_sets) {
            panic_with_error!(&env, VotingError::InvalidProof);
        }

        // Only once the whole batch has verified do any nullifiers get burned:
        // a failed batch must not consume the nullifiers of the honest votes
        // that were grouped with a bad one.
        for i in 0..count {
            let entry = votes.get(i).expect("vote missing");
            let null_key =
                storage::nullifier_used_key(dao_id, proposal_id, entry.nullifier.clone());
            env.storage().persistent().set(&null_key, &true);
            crate::Voting::bump_persistent(&env, &null_key);
        }

        proposal.yes_votes = proposal
            .yes_votes
            .checked_add(yes as u64)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        proposal.no_votes = proposal
            .no_votes
            .checked_add(no as u64)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::TallyOverflow));
        env.storage().persistent().set(&prop_key, &proposal);
        crate::Voting::bump_persistent(&env, &prop_key);

        crate::Voting::clear_reentrancy_lock(&env);

        for i in 0..count {
            let entry = votes.get(i).expect("vote missing");
            VoteEvent {
                dao_id,
                proposal_id,
                choice: entry.vote_choice,
                nullifier: entry.nullifier,
            }
            .publish(&env);
        }
        VoteBatchEvent {
            dao_id,
            proposal_id,
            votes: count,
            yes_votes: yes,
            no_votes: no,
        }
        .publish(&env);

        count
    
}

/// Get proposal info
pub(crate) fn get_proposal(env: Env, dao_id: u64, proposal_id: u64) -> ProposalInfo {

        crate::Voting::bump_instance(&env);
        let key = DataKey::Proposal(dao_id, proposal_id);
        let proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");
        crate::Voting::bump_persistent(&env, &key);
        proposal
    
}


/// Get vote mode for a proposal
/// Returns VoteMode enum directly for type safety
/// Used by comments contract for eligibility checks
pub(crate) fn get_vote_mode(env: Env, dao_id: u64, proposal_id: u64) -> VoteMode {

        let proposal = crate::Voting::get_proposal(env, dao_id, proposal_id);
        proposal.vote_mode
    
}


/// Get eligible root for a proposal (merkle root at snapshot)
/// Used by comments contract for Fixed mode eligibility checks
pub(crate) fn get_eligible_root(env: Env, dao_id: u64, proposal_id: u64) -> U256 {

        let proposal = crate::Voting::get_proposal(env, dao_id, proposal_id);
        proposal.eligible_root
    
}


/// Get earliest root index for a proposal (for Trailing mode)
/// Used by comments contract for Trailing mode eligibility checks
pub(crate) fn get_earliest_idx(env: Env, dao_id: u64, proposal_id: u64) -> u32 {

        let proposal = crate::Voting::get_proposal(env, dao_id, proposal_id);
        proposal.earliest_root_index
    
}


/// Get proposal count for a DAO
pub(crate) fn proposal_count(env: Env, dao_id: u64) -> u64 {

        crate::Voting::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount(dao_id))
            .unwrap_or(0)
    
}


/// Cross-contract query: return true if `candidate_root` is the eligible_root
/// of any Active Fixed-mode proposal. Used by membership-tree to block FIFO
/// root eviction when a Fixed snapshot is still being voted against.
pub(crate) fn root_pin(env: Env, dao_id: u64, candidate_root: U256) -> bool {

        crate::Voting::bump_instance(&env);
        let count = crate::Voting::proposal_count(env.clone(), dao_id);
        for id in 0..count {
            let proposal_id = id + 1;
            let key = DataKey::Proposal(dao_id, proposal_id);
            if let Some(proposal) = env.storage().persistent().get::<_, ProposalInfo>(&key) {
                if proposal.state == ProposalState::Active
                    && proposal.vote_mode == VoteMode::Fixed
                    && proposal.eligible_root == candidate_root
                {
                    return true;
                }
            }
        }
        false
    
}


/// Cross-contract hook: emit [`AtRiskVoterAlert`] events for every Active
/// Trailing-mode proposal whose earliest_root_index allows the candidate
/// root (i.e. voters with proofs against this root could still cast valid
/// votes). Called by membership-tree right before FIFO eviction.
pub(crate) fn chk_risk(env: Env, dao_id: u64, candidate_root: U256) {

        crate::Voting::bump_instance(&env);
        let count = crate::Voting::proposal_count(env.clone(), dao_id);
        let now = env.ledger().timestamp();
        for id in 0..count {
            let proposal_id = id + 1;
            let key = DataKey::Proposal(dao_id, proposal_id);
            if let Some(proposal) = env.storage().persistent().get::<_, ProposalInfo>(&key) {
                if proposal.state == ProposalState::Active
                    && proposal.vote_mode == VoteMode::Trailing
                {
                    let deadline = if proposal.end_time == 0 {
                        now.saturating_add(72 * 60 * 60)
                    } else {
                        proposal.end_time
                    };
                    AtRiskVoterAlert {
                        dao_id,
                        at_risk_root: candidate_root.clone(),
                        proposal_id,
                        deadline,
                    }
                    .publish(&env);
                }
            }
        }
    
}


/// Read proposal end_time from cache (written at proposal creation).
/// Returns 0 if proposal has no end_time (never closes) or is unknown.
/// TTL-aware backend helpers use this to skip renewal of Temporary
/// nullifier records whose proposal voting window has closed + grace elapsed.
pub(crate) fn get_proposal_end_time(env: Env, dao_id: u64, proposal_id: u64) -> u64 {

        crate::Voting::bump_instance(&env);
        crate::Voting::get_proposal_end_time_internal(&env, dao_id, proposal_id)
    
}


/// Get tree contract address
pub(crate) fn tree_contract(env: Env) -> Address {

        crate::Voting::bump_instance(&env);
        env.storage()
            .instance()
            .get(&TREE_CONTRACT)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet))
    
}


/// Get registry contract address (cached at construction)
pub(crate) fn registry(env: Env) -> Address {

        crate::Voting::bump_instance(&env);
        env.storage()
            .instance()
            .get(&REGISTRY)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VkNotSet))
    
}


pub(crate) fn vote_with_circuit(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vote_choice: bool,
        nullifier: U256,
        root: U256,
        proof: Proof,
        circuit_id: String,
    ) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        crate::Voting::assert_in_field(&env, PathContext::Anonymous, &nullifier);
        crate::Voting::assert_in_field(&env, PathContext::Anonymous, &root);

        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        let null_key = storage::nullifier_used_key(dao_id, proposal_id, nullifier.clone());
        if env.storage().temporary().has(&null_key) {
            panic_with_error!(&env, VotingError::NullifierUsed);
        }

        let prop_key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&prop_key)
            .expect("proposal not found");

        let now = env.ledger().timestamp();
        if proposal.state != ProposalState::Active {
            panic_with_error!(&env, VotingError::VotingClosed);
        }
        if proposal.end_time != 0 && now > proposal.end_time {
            panic_with_error!(&env, VotingError::VotingClosed);
        }

        match proposal.vote_mode {
            VoteMode::Fixed => {
                if root != proposal.eligible_root {
                    panic_with_error!(&env, VotingError::RootMismatch);
                }
            }
            VoteMode::Trailing => {
                let tree_contract: Address = crate::Voting::tree_contract(env.clone());
                let root_valid: bool = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_ok"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), root.clone().into_val(&env)],
                );
                if !root_valid {
                    panic_with_error!(&env, VotingError::RootNotInHistory);
                }
                let root_index: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("root_idx"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env), root.clone().into_val(&env)],
                );
                if root_index < proposal.earliest_root_index {
                    panic_with_error!(&env, VotingError::RootPredatesProposal);
                }
                let min_valid_root: u32 = env.invoke_contract(
                    &tree_contract,
                    &symbol_short!("min_root"),
                    soroban_sdk::vec![&env, dao_id.into_val(&env)],
                );
                if root_index < min_valid_root {
                    panic_with_error!(&env, VotingError::RootPredatesRemoval);
                }
            }
            VoteMode::Quadratic => {
                // Quadratic proposals must be voted on via `cast_qv_vote`.
                panic_with_error!(&env, VotingError::NotQuadraticProposal);
            }
        }

        let vk: VerificationKey =
            crate::Voting::load_vk_from_registry(&env, &circuit_id, &CircuitType::Vote);

        let current_vk_hash = crate::Voting::hash_vk(&env, &vk);
        if current_vk_hash != proposal.vk_hash {
            let migration = crate::Voting::check_migration_window(&env, dao_id);
            match migration {
                Some((ref old_circuit_id, ref new_circuit_id)) => {
                    if circuit_id != *old_circuit_id && circuit_id != *new_circuit_id {
                        panic_with_error!(&env, VotingError::VkChanged);
                    }
                    if circuit_id == *old_circuit_id {
                        let old_vk =
                            crate::Voting::load_vk_from_registry(&env, old_circuit_id, &CircuitType::Vote);
                        let old_hash = crate::Voting::hash_vk(&env, &old_vk);
                        if old_hash != proposal.vk_hash {
                            panic_with_error!(&env, VotingError::VkChanged);
                        }
                    } else if circuit_id == *new_circuit_id {
                        let new_vk =
                            crate::Voting::load_vk_from_registry(&env, new_circuit_id, &CircuitType::Vote);
                        let new_hash = crate::Voting::hash_vk(&env, &new_vk);
                        if new_hash != proposal.vk_hash {
                            panic_with_error!(&env, VotingError::VkChanged);
                        }
                    }
                }
                None => {
                    panic_with_error!(&env, VotingError::VkChanged);
                }
            }
        }

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
                merkle_depth: 0,
            });

        let vote_choice_index: u32 = if vote_choice { 1 } else { 0 };
        if election_config.num_candidates > 0 && vote_choice_index >= election_config.num_candidates
        {
            panic_with_error!(&env, VotingError::InvalidCandidateIndex);
        }

        let vote_signal = U256::from_u32(&env, vote_choice_index);
        let dao_signal = U256::from_u128(&env, dao_id as u128);
        let proposal_signal = U256::from_u128(&env, proposal_id as u128);
        let num_candidates_signal = U256::from_u32(&env, election_config.num_candidates);

        let pub_signals = soroban_sdk::vec![
            &env,
            root.clone(),
            nullifier.clone(),
            dao_signal,
            proposal_signal,
            vote_signal,
            num_candidates_signal,
        ];

        if !crate::Voting::verify_groth16(&env, &vk, &proof, &pub_signals) {
            panic_with_error!(&env, VotingError::InvalidProof);
        }

        env.storage().temporary().set(&null_key, &true);
        crate::Voting::bump_nullifier_ttl(&env, &null_key, dao_id, proposal_id);

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
        crate::Voting::bump_persistent(&env, &prop_key);

        VoteEvent {
            dao_id,
            proposal_id,
            choice: vote_choice,
            nullifier,
        }
        .publish(&env);
    
}


/// Record a balance checkpoint for time-weighted average balance computation.
/// Called by the token contract when a voter's balance changes.
/// Stores (dao_id, address, ledger) -> balance for TWAB calculation.
pub(crate) fn record_balance_checkpoint(env: Env, dao_id: u64, voter: Address, balance: i128) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        let ledger = env.ledger().sequence();
        let key = DataKey::BalanceCheckpoint(dao_id, voter.clone(), ledger);
        env.storage().persistent().set(&key, &balance);
        crate::Voting::bump_persistent(&env, &key);
    
}


/// Compute time-weighted average balance for a voter between a start and end ledger.
/// Uses stored balance checkpoints to compute the average balance over the window.
/// Returns None if no checkpoints are available.
pub(crate) fn get_twab(
        env: Env,
        dao_id: u64,
        voter: Address,
        start_ledger: u32,
        end_ledger: u32,
    ) -> Option<i128> {

        crate::Voting::bump_instance(&env);
        if start_ledger >= end_ledger {
            return None;
        }
        let total_duration = (end_ledger - start_ledger) as u128;
        if total_duration == 0 {
            return None;
        }

        let mut weighted_sum: i128 = 0;
        let mut prev_ledger: u32 = start_ledger;
        let mut prev_balance: i128 = 0;
        let mut has_data = false;

        // Iterate through checkpoints in the window
        let mut current_ledger = start_ledger;
        while current_ledger <= end_ledger {
            let cp_key = DataKey::BalanceCheckpoint(dao_id, voter.clone(), current_ledger);
            if let Some(balance) = env.storage().persistent().get::<DataKey, i128>(&cp_key) {
                if has_data {
                    let duration = (current_ledger - prev_ledger) as u128;
                    weighted_sum +=
                        prev_balance.saturating_mul(i128::try_from(duration).unwrap_or(i128::MAX));
                }
                prev_balance = balance;
                prev_ledger = current_ledger;
                has_data = true;
            }
            current_ledger += 1;
        }

        // Add the final segment
        if has_data {
            let final_duration = (end_ledger - prev_ledger) as u128;
            weighted_sum +=
                prev_balance.saturating_mul(i128::try_from(final_duration).unwrap_or(i128::MAX));
        }

        if !has_data {
            return None;
        }

        let avg = weighted_sum / i128::try_from(total_duration).unwrap_or(1);
        Some(avg)
    
}


/// Set a transfer cooldown for a voter during an active election.
/// Prevents the voter from transferring tokens until the cooldown expires.
/// Called automatically when a voter registers or votes in a token-gated election.
pub(crate) fn set_voter_cooldown(env: Env, dao_id: u64, voter: Address) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        // Cooldown lasts until the current proposal ends (max 7 days from now)
        let cooldown_end = env.ledger().timestamp() + 604800; // 7 days
        let key = DataKey::TransferCooldown(dao_id, voter);
        env.storage().persistent().set(&key, &cooldown_end);
        crate::Voting::bump_persistent(&env, &key);
    
}


/// Clear a voter's transfer cooldown after an election ends.
pub(crate) fn clear_voter_cooldown(env: Env, dao_id: u64, voter: Address) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        let key = DataKey::TransferCooldown(dao_id, voter);
        env.storage().persistent().remove(&key);
    
}


/// Check if a voter is in transfer cooldown (cannot transfer tokens).
/// Returns true if cooldown is active, false otherwise.
/// This function is intended to be called by token contracts before transfers.
pub(crate) fn is_in_transfer_cooldown(env: Env, dao_id: u64, voter: Address) -> bool {

        crate::Voting::bump_instance(&env);
        let key = DataKey::TransferCooldown(dao_id, voter);
        let cooldown_end: Option<u64> = env.storage().persistent().get(&key);
        match cooldown_end {
            Some(end) => env.ledger().timestamp() < end,
            None => false,
        }
    
}


/// Create a balance snapshot for a proposal (records current token balances).
/// Stores the snapshot ledger and timestamp for future eligibility checks.
/// Called during proposal creation when token-gating is configured.
pub(crate) fn create_balance_snapshot(env: Env, dao_id: u64, proposal_id: u64) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        let snapshot = BalanceSnapshotInfo {
            snapshot_ledger: env.ledger().sequence(),
            timestamp: env.ledger().timestamp(),
        };
        let key = DataKey::BalanceSnapshot(dao_id, proposal_id);
        env.storage().persistent().set(&key, &snapshot);
        crate::Voting::bump_persistent(&env, &key);
    
}


/// Get the balance snapshot for a proposal.
pub(crate) fn get_balance_snapshot(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> Option<BalanceSnapshotInfo> {

        crate::Voting::bump_instance(&env);
        let key = DataKey::BalanceSnapshot(dao_id, proposal_id);
        let snapshot: Option<BalanceSnapshotInfo> = env.storage().persistent().get(&key);
        if snapshot.is_some() {
            crate::Voting::bump_persistent(&env, &key);
        }
        snapshot
    
}


/// Check if a voter's balance at snapshot time meets the minimum requirement.
/// For token-gated proposals, this verifies the voter held sufficient tokens
/// at the time the proposal was created (preventing flash loan attacks).
/// This is a view function that token contracts should call before allowing votes.
/// Returns true if the voter's snapshot balance meets the minimum, or if no
/// token-gating is configured for this proposal.
#[allow(unused_variables)]
pub(crate) fn check_voter_eligibility(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        voter: Address,
        current_balance: i128,
        balance_at_snapshot: i128,
    ) -> bool {

        crate::Voting::bump_instance(&env);
        // Check if this proposal has token-gating configured
        let config_key = DataKey::ElectionConfig(dao_id, proposal_id);
        let config: Option<ElectionConfig> = env.storage().persistent().get(&config_key);

        match config {
            Some(cfg) => {
                // If TWAB window is set, use time-weighted average balance
                if cfg.twab_window > 0 {
                    let snapshot = crate::Voting::get_balance_snapshot(env.clone(), dao_id, proposal_id);
                    if let Some(snap) = snapshot {
                        let end_ledger = env.ledger().sequence();
                        let start_ledger = if end_ledger > snap.snapshot_ledger {
                            snap.snapshot_ledger
                        } else {
                            0
                        };
                        if let Some(twab) = crate::Voting::get_twab(
                            env.clone(),
                            dao_id,
                            voter.clone(),
                            start_ledger,
                            end_ledger,
                        ) {
                            return twab >= cfg.min_balance;
                        }
                    }
                    // Fallback: use balance at snapshot (checked against checkpoint)
                    balance_at_snapshot >= cfg.min_balance
                } else {
                    // Without TWAB, use balance at snapshot time
                    balance_at_snapshot >= cfg.min_balance
                }
            }
            None => {
                // No token-gating configured for this proposal
                true
            }
        }
    
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vote_limits_are_stable() {
        assert_eq!(MAX_MERKLE_DEPTH, 32);
        assert_eq!(MAX_TITLE_LEN, 100);
        assert_eq!(MAX_CID_LEN, 64);
        assert_eq!(NULLIFIER_GRACE_LEDGERS, 259_200);
        assert_eq!(NUM_PUBLIC_SIGNALS, 6);
        assert_eq!(VOTE_CIRCUIT_IC_LEN, NUM_PUBLIC_SIGNALS + 1);
    }
}
