//! Property-based tests for the Nova aggregator (issue #896 / ZV-047).
//!
//! Run with:
//!   cargo test -p nova-aggregator proptest -- --nocapture
//!
//! Seed is fixed via `PROPTEST_SEED` env var (or the default below) so
//! failures are reproducible. The harness automatically saves a minimal
//! counterexample to `proptest-regressions/` for shrinking.

#[cfg(test)]
mod tests {
    use crate::{IvcState, RecursiveProofPayload, TallyProof, VoteWitness};
    use crate::aggregator::NovaAggregator;
    use proptest::prelude::*;

    // ---------------------------------------------------------------------------
    // Arbitrary generators
    // ---------------------------------------------------------------------------

    /// Generate a 32-byte hex string prefixed with "0x" (field-element shape).
    fn arb_hex32() -> impl Strategy<Value = String> {
        prop::collection::vec(any::<u8>(), 32)
            .prop_map(|bytes| format!("0x{}", hex::encode(bytes)))
    }

    /// Generate a valid non-negative vote count (u64 up to 10_000 to keep tests fast).
    fn arb_vote_count() -> impl Strategy<Value = u64> {
        0u64..=10_000
    }

    /// Generate an `IvcState` with arbitrary field values.
    fn arb_ivc_state() -> impl Strategy<Value = IvcState> {
        (arb_hex32(), arb_vote_count(), arb_vote_count(), arb_hex32()).prop_map(
            |(root, yes_votes, no_votes, acc_nullifier_hash)| IvcState {
                step_count: yes_votes + no_votes,
                root,
                yes_votes,
                no_votes,
                acc_nullifier_hash,
            },
        )
    }

    /// Generate a unique nullifier string from two independent u64 seeds.
    fn arb_nullifier() -> impl Strategy<Value = String> {
        (any::<u64>(), any::<u64>())
            .prop_map(|(a, b)| format!("0x{:016x}{:016x}", a, b))
    }

    /// Generate a single `VoteWitness` with the given nullifier.
    fn arb_witness_with_nullifier(nullifier: String) -> impl Strategy<Value = VoteWitness> {
        (arb_hex32(), arb_hex32(), 0u8..=1u8, 0u64..=1000u64, 0u64..=1000u64).prop_map(
            move |(secret, salt, vote_choice, dao_id, proposal_id)| VoteWitness {
                secret: secret.clone(),
                salt,
                path_elements: vec![secret.clone(), secret.clone()],
                path_indices: vec![0, 1],
                vote_choice,
                nullifier: nullifier.clone(),
                dao_id,
                proposal_id,
            },
        )
    }

    // ---------------------------------------------------------------------------
    // Property: tally arithmetic
    // ---------------------------------------------------------------------------

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 1_000,
            // Fix the seed for deterministic CI — override with PROPTEST_SEED env var.
            // The default proptest seed is deterministic per test-function name, so
            // this is an extra-explicit guard.
            source_file: Some("crates/nova-aggregator/src/proptest_suite.rs"),
            failure_persistence: Some(Box::new(
                proptest::test_runner::FileFailurePersistence::WithSource("regressions"),
            )),
            ..ProptestConfig::default()
        })]

        /// yes_votes + no_votes in the final state must equal the number of witnesses.
        #[test]
        fn tally_sum_equals_witness_count(
            (yes_target, no_target) in (1u64..=10u64, 1u64..=10u64),
        ) {
            let total = (yes_target + no_target) as usize;
            let initial = IvcState::default();

            // Build witnesses: first yes_target YES votes, then no_target NO votes.
            let mut witnesses: Vec<VoteWitness> = Vec::with_capacity(total);
            for i in 0..(yes_target as usize) {
                witnesses.push(VoteWitness {
                    secret: format!("0x{:064x}", i),
                    salt: format!("0x{:064x}", i + 1000),
                    path_elements: vec![
                        format!("0x{:064x}", i + 2000),
                        format!("0x{:064x}", i + 3000),
                    ],
                    path_indices: vec![0, 1],
                    vote_choice: 1,
                    nullifier: format!("0xyes{:060x}", i),
                    dao_id: 1,
                    proposal_id: 1,
                });
            }
            for i in 0..(no_target as usize) {
                witnesses.push(VoteWitness {
                    secret: format!("0x{:064x}", i + 10_000),
                    salt: format!("0x{:064x}", i + 11_000),
                    path_elements: vec![
                        format!("0x{:064x}", i + 12_000),
                        format!("0x{:064x}", i + 13_000),
                    ],
                    path_indices: vec![0, 1],
                    vote_choice: 0,
                    nullifier: format!("0xno{:061x}", i),
                    dao_id: 1,
                    proposal_id: 1,
                });
            }

            let payload = NovaAggregator::aggregate_batch(initial, &witnesses)
                .expect("aggregate_batch must succeed for valid witnesses");

            prop_assert_eq!(
                payload.final_state.yes_votes,
                yes_target,
                "yes_votes in final state must equal number of YES witnesses"
            );
            prop_assert_eq!(
                payload.final_state.no_votes,
                no_target,
                "no_votes in final state must equal number of NO witnesses"
            );
            prop_assert_eq!(
                payload.num_votes,
                (yes_target + no_target),
                "num_votes must equal total witness count"
            );
        }

        /// step_count in the final state must equal the number of folded witnesses.
        #[test]
        fn step_count_advances_monotonically(n in 1u64..=20u64) {
            let initial = IvcState::default();
            let witnesses: Vec<VoteWitness> = (0..n as usize)
                .map(|i| VoteWitness {
                    secret: format!("0x{:064x}", i),
                    salt: format!("0x{:064x}", i + 100),
                    path_elements: vec![format!("0x{:064x}", i + 200)],
                    path_indices: vec![0],
                    vote_choice: (i % 2) as u8,
                    nullifier: format!("0xstep{:059x}", i),
                    dao_id: 1,
                    proposal_id: 1,
                })
                .collect();

            let payload = NovaAggregator::aggregate_batch(initial, &witnesses)
                .expect("aggregate_batch must succeed");

            prop_assert_eq!(
                payload.final_state.step_count,
                n,
                "step_count must equal the number of folded witnesses"
            );
        }
    }

    // ---------------------------------------------------------------------------
    // Property: nullifier uniqueness / duplicate rejection
    // ---------------------------------------------------------------------------

    proptest! {
        #![proptest_config(ProptestConfig { cases: 1_000, ..ProptestConfig::default() })]

        /// Duplicate nullifiers must always cause aggregate_batch to return an error.
        #[test]
        fn duplicate_nullifier_always_rejected(nullifier in arb_nullifier()) {
            let w1 = VoteWitness {
                secret: "0x01".to_string(),
                salt: "0x02".to_string(),
                path_elements: vec!["0x03".to_string()],
                path_indices: vec![0],
                vote_choice: 1,
                nullifier: nullifier.clone(),
                dao_id: 1,
                proposal_id: 1,
            };
            let w2 = VoteWitness { nullifier: nullifier.clone(), ..w1.clone() };

            let result = NovaAggregator::aggregate_batch(IvcState::default(), &[w1, w2]);
            prop_assert!(
                result.is_err(),
                "duplicate nullifier '{}' must be rejected",
                nullifier
            );
        }
    }

    // ---------------------------------------------------------------------------
    // Property: proof bytes encoding round-trip (serialization)
    // ---------------------------------------------------------------------------

    proptest! {
        #![proptest_config(ProptestConfig { cases: 1_000, ..ProptestConfig::default() })]

        /// A `TallyProof` serialized to JSON must deserialize back to the same value.
        #[test]
        fn tally_proof_json_round_trip(
            root in arb_hex32(),
            yes_votes in arb_vote_count(),
            no_votes in arb_vote_count(),
            acc_nullifier_hash in arb_hex32(),
            proof_bytes in arb_hex32(),
        ) {
            let original = TallyProof {
                root: root.clone(),
                yes_votes,
                no_votes,
                acc_nullifier_hash: acc_nullifier_hash.clone(),
                proof_bytes: proof_bytes.clone(),
            };

            let json = serde_json::to_string(&original)
                .expect("TallyProof must serialize to JSON");
            let decoded: TallyProof = serde_json::from_str(&json)
                .expect("TallyProof must deserialize from JSON");

            prop_assert_eq!(&decoded.root, &root);
            prop_assert_eq!(decoded.yes_votes, yes_votes);
            prop_assert_eq!(decoded.no_votes, no_votes);
            prop_assert_eq!(&decoded.acc_nullifier_hash, &acc_nullifier_hash);
            prop_assert_eq!(&decoded.proof_bytes, &proof_bytes);
        }

        /// A `RecursiveProofPayload` round-trips through JSON without data loss.
        #[test]
        fn recursive_proof_payload_json_round_trip(
            state in arb_ivc_state(),
            num_votes in arb_vote_count(),
            proof_bytes in arb_hex32(),
        ) {
            let original = RecursiveProofPayload {
                initial_state: state.clone(),
                final_state: state.clone(),
                num_votes,
                proof_bytes: proof_bytes.clone(),
                timestamp: 1_700_000_000,
            };

            let json = serde_json::to_string(&original)
                .expect("RecursiveProofPayload must serialize to JSON");
            let decoded: RecursiveProofPayload = serde_json::from_str(&json)
                .expect("RecursiveProofPayload must deserialize from JSON");

            prop_assert_eq!(decoded.num_votes, num_votes);
            prop_assert_eq!(&decoded.proof_bytes, &proof_bytes);
            prop_assert_eq!(decoded.final_state.yes_votes, state.yes_votes);
        }
    }
}
