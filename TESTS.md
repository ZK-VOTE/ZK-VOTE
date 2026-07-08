# ZKVote Test Inventory

**Total: 391 tests + 6 stress tests** (all passing)

## Summary

| Suite | Tests | Command |
|-------|-------|---------|
| **Rust Contracts** | 127 | `cargo test` (excludes integration) |
| **Rust Integration** | 76 | `cargo test -p zkvote-integration-tests` |
| **Backend** | 45 | `cd backend && npm test` |
| **Frontend** | 121 | `cd frontend && npm test` |
| **Circuits** | 22 | `cd circuits && npm test` |

### Rust Contract Tests Breakdown

| Package | Tests |
|---------|-------|
| dao-registry | 15 |
| membership-sbt | 18 |
| membership-tree | 17 |
| voting | 52 |
| comments | 18 |
| zkvote-groth16 | 7 |
| **Subtotal** | **127** |

## Run Commands

```bash
# All Rust tests
cargo test --workspace

# Specific package
cargo test -p voting

# Backend tests
cd backend && npm test

# Frontend tests
cd frontend && npm test

# Circuit tests
cd circuits && npm test

# Run all suites
cargo test --workspace && cd backend && npm test && cd ../frontend && npm test && cd ../circuits && npm test
```

## Rust Contract Tests (127)

### dao-registry (15 tests)
- test_create_dao
- test_create_dao_max_name_length_succeeds
- test_create_dao_name_extremely_long_fails
- test_create_dao_name_too_long_fails
- test_create_dao_requires_admin_auth
- test_create_multiple_daos
- test_dao_count_consistency
- test_dao_exists
- test_get_nonexistent_dao_fails
- test_members_can_propose_field
- test_membership_open_field
- test_set_proposal_mode
- test_set_proposal_mode_non_admin_fails
- test_transfer_admin
- test_transfer_admin_requires_current_admin_auth

### membership-sbt (18 tests)
- test_constructor
- test_different_daos_isolated
- test_events_emitted_on_mint
- test_events_emitted_on_mint_from_registry
- test_has_on_nonexistent_dao_returns_false
- test_has_returns_false_for_non_member
- test_mint
- test_mint_from_registry
- test_mint_from_registry_multiple_members
- test_mint_from_registry_twice_fails
- test_mint_multiple_members_same_dao
- test_mint_to_nonexistent_dao_fails
- test_mint_twice_fails
- test_same_member_different_daos
- test_self_join_closed_dao_fails
- test_self_join_open_dao
- test_self_join_twice_fails
- test_wrong_admin_cannot_mint

### membership-tree (17 tests)
- test_admin_can_reinstate_member
- test_admin_can_revoke_member
- test_constructor
- test_different_daos_isolated
- test_duplicate_commitment_rejected
- test_get_commitment_returns_zero_for_unregistered
- test_get_depth
- test_get_leaf
- test_get_root
- test_init_tree_succeeds
- test_member_address_consistency
- test_only_admin_can_reinstate_member
- test_only_admin_can_remove_member
- test_register_commitment_basic
- test_register_commitment_events
- test_register_commitment_non_member_fails
- test_root_history_tracks_changes

### voting (52 tests)
- test_archive_without_close_fails
- test_bn254_modulus_constant_validation
- test_close_after_archive_fails
- test_close_proposal_emits_event_once
- test_close_proposal_non_admin_fails
- test_constructor
- test_create_proposal
- test_create_proposal_content_cid_too_long_fails
- test_create_proposal_max_title_length_succeeds
- test_create_proposal_title_too_long_fails
- test_create_proposal_with_future_vk_version_rejected
- test_create_proposal_with_past_end_time_fails
- test_create_proposal_with_specific_vk_version
- test_create_proposal_without_sbt_fails
- test_different_daos_isolated
- test_double_vote_fails
- test_g1_negation_correctness
- test_get_results
- test_multiple_proposals
- test_multiple_unique_nullifiers_succeed
- test_nullifier_duplicate_panics_in_stream
- test_nullifier_reusable_across_proposals
- test_nullifier_zero_rejected
- test_randomized_mixed_actions_preserve_invariants
- test_randomized_nullifier_sequence_no_duplicates
- test_reopen_not_allowed
- test_set_vk_empty_ic_fails
- test_set_vk_ic_length_5_fails
- test_set_vk_ic_length_7_fails
- test_set_vk_ic_too_large_fails
- test_set_vk_non_admin_fails
- test_tampered_vk_hash_rejected
- test_vk_change_after_proposal_creation_resists_vk_change
- test_vk_for_version_exposes_stored_key
- test_vk_version_mismatch_rejected
- test_vote_after_archive_fails
- test_vote_after_close_fails
- test_vote_after_expiry_fails
- test_vote_rejects_nullifier_above_modulus
- test_vote_rejects_nullifier_at_modulus
- test_vote_rejects_root_at_modulus
- test_vote_rejects_zero_nullifier
- test_vote_success
- test_vote_with_all_zero_proof_fails
- test_vote_with_commitment_from_other_dao_fails
- test_vote_with_invalid_root_fails
- test_vote_with_malformed_proof_fails
- test_vote_with_mismatched_vk_hash_in_proposal_fails
- test_vote_with_off_curve_proof_fails
- test_vote_with_swapped_dao_proposal_ids_fails
- test_vote_with_swapped_pub_signals_fails
- test_vote_with_vk_ic_length_mismatch_fails

### comments (18 tests)
- test_add_comment_basic
- test_add_reply_to_comment
- test_cannot_add_comment_without_membership
- test_constructor
- test_delete_comment
- test_delete_reply_preserves_parent
- test_different_daos_isolated
- test_get_comment
- test_get_comments_pagination
- test_list_comments_returns_multiple
- test_moderator_can_delete_any_comment
- test_non_moderator_cannot_delete_others_comment
- test_owner_nullifier_can_delete_own_comment
- test_reply_to_deleted_comment_fails
- test_reply_to_nonexistent_comment_fails
- test_signal_field_validation
- test_vote_with_invalid_root_fails
- test_vote_with_revoked_commitment_fails

### zkvote-groth16 (7 tests)
- test_field_modulus_constant
- test_from_be_bytes
- test_g1_add
- test_g1_mul
- test_g2_from_bytes
- test_ic_sum_computation
- test_to_be_bytes

## Rust Integration Tests (76)

Run with: `cargo test -p zkvote-integration-tests`

Categories:
- Member revocation flows (10+ tests)
- Root history behavior (5+ tests)
- Tree capacity & depth (5+ tests)
- Cross-DAO isolation (5+ tests)
- Budget/resource limit tests (5+ tests)
- Trailing mode tests (5+ tests)

## Stress Tests (6 tests, ignored by default)

Run with: `cargo test --test stress -- --ignored --nocapture`

- stress_many_members_and_proposals
- stress_many_daos
- stress_merkle_tree_registrations
- stress_many_proposals_per_dao
- stress_member_aliases
- stress_mixed_operations

## Backend Tests (45)

Run with: `cd backend && npm test`

Categories:
- Vote endpoint validation (15+ tests)
- Auth token validation (5+ tests)
- Rate limiting (5+ tests)
- IPFS endpoints (5+ tests)
- RPC failure handling (5+ tests)
- Generic error mode (5+ tests)

## Frontend Tests (121)

Run with: `cd frontend && npm test`

Test files:
- `src/components/ManageMembers.test.tsx`
- `src/components/ProposalCard.test.tsx`
- `src/lib/utils.test.ts`
- `src/lib/merkletree.test.ts`
- `src/lib/encryption.test.ts`
- `src/lib/zkproof.test.ts`

## Circuit Tests (22)

Run with: `cd circuits && npm test`

File: `circuits/conversion-utils.test.js`

Categories:
- Big-endian hex conversion
- G1/G2 point encoding
- Proof format conversion
- VK structure conversion
- Edge cases (zero values, field max)
