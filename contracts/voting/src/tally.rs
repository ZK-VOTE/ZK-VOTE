//! Tally verification, result publication, and proposal lifecycle.
//!
//! Invariants:
//! - `num_votes` in a recursive tally must equal the number of spent nullifiers
//!   for the proposal; the nullifier accumulator is monotonic and opaque.
//! - Only a tally VK configured for the DAO may verify a tally proof; a failed
//!   pairing check never publishes a result.
//! - Proposal states form a DAG: Registration -> Active -> Closed -> Archived.
//!   Archived is terminal.

#[allow(unused_imports)]
use soroban_sdk::{
    panic_with_error, symbol_short, Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Vec, U256,
};
use soroban_sdk::xdr::ToXdr;

use crate::*;


/// Submit single aggregated recursive proof attesting to N votes cast in an election
pub(crate) fn submit_recursive_tally(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        num_votes: u64,
        yes_votes: u64,
        no_votes: u64,
        final_nullifier_acc: U256,
        proof: Proof,
    ) -> Result<(), VotingError> {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);

        let total_votes = yes_votes
            .checked_add(no_votes)
            .ok_or(VotingError::TallyOverflow)?;
        if total_votes != num_votes {
            return Err(VotingError::RecursiveProofInvalid);
        }

        crate::Voting::verify_tally_proof_data(
            &env,
            dao_id,
            proposal_id,
            &proof,
            num_votes,
            yes_votes,
            no_votes,
            &final_nullifier_acc,
        )?;

        let key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(VotingError::VotingClosed)?;

        if proposal.state != ProposalState::Active {
            return Err(VotingError::VotingClosed);
        }

        let now = env.ledger().timestamp();
        if now > proposal.end_time {
            return Err(VotingError::VotingClosed);
        }

        // Update proposal tallies with checked arithmetic
        proposal.yes_votes = proposal
            .yes_votes
            .checked_add(yes_votes)
            .ok_or(VotingError::TallyOverflow)?;
        proposal.no_votes = proposal
            .no_votes
            .checked_add(no_votes)
            .ok_or(VotingError::TallyOverflow)?;
        proposal.state = ProposalState::Closed;

        env.storage().persistent().set(&key, &proposal);
        crate::Voting::bump_persistent(&env, &key);

        let tally_info = RecursiveTallyInfo {
            num_votes,
            yes_votes,
            no_votes,
            final_nullifier_acc: final_nullifier_acc.clone(),
            finalized_at: now,
        };
        let tally_key = DataKey::RecursiveTally(dao_id, proposal_id);
        env.storage().persistent().set(&tally_key, &tally_info);
        crate::Voting::bump_persistent(&env, &tally_key);

        // Store tally proof for independent verification (#94)
        let proof_key = DataKey::TallyProof(dao_id, proposal_id);
        env.storage().persistent().set(&proof_key, &proof);
        crate::Voting::bump_persistent(&env, &proof_key);

        RecursiveTallySubmittedEvent {
            dao_id,
            proposal_id,
            num_votes,
            yes_votes,
            no_votes,
            final_nullifier_acc,
        }
        .publish(&env);

        Ok(())
    
}


/// Fetch recursive tally info for a proposal
pub(crate) fn get_recursive_tally(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> Option<RecursiveTallyInfo> {

        env.storage()
            .persistent()
            .get(&DataKey::RecursiveTally(dao_id, proposal_id))
    
}


/// Return the raw stored tally proof bytes without verification.
pub(crate) fn get_tally_proof(env: Env, dao_id: u64, proposal_id: u64) -> Option<Bytes> {

        let proof: Option<Proof> = env
            .storage()
            .persistent()
            .get(&DataKey::TallyProof(dao_id, proposal_id));
        proof.map(|proof| proof.to_xdr(&env))
    
}


/// Return the current nullifier accumulator for an election.
pub(crate) fn get_nullifier_accumulator(env: Env, dao_id: u64, proposal_id: u64) -> U256 {

        crate::Voting::bump_instance(&env);
        env.storage()
            .persistent()
            .get(&DataKey::NullifierAccumulator(dao_id, proposal_id))
            .unwrap_or(U256::from_u32(&env, 0))
    
}


/// Verify the tally SNARK proof for a finalized election.
///
/// Recomputes the public signals from the on-chain proposal and recursive
/// tally, then performs the Groth16 pairing check. A wrong tally, or a
/// proof for a different election, is rejected with
/// [`VotingError::TallyProofInvalid`].
pub(crate) fn verify_tally_proof(env: Env, dao_id: u64, proposal_id: u64) -> Result<(), VotingError> {

        crate::Voting::bump_instance(&env);

        let proof_key = DataKey::TallyProof(dao_id, proposal_id);
        let proof: Proof = env
            .storage()
            .persistent()
            .get(&proof_key)
            .ok_or(VotingError::TallyProofMissing)?;
        crate::Voting::bump_persistent(&env, &proof_key);

        let tally_key = DataKey::RecursiveTally(dao_id, proposal_id);
        let tally: RecursiveTallyInfo = env
            .storage()
            .persistent()
            .get(&tally_key)
            .ok_or(VotingError::TallyProofMissing)?;
        crate::Voting::bump_persistent(&env, &tally_key);

        crate::Voting::verify_tally_proof_data(
            &env,
            dao_id,
            proposal_id,
            &proof,
            tally.num_votes,
            tally.yes_votes,
            tally.no_votes,
            &tally.final_nullifier_acc,
        )
    
}


/// Check if a nullifier has been used for a specific election.
///
/// Requires election identity `(dao_id, proposal_id)` — never queries a
/// global nullifier namespace (issue #64).
pub(crate) fn is_nullifier_used(env: Env, dao_id: u64, proposal_id: u64, nullifier: U256) -> bool {

        crate::Voting::bump_instance(&env);
        let key = storage::nullifier_used_key(dao_id, proposal_id, nullifier);
        env.storage().temporary().has(&key) || env.storage().persistent().has(&key)
    
}


/// Verify a voter receipt by checking if the nullifier was recorded
/// (used for Individual Verifiability of votes without revealing the choice)
pub(crate) fn verify_receipt(env: Env, dao_id: u64, proposal_id: u64, nullifier: U256) -> bool {

        crate::Voting::is_nullifier_used(env, dao_id, proposal_id, nullifier)
    
}


/// Alias for [`Self::is_nullifier_used`] matching the issue #64 naming.
pub(crate) fn has_nullifier_been_used(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        nullifier: U256,
    ) -> bool {

        crate::Voting::is_nullifier_used(env, dao_id, proposal_id, nullifier)
    
}


/// Migrate a legacy globally-scoped nullifier into election-scoped storage.
///
/// Moves `LegacyNullifierUsed(nullifier)` → `Nullifier(dao_id, proposal_id, nullifier)`
/// and deletes the legacy entry. Returns `true` if a legacy entry was migrated.
pub(crate) fn migrate_nullifier(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        nullifier: U256,
        admin: Address,
    ) -> bool {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        admin.require_auth();
        crate::Voting::assert_admin(&env, dao_id, &admin);
        crate::Voting::assert_in_field(&env, PathContext::Anonymous, &nullifier);

        if nullifier == U256::from_u32(&env, 0) {
            panic_with_error!(&env, VotingError::InvalidNullifier);
        }

        let legacy_key = storage::legacy_nullifier_used_key(nullifier.clone());
        if !env.storage().persistent().has(&legacy_key) {
            return false;
        }

        let scoped_key = storage::nullifier_used_key(dao_id, proposal_id, nullifier.clone());
        env.storage().persistent().set(&scoped_key, &true);
        crate::Voting::bump_persistent(&env, &scoped_key);
        crate::Voting::accumulate_nullifier(&env, dao_id, proposal_id, &nullifier);
        env.storage().persistent().remove(&legacy_key);
        true
    
}


/// Get results for a proposal (yes_votes, no_votes)
pub(crate) fn get_results(env: Env, dao_id: u64, proposal_id: u64) -> (u64, u64) {

        let proposal = crate::Voting::get_proposal(env, dao_id, proposal_id);
        (proposal.yes_votes, proposal.no_votes)
    
}


/// Close a proposal explicitly (idempotent). End time still enforced in vote.
pub(crate) fn close_proposal(env: Env, dao_id: u64, proposal_id: u64, admin: Address) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        admin.require_auth();
        crate::Voting::assert_admin(&env, dao_id, &admin);
        let key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");

        // Allow idempotent close (already Closed = no-op); reject invalid transitions (e.g. Archived → Closed).
        if proposal.state != ProposalState::Closed
            && !proposal.state.is_valid_transition(ProposalState::Closed)
        {
            panic_with_error!(&env, VotingError::InvalidState);
        }
        if proposal.state != ProposalState::Closed {
            proposal.state = ProposalState::Closed;
            env.storage().persistent().set(&key, &proposal);
            crate::Voting::bump_persistent(&env, &key);
            ProposalClosedEvent {
                dao_id,
                proposal_id,
                closed_by: admin,
            }
            .publish(&env);
        }
    
}


/// Archive a proposal (idempotent). Prevents further votes and signals off-chain cleanup.
pub(crate) fn archive_proposal(env: Env, dao_id: u64, proposal_id: u64, admin: Address) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        admin.require_auth();
        crate::Voting::assert_admin(&env, dao_id, &admin);
        let key = DataKey::Proposal(dao_id, proposal_id);
        let mut proposal: ProposalInfo = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");

        // Allow idempotent archive (already Archived = no-op); reject invalid transitions (e.g. Active → Archived).
        if proposal.state != ProposalState::Archived
            && !proposal.state.is_valid_transition(ProposalState::Archived)
        {
            panic_with_error!(&env, VotingError::InvalidState);
        }
        if proposal.state != ProposalState::Archived {
            proposal.state = ProposalState::Archived;
            env.storage().persistent().set(&key, &proposal);
            crate::Voting::bump_persistent(&env, &key);
            ProposalArchivedEvent {
                dao_id,
                proposal_id,
                archived_by: admin,
            }
            .publish(&env);
        }
    
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tally_circuit_shape_is_stable() {
        assert_eq!(TALLY_NUM_PUBLIC_SIGNALS, 6);
        assert_eq!(TALLY_CIRCUIT_IC_LEN, TALLY_NUM_PUBLIC_SIGNALS + 1);
        assert_eq!(MAX_IC_LENGTH, 21);
    }
}
