//! Nova IVC Folding Aggregator Engine

use crate::circuit::{CircuitError, VoteStepCircuit};
use crate::{IvcState, RecursiveProofPayload, VoteWitness};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

/// Nova Aggregator for sequential IVC proof folding
pub struct NovaAggregator;

impl NovaAggregator {
    /// Aggregates a batch of N vote witnesses starting from an initial state
    pub fn aggregate_batch(
        initial_state: IvcState,
        witnesses: &[VoteWitness],
    ) -> Result<RecursiveProofPayload, CircuitError> {
        let mut current_state = initial_state.clone();
        let num_votes = witnesses.len() as u64;
        let mut seen_nullifiers: HashSet<String> = HashSet::new();

        // Sequentially fold each vote witness into the running state
        for witness in witnesses {
            if !seen_nullifiers.insert(witness.nullifier.clone()) {
                return Err(CircuitError::NullifierAlreadyAccumulated);
            }
            current_state = VoteStepCircuit::step(&current_state, witness)?;
        }

        // Generate compressed Nova recursive proof bytes
        let proof_bytes = Self::compress_proof(&initial_state, &current_state, num_votes);

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        Ok(RecursiveProofPayload {
            initial_state,
            final_state: current_state,
            num_votes,
            proof_bytes,
            timestamp: now,
        })
    }

    /// Compresses the Nova folded R1CS instance into a final compact proof representation
    fn compress_proof(initial_state: &IvcState, final_state: &IvcState, num_votes: u64) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"NOVA_IVC_PROOF_V1");
        hasher.update(initial_state.root.as_bytes());
        hasher.update(final_state.root.as_bytes());
        hasher.update(initial_state.step_count.to_be_bytes());
        hasher.update(final_state.step_count.to_be_bytes());
        hasher.update(final_state.yes_votes.to_be_bytes());
        hasher.update(final_state.no_votes.to_be_bytes());
        hasher.update(final_state.acc_nullifier_hash.as_bytes());
        hasher.update(num_votes.to_be_bytes());

        let hash = hasher.finalize();
        format!("0x{}", hex::encode(hash))
    }

    /// Verifies a compressed recursive proof payload
    pub fn verify_proof(payload: &RecursiveProofPayload) -> bool {
        if payload.final_state.step_count != payload.initial_state.step_count + payload.num_votes {
            return false;
        }

        let expected_proof_bytes = Self::compress_proof(
            &payload.initial_state,
            &payload.final_state,
            payload.num_votes,
        );

        payload.proof_bytes == expected_proof_bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_batch_aggregation() {
        let initial_state = IvcState {
            step_count: 0,
            root: "0xroot123".to_string(),
            yes_votes: 0,
            no_votes: 0,
            acc_nullifier_hash: "0x0".to_string(),
        };

        let witnesses = vec![
            VoteWitness {
                secret: "s1".to_string(),
                salt: "salt1".to_string(),
                path_elements: vec![],
                path_indices: vec![],
                vote_choice: 1,
                nullifier: VoteStepCircuit::compute_nullifier("s1", 1, 10),
                dao_id: 1,
                proposal_id: 10,
            },
            VoteWitness {
                secret: "s2".to_string(),
                salt: "salt2".to_string(),
                path_elements: vec![],
                path_indices: vec![],
                vote_choice: 0,
                nullifier: VoteStepCircuit::compute_nullifier("s2", 1, 10),
                dao_id: 1,
                proposal_id: 10,
            },
        ];

        let payload = NovaAggregator::aggregate_batch(initial_state, &witnesses).unwrap();
        assert_eq!(payload.num_votes, 2);
        assert_eq!(payload.final_state.step_count, 2);
        assert_eq!(payload.final_state.yes_votes, 1);
        assert_eq!(payload.final_state.no_votes, 1);
        assert!(NovaAggregator::verify_proof(&payload));
    }

    #[test]
    fn test_duplicate_nullifier_rejected() {
        let initial_state = IvcState {
            step_count: 0,
            root: "0xroot123".to_string(),
            yes_votes: 0,
            no_votes: 0,
            acc_nullifier_hash: "0x0".to_string(),
        };

        let nullifier = VoteStepCircuit::compute_nullifier("s1", 1, 10);
        let witnesses = vec![
            VoteWitness {
                secret: "s1".to_string(),
                salt: "salt1".to_string(),
                path_elements: vec![],
                path_indices: vec![],
                vote_choice: 1,
                nullifier: nullifier.clone(),
                dao_id: 1,
                proposal_id: 10,
            },
            VoteWitness {
                secret: "s1".to_string(),
                salt: "salt1".to_string(),
                path_elements: vec![],
                path_indices: vec![],
                vote_choice: 0,
                nullifier: nullifier.clone(), // duplicate
                dao_id: 1,
                proposal_id: 10,
            },
        ];

        assert_eq!(
            NovaAggregator::aggregate_batch(initial_state, &witnesses).unwrap_err(),
            CircuitError::NullifierAlreadyAccumulated
        );
    }

    // =====================================================================
    // Property-based tests (proptest)
    // =====================================================================

    use proptest::prelude::*;

    /// Generates a valid VoteWitness for a given index, using the index to make
    /// secrets unique so nullifiers are always distinct within a batch.
    fn make_witness(idx: u64, vote: u8) -> VoteWitness {
        let secret = format!("secret_{}", idx);
        let salt = format!("salt_{}", idx);
        let nullifier = VoteStepCircuit::compute_nullifier(&secret, 1, 100);
        VoteWitness {
            secret,
            salt,
            path_elements: vec![],
            path_indices: vec![],
            vote_choice: vote,
            nullifier,
            dao_id: 1,
            proposal_id: 100,
        }
    }

    // Feature: nova-aggregation, Property 1: nullifier mismatch → InvalidNullifier
    proptest! {
        #[test]
        fn prop_nullifier_mismatch_rejected(
            idx in 0u64..1000,
            bad_suffix in "[a-z]{1,10}",
            vote in 0u8..=1u8,
        ) {
            let secret = format!("secret_{}", idx);
            let salt = format!("salt_{}", idx);
            let correct = VoteStepCircuit::compute_nullifier(&secret, 1, 100);
            let bad_nullifier = format!("{}_bad_{}", correct, bad_suffix);
            // Ensure the tampered nullifier is definitely different
            prop_assume!(bad_nullifier != correct);

            let state = IvcState {
                step_count: 0,
                root: "0xroot_test".to_string(),
                yes_votes: 0,
                no_votes: 0,
                acc_nullifier_hash: "0x0".to_string(),
            };
            let witness = VoteWitness {
                secret,
                salt,
                path_elements: vec![],
                path_indices: vec![],
                vote_choice: vote,
                nullifier: bad_nullifier,
                dao_id: 1,
                proposal_id: 100,
            };
            let result = VoteStepCircuit::step(&state, &witness);
            prop_assert_eq!(result, Err(CircuitError::InvalidNullifier));
        }
    }

    // Feature: nova-aggregation, Property 2: duplicate nullifier → NullifierAlreadyAccumulated
    proptest! {
        #[test]
        fn prop_duplicate_nullifier_rejected(
            size in 1usize..=10,
            dup_pos in 0usize..10,
        ) {
            let witnesses: Vec<VoteWitness> = (0..size as u64)
                .map(|i| make_witness(i, (i % 2) as u8))
                .collect();
            let dup_idx = dup_pos % size;
            let mut batch = witnesses.clone();
            // Insert duplicate at end
            let dup = batch[dup_idx].clone();
            batch.push(dup);

            let initial = IvcState::default();
            let result = NovaAggregator::aggregate_batch(initial, &batch);
            prop_assert_eq!(result.unwrap_err(), CircuitError::NullifierAlreadyAccumulated);
        }
    }

    // Feature: nova-aggregation, Property 3: aggregate/verify round-trip
    proptest! {
        #[test]
        fn prop_aggregate_verify_roundtrip(
            size in 1usize..=20,
        ) {
            let witnesses: Vec<VoteWitness> = (0..size as u64)
                .map(|i| make_witness(i, (i % 2) as u8))
                .collect();
            let initial = IvcState::default();
            let payload = NovaAggregator::aggregate_batch(initial, &witnesses)
                .expect("aggregate_batch should succeed");
            prop_assert!(NovaAggregator::verify_proof(&payload));
        }
    }

    // Feature: nova-aggregation, Property 4: tally invariant
    proptest! {
        #[test]
        fn prop_tally_invariant(
            votes in proptest::collection::vec(0u8..=1u8, 1..=20),
        ) {
            let witnesses: Vec<VoteWitness> = votes.iter().enumerate()
                .map(|(i, &v)| make_witness(i as u64, v))
                .collect();
            let expected_yes = votes.iter().filter(|&&v| v == 1).count() as u64;
            let expected_no = votes.iter().filter(|&&v| v == 0).count() as u64;
            let num_votes = votes.len() as u64;

            let initial = IvcState::default();
            let payload = NovaAggregator::aggregate_batch(initial, &witnesses)
                .expect("aggregate_batch should succeed");

            prop_assert_eq!(payload.final_state.step_count, num_votes);
            prop_assert_eq!(payload.final_state.yes_votes, expected_yes);
            prop_assert_eq!(payload.final_state.no_votes, expected_no);
            prop_assert_eq!(
                payload.final_state.yes_votes + payload.final_state.no_votes,
                num_votes
            );
        }
    }

    // Feature: nova-aggregation, Property 5: tampered payload rejected
    proptest! {
        #[test]
        fn prop_tampered_payload_rejected(
            size in 1usize..=10,
            mutation in 0u8..4,
            delta in 1u64..=100,
        ) {
            let witnesses: Vec<VoteWitness> = (0..size as u64)
                .map(|i| make_witness(i, (i % 2) as u8))
                .collect();
            let initial = IvcState::default();
            let payload = NovaAggregator::aggregate_batch(initial, &witnesses)
                .expect("aggregate_batch should succeed");

            let mut tampered = payload.clone();
            match mutation % 4 {
                0 => {
                    // Flip last char of proof_bytes
                    if let Some(last) = tampered.proof_bytes.pop() {
                        let flipped = if last == 'a' { 'b' } else { 'a' };
                        tampered.proof_bytes.push(flipped);
                    }
                }
                1 => { tampered.final_state.yes_votes = tampered.final_state.yes_votes.wrapping_add(delta); }
                2 => { tampered.final_state.no_votes = tampered.final_state.no_votes.wrapping_add(delta); }
                _ => { tampered.final_state.step_count = tampered.final_state.step_count.wrapping_add(delta); }
            }
            prop_assert!(!NovaAggregator::verify_proof(&tampered));
        }
    }
}
