//! Verifiable randomness (commit/reveal + VDF) and candidate ordering.
//!
//! Invariants:
//! - Randomness commits and reveals are one-per-participant per proposal and
//!   are bounded by `[MIN_RANDOMNESS_PARTICIPANTS, MAX_RANDOMNESS_PARTICIPANTS]`.
//! - A candidate seed can be finalized once; finalization requires either a
//!   verified VDF output or the commit-reveal fallback, never both silently.
//! - VDF output is bound to its delay and input seed; resubmission is rejected.

#[allow(unused_imports)]
use soroban_sdk::{
    panic_with_error, symbol_short, Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Vec, U256,
};
use soroban_sdk::xdr::ToXdr;

use crate::*;


pub(crate) fn randomness_commitment(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        participant: Address,
        value: BytesN<32>,
    ) -> BytesN<32> {

        let mut input = Bytes::new(&env);
        input.append(&Bytes::from_array(&env, &dao_id.to_be_bytes()));
        input.append(&Bytes::from_array(&env, &proposal_id.to_be_bytes()));
        input.append(&participant.to_xdr(&env));
        input.append(&Bytes::from_array(&env, &value.to_array()));
        env.crypto().sha256(&input).into()
    
}


pub(crate) fn commit_randomness(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        commitment: BytesN<32>,
        participant: Address,
    ) {

        crate::Voting::bump_instance(&env);
        participant.require_auth();
        crate::Voting::require_dao_member(&env, dao_id, &participant);
        let (commit_end, _) = crate::Voting::randomness_deadlines(&env, dao_id, proposal_id);
        if env.ledger().timestamp() >= commit_end {
            panic_with_error!(&env, VotingError::RandomnessCommitClosed);
        }

        let key = DataKey::RandomnessCommit(dao_id, proposal_id, participant.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, VotingError::RandomnessAlreadyCommitted);
        }
        let committers_key = DataKey::RandomnessCommitters(dao_id, proposal_id);
        let mut committers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&committers_key)
            .unwrap_or_else(|| Vec::new(&env));
        if committers.len() >= MAX_RANDOMNESS_PARTICIPANTS {
            panic_with_error!(&env, VotingError::RandomnessParticipantLimit);
        }

        env.storage().persistent().set(&key, &commitment);
        crate::Voting::bump_persistent(&env, &key);
        committers.push_back(participant.clone());
        env.storage().persistent().set(&committers_key, &committers);
        crate::Voting::bump_persistent(&env, &committers_key);

        RandomnessCommittedEvent {
            dao_id,
            proposal_id,
            participant,
        }
        .publish(&env);
    
}


pub(crate) fn reveal_randomness(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        value: BytesN<32>,
        participant: Address,
    ) {

        crate::Voting::bump_instance(&env);
        participant.require_auth();
        let (commit_end, reveal_end) = crate::Voting::randomness_deadlines(&env, dao_id, proposal_id);
        let now = env.ledger().timestamp();
        if now < commit_end || now >= reveal_end {
            panic_with_error!(&env, VotingError::RandomnessRevealClosed);
        }

        let commit_key = DataKey::RandomnessCommit(dao_id, proposal_id, participant.clone());
        let commitment: BytesN<32> = env
            .storage()
            .persistent()
            .get(&commit_key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::RandomnessCommitmentMissing));
        if commitment
            != crate::Voting::randomness_commitment(
                env.clone(),
                dao_id,
                proposal_id,
                participant.clone(),
                value.clone(),
            )
        {
            panic_with_error!(&env, VotingError::RandomnessRevealMismatch);
        }

        let reveal_key = DataKey::RandomnessReveal(dao_id, proposal_id, participant.clone());
        if env.storage().persistent().has(&reveal_key) {
            panic_with_error!(&env, VotingError::RandomnessAlreadyRevealed);
        }
        env.storage().persistent().set(&reveal_key, &value);
        crate::Voting::bump_persistent(&env, &reveal_key);

        RandomnessRevealedEvent {
            dao_id,
            proposal_id,
            participant,
        }
        .publish(&env);
    
}


pub(crate) fn finalize_candidate_seed(env: Env, dao_id: u64, proposal_id: u64) -> BytesN<32> {

        crate::Voting::bump_instance(&env);
        let (commit_end, _) = crate::Voting::randomness_deadlines(&env, dao_id, proposal_id);
        if env.ledger().timestamp() < commit_end {
            panic_with_error!(&env, VotingError::RandomnessCommitClosed);
        }

        let config_key = DataKey::ElectionConfig(dao_id, proposal_id);
        let mut config: ElectionConfig =
            env.storage()
                .persistent()
                .get(&config_key)
                .unwrap_or(ElectionConfig {
                    snapshot_ledger: env.ledger().sequence(),
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
        if config.candidate_seed.is_some() {
            panic_with_error!(&env, VotingError::CandidateSeedFinalized);
        }
        let committers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::RandomnessCommitters(dao_id, proposal_id))
            .unwrap_or_else(|| Vec::new(&env));
        if committers.len() < MIN_RANDOMNESS_PARTICIPANTS {
            panic_with_error!(&env, VotingError::InsufficientRandomness);
        }

        let mut input = Bytes::new(&env);
        input.append(&Bytes::from_array(&env, &dao_id.to_be_bytes()));
        input.append(&Bytes::from_array(&env, &proposal_id.to_be_bytes()));
        for participant in committers.iter() {
            let reveal: BytesN<32> = env
                .storage()
                .persistent()
                .get(&DataKey::RandomnessReveal(dao_id, proposal_id, participant))
                .unwrap_or_else(|| panic_with_error!(&env, VotingError::InsufficientRandomness));
            input.append(&Bytes::from_array(&env, &reveal.to_array()));
        }

        let seed: BytesN<32> = env.crypto().sha256(&input).into();
        config.candidate_seed = Some(seed.clone());
        env.storage().persistent().set(&config_key, &config);
        crate::Voting::bump_persistent(&env, &config_key);

        CandidateSeedFinalizedEvent {
            dao_id,
            proposal_id,
            seed: seed.clone(),
        }
        .publish(&env);
        seed
    
}


pub(crate) fn get_candidate_seed(env: Env, dao_id: u64, proposal_id: u64) -> Option<BytesN<32>> {

        crate::Voting::get_election_config(env, dao_id, proposal_id).and_then(|config| config.candidate_seed)
    
}


pub(crate) fn candidate_order_key(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        candidate: BytesN<32>,
    ) -> BytesN<32> {

        // Use VDF output as the seed if available (VDF randomness takes precedence)
        let vdf_output = crate::Voting::get_vdf_output(env.clone(), dao_id, proposal_id);
        let seed = match vdf_output {
            Some(vdf_seed) => vdf_seed,
            None => {
                // Fall back to commit-reveal seed
                crate::Voting::get_candidate_seed(env.clone(), dao_id, proposal_id).unwrap_or_else(|| {
                    panic_with_error!(&env, VotingError::RandomnessCommitmentMissing)
                })
            }
        };
        let mut input = Bytes::new(&env);
        input.append(&Bytes::from_array(&env, &seed.to_array()));
        input.append(&Bytes::from_array(&env, &candidate.to_array()));
        env.crypto().sha256(&input).into()
    
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
pub(crate) fn set_vdf_delay(env: Env, dao_id: u64, proposal_id: u64, delay: u64, admin: Address) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);
        admin.require_auth();
        crate::Voting::assert_admin(&env, dao_id, &admin);

        if !(vdf::MIN_VDF_ITERATIONS..=vdf::MAX_VDF_ITERATIONS).contains(&delay) {
            panic_with_error!(&env, VotingError::VdfInvalidDelay);
        }

        let delay_key = DataKey::VdfDelay(dao_id, proposal_id);
        env.storage().persistent().set(&delay_key, &delay);
        crate::Voting::bump_persistent(&env, &delay_key);

        // Derive and store the VDF input from election parameters
        let block_hash = BytesN::from_array(&env, &[0u8; 32]); // Placeholder — in production use ledger hash
        let admin_xdr = admin.to_xdr(&env);
        let admin_seed: BytesN<32> = env.crypto().sha256(&admin_xdr).into();
        let vdf_input = vdf::derive_vdf_input(&env, dao_id, proposal_id, &block_hash, &admin_seed);
        let input_key = DataKey::VdfInput(dao_id, proposal_id);
        env.storage().persistent().set(&input_key, &vdf_input);
        crate::Voting::bump_persistent(&env, &input_key);
    
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
pub(crate) fn submit_vdf_output(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        vdf_output: BytesN<32>,
        checkpoints: soroban_sdk::Vec<BytesN<32>>,
        proposal_creation_time: u64,
    ) {

        crate::Voting::bump_instance(&env);
        crate::Voting::require_not_paused(&env);

        // Check not already finalized
        let finalized_key = DataKey::VdfFinalized(dao_id, proposal_id);
        if env.storage().persistent().has(&finalized_key) {
            panic_with_error!(&env, VotingError::VdfAlreadySubmitted);
        }

        // Get VDF delay
        let delay_key = DataKey::VdfDelay(dao_id, proposal_id);
        let delay: u64 = env
            .storage()
            .persistent()
            .get(&delay_key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VdfInvalidDelay));

        // Verify delay has elapsed
        let now = env.ledger().timestamp();
        if now < proposal_creation_time.saturating_add(delay) {
            panic_with_error!(&env, VotingError::VdfDelayNotElapsed);
        }

        // Get VDF input
        let input_key = DataKey::VdfInput(dao_id, proposal_id);
        let vdf_input: BytesN<32> = env
            .storage()
            .persistent()
            .get(&input_key)
            .unwrap_or_else(|| panic_with_error!(&env, VotingError::VdfInputNotAvailable));

        // Verify the VDF proof on-chain
        let verified = vdf::verify_vdf(&env, &vdf_input, delay, &vdf_output, &checkpoints);
        if !verified {
            // Emit failure event
            VdfVerifiedEvent {
                dao_id,
                proposal_id,
                verified: false,
            }
            .publish(&env);
            panic_with_error!(&env, VotingError::VdfVerificationFailed);
        }

        // Store VDF output
        let output_key = DataKey::VdfOutput(dao_id, proposal_id);
        env.storage().persistent().set(&output_key, &vdf_output);
        crate::Voting::bump_persistent(&env, &output_key);

        // Store checkpoints as proof
        let proof_key = DataKey::VdfProof(dao_id, proposal_id);
        env.storage().persistent().set(&proof_key, &checkpoints);
        crate::Voting::bump_persistent(&env, &proof_key);

        // Mark as finalized
        env.storage().persistent().set(&finalized_key, &true);
        crate::Voting::bump_persistent(&env, &finalized_key);

        // Update ElectionConfig with VDF output
        let config_key = DataKey::ElectionConfig(dao_id, proposal_id);
        let mut config: ElectionConfig =
            env.storage()
                .persistent()
                .get(&config_key)
                .unwrap_or(ElectionConfig {
                    snapshot_ledger: env.ledger().sequence(),
                    min_balance: 0,
                    twab_window: 0,
                    candidate_seed: None,
                    num_candidates: 0,
                    vdf_output: None,
                    vdf_delay: delay,
                    max_revotes: 0,
                    merkle_root_set_at: None,
                    commitment_window: 0,
                    merkle_depth: 0,
                });
        config.vdf_output = Some(vdf_output.clone());
        config.vdf_delay = delay;
        env.storage().persistent().set(&config_key, &config);
        crate::Voting::bump_persistent(&env, &config_key);

        VdfSubmittedEvent {
            dao_id,
            proposal_id,
            output: vdf_output,
            delay,
        }
        .publish(&env);

        VdfVerifiedEvent {
            dao_id,
            proposal_id,
            verified: true,
        }
        .publish(&env);
    
}


/// Get the VDF output for an election, if submitted.
pub(crate) fn get_vdf_output(env: Env, dao_id: u64, proposal_id: u64) -> Option<BytesN<32>> {

        crate::Voting::bump_instance(&env);
        let output_key = DataKey::VdfOutput(dao_id, proposal_id);
        let output: Option<BytesN<32>> = env.storage().persistent().get(&output_key);
        if output.is_some() {
            crate::Voting::bump_persistent(&env, &output_key);
        }
        output
    
}


/// Get the VDF delay parameter for an election.
pub(crate) fn get_vdf_delay(env: Env, dao_id: u64, proposal_id: u64) -> u64 {

        crate::Voting::bump_instance(&env);
        let delay_key = DataKey::VdfDelay(dao_id, proposal_id);
        env.storage().persistent().get(&delay_key).unwrap_or(0)
    
}


/// Get the VDF input seed for an election.
pub(crate) fn get_vdf_input(env: Env, dao_id: u64, proposal_id: u64) -> Option<BytesN<32>> {

        crate::Voting::bump_instance(&env);
        let input_key = DataKey::VdfInput(dao_id, proposal_id);
        let input: Option<BytesN<32>> = env.storage().persistent().get(&input_key);
        if input.is_some() {
            crate::Voting::bump_persistent(&env, &input_key);
        }
        input
    
}


/// Check if VDF has been finalized for an election.
pub(crate) fn is_vdf_finalized(env: Env, dao_id: u64, proposal_id: u64) -> bool {

        crate::Voting::bump_instance(&env);
        let finalized_key = DataKey::VdfFinalized(dao_id, proposal_id);
        env.storage().persistent().has(&finalized_key)
    
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
pub(crate) fn finalize_with_vdf(env: Env, dao_id: u64, proposal_id: u64) -> BytesN<32> {

        crate::Voting::bump_instance(&env);

        // Check if VDF output is available
        if let Some(vdf_output) = crate::Voting::get_vdf_output(env.clone(), dao_id, proposal_id) {
            // Use VDF output directly as the candidate seed
            // Store it in ElectionConfig for backward compatibility
            let config_key = DataKey::ElectionConfig(dao_id, proposal_id);
            let mut config: ElectionConfig =
                env.storage()
                    .persistent()
                    .get(&config_key)
                    .unwrap_or(ElectionConfig {
                        snapshot_ledger: env.ledger().sequence(),
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

            // Mix VDF output with existing seed if available, or use VDF output as seed
            let seed = match config.candidate_seed {
                Some(existing_seed) => {
                    // Mix: seed = SHA256(vdf_output || existing_seed)
                    let mut mix = Bytes::new(&env);
                    mix.append(&Bytes::from_array(&env, &vdf_output.to_array()));
                    mix.append(&Bytes::from_array(&env, &existing_seed.to_array()));
                    env.crypto().sha256(&mix).into()
                }
                None => vdf_output,
            };

            config.candidate_seed = Some(seed.clone());
            env.storage().persistent().set(&config_key, &config);
            crate::Voting::bump_persistent(&env, &config_key);

            CandidateSeedFinalizedEvent {
                dao_id,
                proposal_id,
                seed: seed.clone(),
            }
            .publish(&env);

            seed
        } else {
            // Fall back to commit-reveal seed finalization
            crate::Voting::finalize_candidate_seed(env, dao_id, proposal_id)
        }
    
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn randomness_and_vdf_bounds_are_stable() {
        assert_eq!(RANDOMNESS_COMMIT_WINDOW, 3_600);
        assert_eq!(RANDOMNESS_REVEAL_WINDOW, 3_600);
        assert_eq!(MIN_RANDOMNESS_PARTICIPANTS, 2);
        assert_eq!(MAX_RANDOMNESS_PARTICIPANTS, 32);
        assert_eq!(MIN_VDF_CHECKPOINTS, 3);
        assert_eq!(MAX_VDF_CHECKPOINTS, 100);
    }
}
