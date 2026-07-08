// Test: Removed member should NOT be able to vote on snapshot proposals
// Even if they are re-added after the proposal was created
//
// Timeline:
// 1. Member joins + registers
// 2. Member removed (leaf zeroed)
// 3. Snapshot proposal created (eligible_root = root with member removed)
// 4. Member re-added
// 5. Member attempts to vote using old credentials → MUST FAIL

use soroban_sdk::{testutils::Address as _, Address, Env, String, U256};
use voting::{Proof, VoteMode};

mod common;
use common::{generate_real_groth16_proof, setup_full_system, u256_from_hex};

#[test]
fn test_removed_member_cannot_vote_on_snapshot_proposal() {
    let env = Env::default();
    env.mock_all_auths();

    // Setup system
    let (registry_id, sbt_id, tree_id, voting_id) = setup_full_system(&env);
    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    // Create DAO
    let dao_id = 1u64;
    registry_id.create_dao(&admin);

    // Initialize tree
    tree_id.init_tree(&dao_id, &18); // depth 18

    // Set verification key
    let vk = common::load_verification_key(&env);
    voting_id.set_vk(&dao_id, &vk, &admin);

    // === STEP 1: Member joins and registers ===
    sbt_id.mint_from_registry(&dao_id, &member);

    let secret = "123456789";
    let salt = "987654321";
    let commitment = common::compute_poseidon_commitment(secret, salt);

    tree_id.register_with_caller(&dao_id, &commitment, &member);

    // Get initial root with member (Root A)
    let root_with_member = tree_id.current_root(&dao_id);
    println!("Root A (with member): {}", root_with_member);

    // === STEP 2: Remove member ===
    tree_id.remove_member(&dao_id, &member, &admin);

    let root_after_removal = tree_id.current_root(&dao_id);
    println!("Root B (member removed): {}", root_after_removal);

    // Verify root changed
    assert_ne!(root_with_member, root_after_removal, "Root should change after removal");

    // === STEP 3: Create snapshot proposal (eligible_root = Root B, member NOT included) ===
    let proposal_id = voting_id.create_proposal(
        &dao_id,
        &String::from_str(&env, "Test proposal"),
        &(env.ledger().timestamp() + 86400),
        &admin,
        &VoteMode::Fixed, // Snapshot voting
    );

    let proposal = voting_id.get_proposal(&dao_id, &proposal_id);
    assert_eq!(
        proposal.eligible_root, root_after_removal,
        "Proposal should snapshot the root AFTER removal"
    );

    // === STEP 4: Re-add member ===
    sbt_id.mint_from_registry(&dao_id, &member);

    // Member registers with NEW commitment (can't use old one - already in tree)
    let new_secret = "111222333";
    let new_salt = "444555666";
    let new_commitment = common::compute_poseidon_commitment(new_secret, new_salt);

    tree_id.register_with_caller(&dao_id, &new_commitment, &member);

    let root_after_rejoin = tree_id.current_root(&dao_id);
    println!("Root C (member re-added): {}", root_after_rejoin);

    // === STEP 5: Attempt to vote using OLD credentials ===
    // The member will try to generate a proof using their OLD commitment (from before removal)
    // The proof will be for Root B (the snapshot), but their commitment was ZEROED in Root B

    // Get leaf index for old commitment (still stored, but value is zero)
    let old_leaf_index = tree_id.get_leaf_index(&dao_id, &commitment);

    // Generate nullifier
    let nullifier = common::compute_nullifier(secret, &dao_id.to_string(), &proposal_id.to_string());

    // Get Merkle path from current tree (this will give path for Root C, not Root B!)
    let (path_elements, path_indices) = tree_id.get_merkle_path(&dao_id, &old_leaf_index);

    // Try to generate proof
    // This should FAIL because:
    // - Old commitment is at old_leaf_index
    // - But leaf was zeroed in Root B
    // - Path from current tree computes to Root C, not Root B
    // - Circuit will fail: computed_root != eligible_root

    let proof_result = generate_real_groth16_proof(
        secret,
        salt,
        &root_after_removal, // eligible_root (Root B - member removed)
        &nullifier,
        &dao_id.to_string(),
        &proposal_id.to_string(),
        true, // vote yes
        &path_elements,
        &path_indices,
    );

    // If proof generation succeeds (it might not - circuit may fail),
    // the contract MUST reject it
    if let Ok(proof) = proof_result {
        let vote_result = std::panic::catch_unwind(|| {
            voting_id.vote(
                &dao_id,
                &proposal_id,
                &true,
                &U256::from_be_bytes(&env, &nullifier_to_bytes(&nullifier)),
                &root_after_removal,
                &proof,
            );
        });

        assert!(
            vote_result.is_err(),
            "Vote MUST be rejected - member was not in snapshot root"
        );
    }

    // === ALTERNATIVE: Try with NEW credentials ===
    // Even with new credentials, member should NOT be able to vote on this snapshot proposal
    // because they weren't in the snapshot (Root B)

    let new_leaf_index = tree_id.get_leaf_index(&dao_id, &new_commitment);
    let new_nullifier = common::compute_nullifier(new_secret, &dao_id.to_string(), &proposal_id.to_string());
    let (new_path_elements, new_path_indices) = tree_id.get_merkle_path(&dao_id, &new_leaf_index);

    let new_proof_result = generate_real_groth16_proof(
        new_secret,
        new_salt,
        &root_after_removal, // eligible_root (Root B - member was NOT in this root)
        &new_nullifier,
        &dao_id.to_string(),
        &proposal_id.to_string(),
        true,
        &new_path_elements,
        &new_path_indices,
    );

    if let Ok(proof) = new_proof_result {
        let vote_result = std::panic::catch_unwind(|| {
            voting_id.vote(
                &dao_id,
                &proposal_id,
                &true,
                &U256::from_be_bytes(&env, &nullifier_to_bytes(&new_nullifier)),
                &root_after_removal,
                &proof,
            );
        });

        assert!(
            vote_result.is_err(),
            "Vote MUST be rejected - member was added AFTER snapshot"
        );
    }
}

#[test]
fn test_removed_member_CAN_vote_on_trailing_proposal() {
    // For trailing mode, members added after proposal creation CAN vote
    // This is the intended behavior
    let env = Env::default();
    env.mock_all_auths();

    let (registry_id, sbt_id, tree_id, voting_id) = setup_full_system(&env);
    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    let dao_id = 1u64;
    registry_id.create_dao(&admin);
    tree_id.init_tree(&dao_id, &18);

    let vk = common::load_verification_key(&env);
    voting_id.set_vk(&dao_id, &vk, &admin);

    // Member joins, gets removed, proposal created, member re-added
    sbt_id.mint_from_registry(&dao_id, &member);
    let secret = "123456789";
    let salt = "987654321";
    let commitment = common::compute_poseidon_commitment(secret, salt);
    tree_id.register_with_caller(&dao_id, &commitment, &member);

    tree_id.remove_member(&dao_id, &member, &admin);

    // Create TRAILING proposal
    let proposal_id = voting_id.create_proposal(
        &dao_id,
        &String::from_str(&env, "Trailing proposal"),
        &(env.ledger().timestamp() + 86400),
        &admin,
        &VoteMode::Trailing, // Dynamic voting
    );

    // Re-add member
    sbt_id.mint_from_registry(&dao_id, &member);
    let new_secret = "111222333";
    let new_salt = "444555666";
    let new_commitment = common::compute_poseidon_commitment(new_secret, new_salt);
    tree_id.register_with_caller(&dao_id, &new_commitment, &member);

    let current_root = tree_id.current_root(&dao_id);

    // Member CAN vote using current root (trailing mode allows this)
    let new_leaf_index = tree_id.get_leaf_index(&dao_id, &new_commitment);
    let new_nullifier = common::compute_nullifier(new_secret, &dao_id.to_string(), &proposal_id.to_string());
    let (path_elements, path_indices) = tree_id.get_merkle_path(&dao_id, &new_leaf_index);

    let proof = generate_real_groth16_proof(
        new_secret,
        new_salt,
        &current_root, // Use current root, not snapshot
        &new_nullifier,
        &dao_id.to_string(),
        &proposal_id.to_string(),
        true,
        &path_elements,
        &path_indices,
    )
    .expect("Proof generation should succeed");

    // Vote should succeed in trailing mode
    voting_id.vote(
        &dao_id,
        &proposal_id,
        &true,
        &U256::from_be_bytes(&env, &nullifier_to_bytes(&new_nullifier)),
        &current_root,
        &proof,
    );

    let proposal = voting_id.get_proposal(&dao_id, &proposal_id);
    assert_eq!(proposal.yes_votes, 1);
}

fn nullifier_to_bytes(nullifier: &str) -> [u8; 32] {
    let n = BigInt::parse_bytes(nullifier.as_bytes(), 10).unwrap();
    let bytes = n.to_bytes_be().1;
    let mut result = [0u8; 32];
    let start = 32 - bytes.len();
    result[start..].copy_from_slice(&bytes);
    result
}
